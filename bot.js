const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const mongoose = require('mongoose');

/* Render keepalive */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kalypo Mods bot is running.');
}).listen(PORT, () => console.log(`🌐 Health check listener on port ${PORT}`));

/* ═══════════════════════════════════
   CONFIG
═══════════════════════════════════ */
const BOT_TOKEN   = process.env.BOT_TOKEN  || '8645097113:AAGsgGoZVikyo3Dax49J42vpDw4Xk9JUM18';
const SERVER_URL  = process.env.SERVER_URL || 'https://kalypo-mods.onrender.com';
const ADMIN_KEY   = process.env.ADMIN_KEY  || '990';
const ADMIN_IDS   = (process.env.ADMIN_TELEGRAM_IDS || '7564594071').split(',').map(s => s.trim()).filter(Boolean);
const PRICE_COINS      = process.env.PRICE_COINS || '500';
const COINS_PER_PACK   = parseInt(process.env.COINS_PER_PACK) || 500;
const STARS_PRICE      = parseInt(process.env.STARS_PRICE)    || 100;  // Telegram Stars to charge

// Coin packages — users buy coins with Stars (bulk = bonus coins)
const COIN_PACKAGES = [
  { id: 'c1', stars: 100, coins: 500,  bonus: 0,   label: 'Starter', badge: '🥉' },
  { id: 'c2', stars: 180, coins: 1100, bonus: 100, label: 'Double',  badge: '🥈' },
  { id: 'c3', stars: 250, coins: 1800, bonus: 300, label: 'Triple',  badge: '🥇' },
  { id: 'c5', stars: 380, coins: 3200, bonus: 700, label: 'Mega',    badge: '💎' },
];
const MONGO_URI   = process.env.MONGODB_URI || 'mongodb+srv://rm1402678_db_user:52q7DBT4rJAE786p@cluster0.t0auzso.mongodb.net/kalypo?appName=Cluster0';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-1003787424518';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Cache bot username to avoid repeated getMe() calls
let _botUsername = null;
async function getBotUsername() {
  if (!_botUsername) {
    const info = await bot.getMe();
    _botUsername = info.username;
  }
  return _botUsername;
}

/* Global ban gate — runs before every message/command */
bot.on('message', async (msg) => {
  if (!msg.from || msg.chat.type !== 'private') return;
  const banned = await isBanned(msg.from.id);
  if (banned) {
    bot.sendMessage(msg.chat.id, '🚫 You are banned from using this bot.').catch(() => {});
    throw new Error('BANNED'); // stops further listeners for this update
  }
});
// Increase listener limit for stability
process.setMaxListeners(0);
bot._events && Object.keys(bot._events).forEach(event => {
  if (bot.listeners(event).length > 10) {
    bot.setMaxListeners(50);
  }
});

/* ═══════════════════════════════════
   MONGODB MODELS
═══════════════════════════════════ */
const BotUserSchema = new mongoose.Schema({ chatId: { type: String, unique: true } });
const BotUser = mongoose.model('BotUser', BotUserSchema);

const WarnSchema = new mongoose.Schema({ userId: { type: String, unique: true }, count: { type: Number, default: 0 } });
const Warn = mongoose.model('Warn', WarnSchema);

const ScheduleSchema = new mongoose.Schema({
  id:      { type: String, unique: true },
  hour:    Number,
  minute:  Number,
  message: String
});
const Schedule = mongoose.model('Schedule', ScheduleSchema);

const BotWalletSchema = new mongoose.Schema({
  userId:      { type: String, unique: true },
  username:    { type: String, default: '' },
  displayName: { type: String, default: '' },
  balance:     { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },  // lifetime coins received
  claims:      { type: Number, default: 0 },  // successful claims
  referredBy:  { type: String, default: '' }, // userId who referred them
  referrals:   { type: Number, default: 0 },  // how many users they referred
  joinedAt:    { type: Date,   default: Date.now }, // when they first used the bot
  hasPaid:     { type: Boolean, default: false }    // set true after first Stars payment
}, { timestamps: true });

const MAX_REFERRALS_PER_USER = parseInt(process.env.MAX_REFERRALS) || 20; // cap per referrer
const MIN_ACCOUNT_AGE_DAYS   = parseInt(process.env.MIN_REF_DAYS)  || 0;  // new account filter (Telegram ID age — 0 = off)
const BotWallet = mongoose.model('BotWallet', BotWalletSchema);

const BannedSchema = new mongoose.Schema({ userId: { type: String, unique: true } });
const Banned = mongoose.model('Banned', BannedSchema);

const CommandLogSchema = new mongoose.Schema({
  userId: String,
  username: String,
  command: String,
  params: mongoose.Schema.Types.Mixed,
  timestamp: { type: Date, default: Date.now }
});
const CommandLog = mongoose.model('CommandLog', CommandLogSchema);

/* Activity log — every user action in one place */
const ActivityLogSchema = new mongoose.Schema({
  userId:   String,
  username: String,
  name:     String,
  action:   String,          // e.g. '/start', 'claim_success', 'buyref_fail'
  detail:   String,          // human-readable detail
  result:   { type: String, enum: ['ok', 'fail', 'info'], default: 'info' },
  timestamp:{ type: Date, default: Date.now }
});
const ActivityLog = mongoose.model('ActivityLog', ActivityLogSchema);

/* Fire-and-forget logger */
function log(msg, action, detail, result = 'info') {
  const from = msg.from || {};
  const username = from.username ? '@' + from.username : (from.first_name || 'Unknown');
  ActivityLog.create({
    userId:   String(from.id || '?'),
    username,
    name:     from.first_name || '',
    action,
    detail:   detail || '',
    result
  }).catch(() => {});
}

/* Reserved-ref tracking: userId → ref they paid for via /buyref */
const PendingRefSchema = new mongoose.Schema({
  userId:    { type: String, unique: true },
  ref:       String,
  notified:  { type: Boolean, default: false }, // warned at 20h mark
  createdAt: { type: Date, default: Date.now, expires: 86400 } // auto-expire after 24h
});
const PendingRef = mongoose.model('PendingRef', PendingRefSchema);

/* Persistent sessions - survive bot restarts */
const SessionSchema = new mongoose.Schema({
  chatId:    { type: String, unique: true },
  step:      String,
  data:      mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now, expires: 3600 }
});
const SessionStore = mongoose.model('SessionStore', SessionSchema);


async function isBanned(userId) {
  return Banned.findOne({ userId: String(userId) }).catch(() => null);
}

async function banUser(userId) {
  return Banned.create({ userId: String(userId) }).catch(() => null);
}

async function unbanUser(userId) {
  return Banned.deleteOne({ userId: String(userId) }).catch(() => null);
}

const CPM2_KEY   = 'AIzaSyCQDz9rgjgmvmFkvVfmvr2-7fT4tfrzRRQ';
const CPM2_LOGIN_URL = `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${CPM2_KEY}`;
async function cpm2Login(email, password) {
  const r = await fetch(CPM2_LOGIN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const d = await r.json();
  return d.idToken ? { ok: true } : { ok: false, msg: d.error?.message || 'Login failed' };
}

/* ═══════════════════════════════════
   STATE
═══════════════════════════════════ */
const sessions  = {};
const listState = {};
const PAGE_SIZE = 10;
const knownUsers = new Set();
const schedules  = {};
let broadcastLock = false; // prevent double broadcast

/* Auto-react pool */
const REACT_EMOJIS = ['🔥','👍','❤️','🎮','💯','⚡','🚀','😎','🏆','💎'];
let reactIdx = 0;
function nextEmoji() {
  return REACT_EMOJIS[(reactIdx++) % REACT_EMOJIS.length];
}

/* ═══════════════════════════════════
   HELPERS
═══════════════════════════════════ */
function isAdmin(msg) {
  return ADMIN_IDS.includes(String(msg.from.id));
}
async function resetSession(chatId) {
  delete sessions[chatId];
  await SessionStore.deleteOne({ chatId: String(chatId) }).catch(() => {});
}

async function saveSession(chatId, session) {
  sessions[chatId] = session;
  await SessionStore.findOneAndUpdate(
    { chatId: String(chatId) },
    { chatId: String(chatId), step: session.step, data: session.data, updatedAt: new Date() },
    { upsert: true }
  ).catch(() => {});
}

function statusEmoji(s) {
  return { AVAILABLE: '🟢', TAKEN: '🔴', RESERVED: '🟡', INVALID: '⛔' }[s] || '⚪';
}

async function saveUser(chatId) {
  knownUsers.add(chatId);
  try {
    await BotUser.updateOne({ chatId: String(chatId) }, { chatId: String(chatId) }, { upsert: true });
  } catch(e) {
    console.error('Error saving user:', e.message);
  }
}

async function getUserWallet(userId, from = null) {
  try {
    let w = await BotWallet.findOne({ userId: String(userId) });
    if (!w) {
      const data = { userId: String(userId), balance: 0 };
      if (from) {
        data.username    = from.username ? '@' + from.username : '';
        data.displayName = from.first_name || '';
      }
      w = await BotWallet.create(data);
    } else if (from) {
      // Refresh name in case it changed
      w = await BotWallet.findOneAndUpdate(
        { userId: String(userId) },
        { $set: {
            username:    from.username ? '@' + from.username : '',
            displayName: from.first_name || ''
          }
        },
        { new: true }
      );
    }
    return w;
  } catch(e) {
    console.error('Error getting wallet:', e.message);
    return null;
  }
}

async function addCoins(userId, amount, from = null) {
  try {
    const inc = { balance: amount };
    if (amount > 0) inc.totalEarned = amount;
    const update = { $inc: inc };
    if (from) {
      update.$set = {
        username:    from.username ? '@' + from.username : '',
        displayName: from.first_name || ''
      };
    }
    return await BotWallet.findOneAndUpdate(
      { userId: String(userId) },
      update,
      { upsert: true, new: true }
    );
  } catch(e) {
    console.error('Error adding coins:', e.message);
    return null;
  }
}

async function removeCoins(userId, amount) {
  try {
    const w = await BotWallet.findOne({ userId: String(userId) });
    if (!w || w.balance < amount) return null;
    return await BotWallet.findOneAndUpdate(
      { userId: String(userId) },
      { $inc: { balance: -amount } },
      { new: true }
    );
  } catch(e) {
    console.error('Error removing coins:', e.message);
    return null;
  }
}

function buildListPage(accounts, page) {
  const total = accounts.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const slice = accounts.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  let text = `📋 *Account List* — Page ${page + 1}/${totalPages} _(${total} total)_\n`;
  text += `━━━━━━━━━━━━━━━━━━━\n`;
  slice.forEach((a, i) => {
    const num = page * PAGE_SIZE + i + 1;
    const email = a.claimedEmail ? `  📧 \`${a.claimedEmail}\`` : '';
    text += `${statusEmoji(a.status)} *${num}.* \`${a.ref}\`${email}\n`;
  });
  text += `━━━━━━━━━━━━━━━━━━━`;

  const buttons = [];
  if (page > 0)              buttons.push({ text: '⬅️ Prev', callback_data: 'list_prev' });
  if (page + 1 < totalPages) buttons.push({ text: 'Next ➡️', callback_data: 'list_next' });

  return { text, buttons, totalPages };
}

/* ═══════════════════════════════════
   SERVER API
═══════════════════════════════════ */
async function apiCheck(ref) {
  try {
    const r = await fetch(`${SERVER_URL}/api/check/${encodeURIComponent(ref)}`);
    if (!r.ok) return { ok: false, msg: `Server returned ${r.status}` };
    return r.json();
  } catch(e) {
    return { ok: false, msg: '🔌 Server is offline or starting up. Try again in 30s.' };
  }
}
async function apiClaim(ref, newEmail, newPassword) {
  try {
    const r = await fetch(`${SERVER_URL}/api/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, newEmail, newPassword })
    });
    if (!r.ok) return { ok: false, msg: `Server returned ${r.status}` };
    return r.json();
  } catch(e) {
    return { ok: false, msg: '🔌 Server is offline or starting up. Try again in 30s.' };
  }
}
async function apiAdminAccounts() {
  try {
    const r = await fetch(`${SERVER_URL}/api/admin/accounts`, { headers: { 'x-admin-key': ADMIN_KEY } });
    if (!r.ok) throw new Error(`Status ${r.status}`);
    return r.json();
  } catch(e) {
    throw new Error('🔌 Server offline: ' + e.message);
  }
}
async function apiAdminStats() {
  try {
    const r = await fetch(`${SERVER_URL}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } });
    if (!r.ok) throw new Error(`Status ${r.status}`);
    return r.json();
  } catch(e) {
    throw new Error('🔌 Server offline: ' + e.message);
  }
}
async function apiAdminReset(ref) {
  try {
    const r = await fetch(`${SERVER_URL}/api/admin/reset/${encodeURIComponent(ref)}`, {
      method: 'POST', headers: { 'x-admin-key': ADMIN_KEY }
    });
    if (!r.ok) return { ok: false, msg: `Server returned ${r.status}` };
    return r.json();
  } catch(e) {
    return { ok: false, msg: '🔌 Server offline: ' + e.message };
  }
}

/* ═══════════════════════════════════
   SCHEDULER
═══════════════════════════════════ */
function msUntilNext(hour, minute) {
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function startSchedule(id, hour, minute, message) {
  function fire() {
    bot.sendMessage(GROUP_CHAT_ID,
`📢 *Kalypo Mods Announcement*
━━━━━━━━━━━━━━━━━━━
${message}
━━━━━━━━━━━━━━━━━━━
🎮 _Kalypo Mods — CPM2 Store_`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    schedules[id].timer = setTimeout(fire, msUntilNext(hour, minute));
  }
  if (schedules[id]) clearTimeout(schedules[id].timer);
  schedules[id] = { hour, minute, message, timer: setTimeout(fire, msUntilNext(hour, minute)) };
}

async function loadSchedules() {
  const all = await Schedule.find().catch(() => []);
  all.forEach(s => startSchedule(s.id, s.hour, s.minute, s.message));
  if (all.length) console.log(`📅 Loaded ${all.length} schedule(s) from DB`);
}

/* Ban check happens in individual commands */

/* ═══════════════════════════════════
   CUSTOMER COMMANDS
═══════════════════════════════════ */
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const refParam = match && match[1] ? match[1].trim() : null;
  
  // Check if banned
  if (msg.chat.type === 'private') {
    const banned = await isBanned(msg.from.id);
    if (banned) {
      bot.sendMessage(chatId, '🚫 You have been banned from using this bot.');
      return;
    }
    saveUser(msg.from.id);
    const newUserId = String(msg.from.id);

    // Check if truly new BEFORE any upsert
    const isNewUser = !(await BotWallet.findOne({ userId: newUserId }).lean().catch(() => null));

    // Save name so leaderboard shows real names
    await BotWallet.findOneAndUpdate(
      { userId: newUserId },
      { $set: {
          username:    msg.from.username ? '@' + msg.from.username : '',
          displayName: msg.from.first_name || ''
        }
      },
      { upsert: true }
    ).catch(() => {});

    // ── Referral: anti-farm checks ───────────────────────────────────────
    const REFERRAL_REWARD = parseInt(process.env.REFERRAL_COINS) || 5;
    if (refParam && isNewUser && refParam !== newUserId) {
      try {
        const referrer = await BotWallet.findOne({ userId: String(refParam) }).lean();
        if (referrer) {

          // ANTI-FARM 1: cap total referrals per user
          if ((referrer.referrals || 0) >= MAX_REFERRALS_PER_USER) {
            log(msg, 'referral_blocked', 'referrer='+refParam+' reason=max_referrals', 'fail');
            console.log('Referral blocked: '+refParam+' hit MAX_REFERRALS_PER_USER');
            // Still register the new user, just don't reward
          } else {
            // ANTI-FARM 2: new user must not be a bot (from field check)
            if (msg.from.is_bot) {
              log(msg, 'referral_blocked', 'newUser='+newUserId+' reason=is_bot', 'fail');
            } else {
              // ANTI-FARM 3: referrer can't refer someone who already has a wallet
              // (already handled by isNewUser, but double-check referredBy isn't set)
              const newUserDoc = await BotWallet.findOne({ userId: newUserId }).lean();
              if (!newUserDoc || !newUserDoc.referredBy) {
                // Mark new user as referred
                await BotWallet.findOneAndUpdate(
                  { userId: newUserId },
                  { $set: { referredBy: String(refParam), joinedAt: new Date() } }
                ).catch(() => {});

                // Credit referrer
                await BotWallet.findOneAndUpdate(
                  { userId: String(refParam) },
                  { $inc: { balance: REFERRAL_REWARD, totalEarned: REFERRAL_REWARD, referrals: 1 } }
                );

                log(msg, 'referral', 'referrer='+refParam+' newUser='+newUserId+' reward='+REFERRAL_REWARD, 'ok');

                const newName = msg.from.first_name || (msg.from.username ? '@'+msg.from.username : 'Someone');
                bot.sendMessage(refParam,
`╔══════════════════╗
  🎉  *REFERRAL BONUS!*
╚══════════════════╝

👤 *${newName}* just joined using your link!
💰 You earned *${REFERRAL_REWARD}* coins!
👥 Total referrals: *${(referrer.referrals || 0) + 1}* / ${MAX_REFERRALS_PER_USER}

💳 Use /wallet to check your balance.`,
                  { parse_mode: 'Markdown' }).catch(() => {});
              }
            }
          }
        } else {
          console.log('Referral: referrer not found for userId=' + refParam);
        }
      } catch(e) {
        console.error('Referral error:', e.message);
      }
    }
  }
  log(msg, '/start', '', 'info');
  resetSession(chatId);
  bot.sendMessage(chatId,
`╔═══════════════════╗
   🎮  *KALYPO MODS*  🎮
╚═══════════════════╝

*CPM2 Premium Account Store*

┌─────────────────────┐
│  💎  *WHAT YOU GET*  💎  │
├─────────────────────┤
│ 🪙  300 Coins            │
│ 🚗  10–20 Cars           │
│ 👑  King Rank             │
│ 🔓  All Cars Unlocked  │
│ 🎨  All Paintings         │
│ 💡  All Headlights        │
│ 👕  Full Clothes Set      │
│ 🎬  All Animations        │
└─────────────────────┘

💰 Price: *${PRICE_COINS} Coins* per account`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Payment Info', callback_data: 'menu_pay' },   { text: '🪙 My Wallet',  callback_data: 'menu_wallet' }],
          [{ text: '🎮 Claim Account', callback_data: 'menu_claim' }, { text: '🔑 Buy Ref',    callback_data: 'menu_buyref' }],
          [{ text: '🏆 Leaderboard',  callback_data: 'menu_top' },   { text: '🏅 My Rank',    callback_data: 'menu_rank'   }],
          [{ text: '📟 Full Menu',    callback_data: 'menu_full' }]
        ]
      }
    }
  );
});

bot.onText(/^\/help$/, (msg) => bot.emit('text', { ...msg, text: '/start' }));

bot.onText(/^\/pay$/, async (msg) => {
  const chatId = msg.chat.id;
  log(msg, '/pay', '', 'info');
  await showCoinShop(chatId);
});

async function showCoinShop(chatId) {
  let text = `╔═══════════════════════╗\n  🪙  *BUY COINS*\n╚═══════════════════════╝\n\n`;
  text += `Use coins to buy ref codes via /buyref.\n`;
  text += `1 ref = *${PRICE_COINS} coins*\n\n`;
  text += `*⭐ Stars Packages:*\n\n`;

  const keyboard = [];
  for (const pkg of COIN_PACKAGES) {
    const perStar = (pkg.coins / pkg.stars).toFixed(1);
    text += `${pkg.badge} *${pkg.label}*\n`;
    text += `   ⭐ ${pkg.stars} Stars → 🪙 *${pkg.coins} coins*`;
    if (pkg.bonus > 0) text += ` _(+${pkg.bonus} bonus!)_`;
    text += `\n   📊 ${perStar} coins/star\n\n`;
    keyboard.push([{ text: `${pkg.badge} ${pkg.label} — ⭐${pkg.stars} → 🪙${pkg.coins}${pkg.bonus > 0 ? ' (+'+pkg.bonus+' bonus)' : ''}`, callback_data: 'buy_coins_' + pkg.id }]);
  }
  keyboard.push([{ text: '📸 Manual Payment', callback_data: 'pay_manual' }]);

  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}


/* ═══════════════════════════════════
   TELEGRAM STARS PAYMENT FLOW
═══════════════════════════════════ */
async function sendCoinInvoice(chatId, from, pkgId) {
  const pkg = COIN_PACKAGES.find(p => p.id === pkgId);
  if (!pkg) return bot.sendMessage(chatId, '❌ Invalid package.');

  const payload = JSON.stringify({ userId: String(from.id), pkgId, coins: pkg.coins });
  try {
    await bot.sendInvoice(
      chatId,
      'Kalypo Mods — ' + pkg.label + ' Coin Pack',
      'Get ' + pkg.coins + ' coins instantly!' + (pkg.bonus > 0 ? ' Includes ' + pkg.bonus + ' bonus coins!' : '') + ' Use /buyref after payment.',
      payload,
      '',
      'XTR',
      [{ label: pkg.coins + ' Coins', amount: pkg.stars }]
    );
  } catch(e) {
    console.error('sendInvoice error:', e.message);
    bot.sendMessage(chatId,
`❌ *Payment unavailable right now.*

Please use manual payment instead:
📸 Send proof to admin → they credit your coins.

_Error: ${e.message}_`,
      { parse_mode: 'Markdown' });
  }
}

// Telegram calls this before charging — we must approve within 10 seconds
bot.on('pre_checkout_query', async (query) => {
  try {
    await bot.answerPreCheckoutQuery(query.id, true);
  } catch(e) {
    await bot.answerPreCheckoutQuery(query.id, false, 'Try again or contact admin.').catch(() => {});
  }
});

// Payment confirmed by Telegram — credit coins
bot.on('message', async (msg) => {
  if (!msg.successful_payment) return;
  const chatId  = msg.chat.id;
  const payment = msg.successful_payment;

  let payload;
  try { payload = JSON.parse(payment.invoice_payload); } catch(e) { return; }

  const userId = payload.userId;
  const coins  = payload.coins || COINS_PER_PACK;
  const stars  = payment.total_amount; // number of Stars paid

  try {
    // Look up package for bonus display
    const pkgId      = payload.pkgId;
    const pkg        = pkgId ? COIN_PACKAGES.find(p => p.id === pkgId) : null;
    const totalCoins = pkg ? pkg.coins : (payload.coins || COINS_PER_PACK);

    const w = await BotWallet.findOneAndUpdate(
      { userId: String(userId) },
      { $inc: { balance: totalCoins, totalEarned: totalCoins }, $set: { hasPaid: true } },
      { upsert: true, new: true }
    );

    log(msg, 'stars_payment', 'userId=' + userId + ' stars=' + stars + ' coins=' + totalCoins + (pkg ? ' pkg='+pkgId : ''), 'ok');

    const bonusLine = pkg && pkg.bonus > 0 ? '\n🎁 Includes *' + pkg.bonus + '* bonus coins!' : '';
    bot.sendMessage(chatId,
`╔══════════════════╗
  ⭐  *PAYMENT SUCCESS!*
╚══════════════════╝

✅ *${totalCoins} coins* added to your wallet!${bonusLine}
💳 New Balance: *${w.balance}* coins

➡️ Use /buyref to spend coins on a ref
🎮 Then /claim to activate your account`,
      { parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🔑 Buy Ref Code', callback_data: 'menu_buyref' }]] }
      });

    // Referral bonus — 10% coins to whoever referred this user
    const buyerWallet = await BotWallet.findOne({ userId: String(userId) }).lean();
    if (buyerWallet && buyerWallet.referredBy) {
      const refBonus = Math.round(coins * 0.1);
      await BotWallet.findOneAndUpdate(
        { userId: buyerWallet.referredBy },
        { $inc: { balance: refBonus, totalEarned: refBonus } }
      ).catch(() => {});
      const buyerName = msg.from.first_name || msg.from.username || 'Someone';
      bot.sendMessage(buyerWallet.referredBy,
`💰 *Referral Bonus!*

${buyerName} just bought a coin pack!
You earned *${refBonus} coins* (10% bonus)!`,
        { parse_mode: 'Markdown' }).catch(() => {});
    }

    // Notify admins
    for (const adminId of ADMIN_IDS) {
      bot.sendMessage(adminId,
`⭐ *Stars Payment Received*

👤 User: ${msg.from.first_name || userId} (\`${userId}\`)
⭐ Stars: *${stars}*  💰 Coins: *${coins}*`,
        { parse_mode: 'Markdown' }).catch(() => {});
    }
  } catch(e) {
    console.error('Payment credit error:', e.message);
    bot.sendMessage(chatId, '⚠️ Payment received but coins not credited. Show admin this ID: ' + payment.telegram_payment_charge_id);
  }
});



bot.onText(/^\/check (.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ref = match[1].trim().toUpperCase();
  bot.sendMessage(chatId, '🔄 Checking ref code...');
  try {
    const d = await apiCheck(ref);
    if (!d.ok) { log(msg, '/check', `ref=${ref} INVALID`, 'fail'); return bot.sendMessage(chatId, `❌ *Invalid ref code.*\n\n${d.msg || 'Not recognised.'}`, { parse_mode: 'Markdown' }); }
    log(msg, '/check', `ref=${ref} OK`, 'ok');
    bot.sendMessage(chatId,
`✅ *Ref code valid!*

🔑 \`${ref}\`
🟢 Status: ${d.status || 'Available'}

➡️ Use /claim to activate it.`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error. Try again later.');
  }
});

bot.onText(/^\/claim$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const price  = parseInt(PRICE_COINS);
  log(msg, '/claim', 'started', 'info');
  const cdC = checkCooldown(String(userId), 'claim', 30);
  if (!cdC.ok) return bot.sendMessage(chatId, '⏳ *Cooldown!* Try /claim again in *'+cdC.remaining+'s*.', { parse_mode: 'Markdown' });

  // Check if user already has a pending ref from /buyref (coins already paid)
  const pending = await PendingRef.findOne({ userId: String(userId) }).catch(() => null);

  if (!pending) {
    // Direct claim path — must have enough coins
    const w = await getUserWallet(userId);
    if (!w || w.balance < price) {
      return bot.sendMessage(chatId,
`❌ *Insufficient coins!*

💰 Your balance: *${w ? w.balance : 0}* coins
💵 Required: *${price}* coins

Use /buyref to purchase a ref code, or contact admin.`,
        { parse_mode: 'Markdown' });
    }
  }

  await saveSession(chatId, { step: 'awaiting_ref', data: { paidViaByuref: !!pending, pendingRef: pending?.ref } });

  if (pending) {
    // Pre-fill the ref they already paid for
    bot.sendMessage(chatId,
`🎮 *Claim Your Account*

✅ Your reserved ref: \`${pending.ref}\`
_(Coins already paid via /buyref)_

📧 Send the *email* you want for this CPM2 account:`,
      { parse_mode: 'Markdown' });
    sessions[chatId].step = 'awaiting_email';
    sessions[chatId].data.ref = pending.ref;
    await saveSession(chatId, sessions[chatId]);
  } else {
    bot.sendMessage(chatId,
`🎮 *Claim Your Account*

Send your *ref code* below:
_(e.g. KAL-49TEX8)_`,
      { parse_mode: 'Markdown' });
  }
});

/* ═══════════════════════════════════
   CUSTOMER WALLET COMMANDS
═══════════════════════════════════ */
bot.onText(/^\/wallet$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  log(msg, '/wallet', '', 'info');
  const cdW = checkCooldown(String(userId), 'wallet', 10);
  if (!cdW.ok) return bot.sendMessage(chatId, '⏳ Check your wallet again in *'+cdW.remaining+'s*.', { parse_mode: 'Markdown' });
  const w = await getUserWallet(userId, msg.from);
  const price = parseInt(PRICE_COINS);
  const balance = w ? w.balance : 0;
  const canAfford = balance >= price;
  bot.sendMessage(chatId,
`╔══════════════════╗
  🪙  *YOUR WALLET*
╚══════════════════╝

👤 User ID: \`${userId}\`
💰 Balance: *${balance}* coins

${canAfford
  ? `✅ You can afford an account!\n➡️ Use /buyref to purchase.`
  : `❌ Need *${price - balance}* more coins.\nContact admin to top up.`}`,
    { parse_mode: 'Markdown' });
});

/* ═══════════════════════════════════
   COOLDOWN SYSTEM
   Prevents command spam — per-user, per-command throttle
═══════════════════════════════════ */
const cooldowns = {}; // { userId: { command: lastUsedTimestamp } }

function checkCooldown(userId, command, seconds) {
  const now = Date.now();
  if (!cooldowns[userId]) cooldowns[userId] = {};
  const last = cooldowns[userId][command] || 0;
  const diff = now - last;
  if (diff < seconds * 1000) {
    const remaining = Math.ceil((seconds * 1000 - diff) / 1000);
    return { ok: false, remaining };
  }
  cooldowns[userId][command] = now;
  return { ok: true };
}

// Clean up cooldown memory every 10 min
setInterval(() => {
  const now = Date.now();
  for (const uid of Object.keys(cooldowns)) {
    for (const cmd of Object.keys(cooldowns[uid])) {
      if (now - cooldowns[uid][cmd] > 5 * 60 * 1000) delete cooldowns[uid][cmd];
    }
    if (!Object.keys(cooldowns[uid]).length) delete cooldowns[uid];
  }
}, 10 * 60 * 1000);

/* ═══════════════════════════════════
   /send — coin transfer (all users)
═══════════════════════════════════ */
bot.onText(/^\/send (@?\S+) (\d+)$/, async (msg, match) => {
  const chatId    = msg.chat.id;
  const senderId  = String(msg.from.id);
  const rawTarget = match[1];
  const amount    = parseInt(match[2]);

  // Cooldown: 1 transfer per 30 seconds
  const cd = checkCooldown(senderId, 'send', 30);
  if (!cd.ok) {
    return bot.sendMessage(chatId,
`⏳ *Slow down!*

You can send coins again in *${cd.remaining}s*.`,
      { parse_mode: 'Markdown' });
  }

  if (amount <= 0) return bot.sendMessage(chatId, '❌ Amount must be positive.');
  if (amount < 10) return bot.sendMessage(chatId, '❌ Minimum transfer is 10 coins.');

  log(msg, '/send', 'target='+rawTarget+' amount='+amount, 'info');

  // Resolve recipient
  let recipientId, recipientName;
  if (rawTarget.startsWith('@')) {
    const uname = rawTarget.replace(/^@/, '');
    const rw = await BotWallet.findOne({ username: { $regex: '^@?'+uname+'$', $options: 'i' } });
    if (!rw) return bot.sendMessage(chatId, '❌ User @'+uname+' not found. They must have used the bot first.');
    if (rw.userId === senderId) return bot.sendMessage(chatId, '❌ You cannot send coins to yourself.');
    recipientId   = rw.userId;
    recipientName = '@'+uname;
  } else {
    if (rawTarget === senderId) return bot.sendMessage(chatId, '❌ You cannot send coins to yourself.');
    recipientId   = rawTarget;
    recipientName = '`'+rawTarget+'`';
  }

  // Check sender balance
  const senderWallet = await getUserWallet(senderId, msg.from);
  if (!senderWallet || senderWallet.balance < amount) {
    return bot.sendMessage(chatId,
`❌ *Insufficient coins!*

💰 Your balance: *${senderWallet ? senderWallet.balance : 0}* coins
💸 You need: *${amount}* coins`,
      { parse_mode: 'Markdown' });
  }

  // Deduct from sender
  const deducted = await removeCoins(senderId, amount);
  if (!deducted) return bot.sendMessage(chatId, '❌ Transfer failed. Try again.');

  // Credit recipient
  const credited = await addCoins(recipientId, amount);
  if (!credited) {
    await addCoins(senderId, amount); // refund
    return bot.sendMessage(chatId, '❌ Could not credit recipient. Your coins have been refunded.');
  }

  log(msg, '/send', 'from='+senderId+' to='+recipientId+' amount='+amount, 'ok');

  const senderName = msg.from.username ? '@'+msg.from.username : msg.from.first_name;

  bot.sendMessage(chatId,
`╔══════════════════╗
  💸  *TRANSFER SENT!*
╚══════════════════╝

📤 To: ${recipientName}
💰 Amount: *${amount}* coins
💳 Your new balance: *${deducted.balance}* coins`,
    { parse_mode: 'Markdown' });

  bot.sendMessage(recipientId,
`╔══════════════════╗
  💰  *COINS RECEIVED!*
╚══════════════════╝

📥 *${amount}* coins from ${senderName}
💳 New balance: *${credited.balance}* coins`,
    { parse_mode: 'Markdown' }).catch(() => {});
});

/* ═══════════════════════════════════
   /wallets — list all users with names
═══════════════════════════════════ */
bot.onText(/^\/wallets$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  log(msg, '/wallets', '', 'info');
  bot.sendMessage(chatId, '🔄 Loading wallets...');
  try {
    const wallets = await BotWallet.find().sort({ balance: -1 }).lean();
    if (!wallets.length) return bot.sendMessage(chatId, '📭 No wallets yet.');

    const total = wallets.reduce((s, w) => s + (w.balance || 0), 0);
    let chunks = [];
    let text = `╔════════════════════╗\n  💰  *ALL USER WALLETS*\n╚════════════════════╝\n\nTotal users: *${wallets.length}*  |  Total coins: *${total}*\n\n`;

    wallets.forEach((w, i) => {
      const name   = w.displayName || (w.username ? w.username.replace('@','') : null) || 'Unknown';
      const handle = w.username ? ` (${w.username})` : '';
      const line   = `${i + 1}. 👤 *${name}*${handle}\n   🆔 \`${w.userId}\`\n   💳 *${w.balance || 0}* coins  🏆 ${w.claims || 0} claims\n\n`;
      if ((text + line).length > 3800) { chunks.push(text); text = ''; }
      text += line;
    });
    if (text) chunks.push(text);

    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, chunk));
    }
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error: ' + e.message);
  }
});

// /finduser @username or name — search wallet by username/name
bot.onText(/^\/finduser (.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const query = match[1].trim().replace(/^@/, '');
  try {
    const results = await BotWallet.find({
      $or: [
        { username:    { $regex: query, $options: 'i' } },
        { displayName: { $regex: query, $options: 'i' } },
        { userId: query }
      ]
    }).limit(10);

    if (!results.length) return bot.sendMessage(chatId, `❌ No users found matching *${query}*`, { parse_mode: 'Markdown' });

    let text = `╔════════════════════╗\n  🔍  *SEARCH RESULTS*\n╚════════════════════╝\n\n`;
    results.forEach(w => {
      const name = w.displayName || w.username || 'Unknown';
      const handle = w.username ? ` (${w.username})` : '';
      text += `👤 *${name}*${handle}\n🆔 \`${w.userId}\`\n💳 *${w.balance}* coins  🏆 ${w.claims || 0} claims\n\n`;
    });

    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error: ' + e.message);
  }
});



/* ═══════════════════════════════════
   ADMIN WALLET COMMANDS
   /gc  — give coins  (reply | userId | @username)
   /rc  — remove coins (same targeting)
   /setbal — set exact balance
═══════════════════════════════════ */

/* Shared helper: resolve admin target from reply / userId / @username */
async function resolveTarget(msg, userArg) {
  if (msg.reply_to_message) {
    const sender = msg.reply_to_message.from;
    if (!sender || sender.is_bot) return { err: "Can't target a bot." };
    await BotWallet.findOneAndUpdate(
      { userId: String(sender.id) },
      { $set: { username: sender.username ? '@' + sender.username : '', displayName: sender.first_name || '' } },
      { upsert: true }
    ).catch(() => {});
    return {
      userId: String(sender.id),
      targetName: sender.username ? '@' + sender.username : sender.first_name
    };
  }
  if (userArg) {
    if (userArg.startsWith('@')) {
      const uname = userArg.replace(/^@/, '');
      const w = await BotWallet.findOne({ username: { $regex: '^@?' + uname + '$', $options: 'i' } });
      if (!w) return { err: `No user found with username @${uname}. They must have used the bot first.` };
      return { userId: w.userId, targetName: '@' + uname };
    }
    return { userId: userArg, targetName: `\`${userArg}\`` };
  }
  return { err: 'Reply to a message or specify a userId / @username.' };
}

function adminCoinMsg(action, targetName, userId, delta, newBal) {
  const icon = delta > 0 ? '➕' : '➖';
  const word = delta > 0 ? 'Added' : 'Removed';
  return `✅ *Coins ${word}!*\n\n👤 User: ${targetName}\n🆔 ID: \`${userId}\`\n${icon} ${word}: *${Math.abs(delta)}* coins\n💰 New Balance: *${newBal}* coins`;
}

// /gc <amount>            — reply to give coins
// /gc <userId|@u> <amount>
bot.onText(/^\/gc (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const inGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (!ADMIN_IDS.includes(String(msg.from.id))) { if (!inGroup) bot.sendMessage(chatId, '🚫 Admin only.'); return; }
  if (!msg.reply_to_message) return bot.sendMessage(chatId, '❌ Reply to someone, or use: /gc <userId|@username> <amount>');

  const { userId, targetName, err } = await resolveTarget(msg, null);
  if (err) return bot.sendMessage(chatId, '❌ ' + err);
  const amount = parseInt(match[1]);
  if (amount <= 0) return bot.sendMessage(chatId, '❌ Amount must be positive.');

  const w = await addCoins(userId, amount);
  if (!w) return bot.sendMessage(chatId, '❌ Error updating balance.');
  log(msg, '/gc', `target=${userId} amount=${amount} newbal=${w.balance}`, 'ok');

  const txt = adminCoinMsg('Added', targetName, userId, amount, w.balance);
  bot.sendMessage(userId,
`╔══════════════════╗\n  🎁  *COINS RECEIVED!*\n╚══════════════════╝\n\n💰 You received *${amount}* coins from admin!\n💳 New Balance: *${w.balance}* coins\n\nUse /wallet to check your balance.`,
    { parse_mode: 'Markdown' }).catch(() => {});

  if (inGroup) {
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    const sent = await bot.sendMessage(msg.from.id, txt, { parse_mode: 'Markdown' }).then(() => true).catch(() => false);
    if (!sent) {
      const tmp = await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', disable_notification: true }).catch(() => null);
      if (tmp) setTimeout(() => bot.deleteMessage(chatId, tmp.message_id).catch(() => {}), 6000);
    }
  } else {
    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
  }
});

bot.onText(/^\/gc (@\S+|[^\d]\S*) (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const inGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (!ADMIN_IDS.includes(String(msg.from.id))) { if (!inGroup) bot.sendMessage(chatId, '🚫 Admin only.'); return; }

  const { userId, targetName, err } = await resolveTarget(msg, match[1]);
  if (err) return bot.sendMessage(chatId, '❌ ' + err);
  const amount = parseInt(match[2]);
  if (amount <= 0) return bot.sendMessage(chatId, '❌ Amount must be positive.');

  await CommandLog.create({ userId: String(msg.from.id), username: msg.from.username || msg.from.first_name || 'Unknown', command: 'gc', params: { targetUserId: userId, amount } }).catch(() => {});
  const w = await addCoins(userId, amount);
  if (!w) return bot.sendMessage(chatId, '❌ Error updating balance.');
  log(msg, '/gc', `target=${userId} amount=${amount} newbal=${w.balance}`, 'ok');

  const txt = adminCoinMsg('Added', targetName, userId, amount, w.balance);
  bot.sendMessage(userId,
`╔══════════════════╗\n  🎁  *COINS RECEIVED!*\n╚══════════════════╝\n\n💰 You received *${amount}* coins from admin!\n💳 New Balance: *${w.balance}* coins\n\nUse /wallet to check your balance.`,
    { parse_mode: 'Markdown' }).catch(() => {});

  if (inGroup) {
    bot.deleteMessage(chatId, msg.message_id).catch(() => {});
    const sent = await bot.sendMessage(msg.from.id, txt, { parse_mode: 'Markdown' }).then(() => true).catch(() => false);
    if (!sent) {
      const tmp = await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', disable_notification: true }).catch(() => null);
      if (tmp) setTimeout(() => bot.deleteMessage(chatId, tmp.message_id).catch(() => {}), 6000);
    }
  } else {
    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
  }
});

// /rc <amount>            — reply to remove coins
// /rc <userId|@u> <amount>
bot.onText(/^\/rc (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  if (!msg.reply_to_message) return bot.sendMessage(chatId, '❌ Reply to someone, or use: /rc <userId|@username> <amount>');
  const { userId, targetName, err } = await resolveTarget(msg, null);
  if (err) return bot.sendMessage(chatId, '❌ ' + err);
  const amount = parseInt(match[1]);
  if (amount <= 0) return bot.sendMessage(chatId, '❌ Amount must be positive.');
  const w = await removeCoins(userId, amount);
  if (!w) return bot.sendMessage(chatId, "❌ User doesn't have enough coins or doesn't exist.");
  log(msg, '/rc', `target=${userId} amount=${amount} newbal=${w.balance}`, 'ok');
  bot.sendMessage(chatId, adminCoinMsg('Removed', targetName, userId, -amount, w.balance), { parse_mode: 'Markdown' });
});

bot.onText(/^\/rc (@\S+|[^\d]\S*) (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  const { userId, targetName, err } = await resolveTarget(msg, match[1]);
  if (err) return bot.sendMessage(chatId, '❌ ' + err);
  const amount = parseInt(match[2]);
  if (amount <= 0) return bot.sendMessage(chatId, '❌ Amount must be positive.');
  const w = await removeCoins(userId, amount);
  if (!w) return bot.sendMessage(chatId, "❌ User doesn't have enough coins or doesn't exist.");
  log(msg, '/rc', `target=${userId} amount=${amount} newbal=${w.balance}`, 'ok');
  bot.sendMessage(chatId, adminCoinMsg('Removed', targetName, userId, -amount, w.balance), { parse_mode: 'Markdown' });
});

// /setbal <userId|@u> <amount> — set exact balance
bot.onText(/^\/setbal (@?\S+) (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  const { userId, targetName, err } = await resolveTarget(msg, match[1]);
  if (err) return bot.sendMessage(chatId, '❌ ' + err);
  const amount = parseInt(match[2]);
  try {
    const w = await BotWallet.findOneAndUpdate({ userId: String(userId) }, { $set: { balance: amount } }, { upsert: true, new: true });
    log(msg, '/setbal', `target=${userId} amount=${amount}`, 'ok');
    bot.sendMessage(chatId,
`✅ *Balance Set!*\n\n👤 User: ${targetName}\n🆔 ID: \`${userId}\`\n💳 New Balance: *${w.balance}* coins`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error: ' + e.message);
  }
});

// Legacy alias kept for backwards compat
bot.onText(/^\/removecoins (\d+) (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only. (Tip: use /rc instead)');
  const userId = match[1], amount = parseInt(match[2]);
  if (amount <= 0) return bot.sendMessage(chatId, '❌ Amount must be positive.');
  const w = await removeCoins(userId, amount);
  if (!w) return bot.sendMessage(chatId, "❌ User doesn't have enough coins or doesn't exist.");
  log(msg, '/removecoins', `target=${userId} amount=${amount} newbal=${w.balance}`, 'ok');
  bot.sendMessage(chatId, adminCoinMsg('Removed', `\`${userId}\``, userId, -amount, w.balance), { parse_mode: 'Markdown' });
});

/* ═══════════════════════════════════
   /buyref — buy a ref code with coins
   Coins are deducted IMMEDIATELY and the ref is reserved to this user.
   If /claim fails later the coins are refunded automatically.
═══════════════════════════════════ */
/* ═══════════════════════════════════
   /buyref — spend coins to get a ref code
═══════════════════════════════════ */
bot.onText(/^\/buyref$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const price  = parseInt(PRICE_COINS);

  const cdB = checkCooldown(String(userId), 'buyref', 30);
  if (!cdB.ok) return bot.sendMessage(chatId, '⏳ *Cooldown!* Try again in *'+cdB.remaining+'s*.', { parse_mode: 'Markdown' });

  // Already has a pending ref?
  const existing = await PendingRef.findOne({ userId: String(userId) }).catch(() => null);
  if (existing) {
    return bot.sendMessage(chatId,
`⚠️ *You already have a reserved ref!*

🔑 \`${existing.ref}\`

➡️ Use /claim to activate it first.`,
      { parse_mode: 'Markdown' });
  }

  const w = await getUserWallet(userId, msg.from);
  if (!w || w.balance < price) {
    return bot.sendMessage(chatId,
`❌ *Insufficient coins!*

💰 Your balance: *${w ? w.balance : 0}* coins
💵 Required: *${price}* coins
📉 Need: *${price - (w ? w.balance : 0)}* more

👉 Use /pay to buy more coins!`,
      { parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🪙 Buy Coins', callback_data: 'menu_pay' }]] }
      });
  }

  try {
    const accs = await apiAdminAccounts();
    const free = accs.find(a => a.status === 'AVAILABLE');
    if (!free) return bot.sendMessage(chatId, '❌ No accounts in stock right now. Try again soon.');

    const deducted = await removeCoins(userId, price);
    if (!deducted) return bot.sendMessage(chatId, '❌ Failed to deduct coins. Try again.');

    await PendingRef.findOneAndUpdate(
      { userId: String(userId) },
      { userId: String(userId), ref: free.ref },
      { upsert: true, new: true }
    ).catch(() => {});

    log(msg, '/buyref', 'ref='+free.ref+' coins='+price, 'ok');
    bot.sendMessage(chatId,
`✅ *Ref Code Purchased!*

🔑 Your Ref Code:
\`${free.ref}\`

💰 Coins spent: *${price}*
💳 Remaining: *${deducted.balance}* coins

➡️ Use /claim to activate your account.
_Ref reserved for you. Coins refunded if claim fails._`,
      { parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '🎮 Claim Now', callback_data: 'menu_claim' }]] }
      });
  } catch(e) {
    console.error('/buyref error:', e.message);
    bot.sendMessage(chatId, '❌ Server error. No coins were deducted.');
  }
});

bot.onText(/^\/approve(?: (.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  // Support: /approve (reply), /approve userId, /approve @username
  const { userId: targetUserId, targetName, err } = await resolveTarget(msg, match[1] ? match[1].trim() : null);
  if (err) return bot.sendMessage(chatId, '❌ ' + err + '\nUsage: reply to someone or use /approve <userId|@username>');
  log(msg, '/approve', `target=${targetUserId}`, 'info');
  bot.sendMessage(chatId, '🔄 Finding a free account...');
  try {
    const accs = await apiAdminAccounts();
    if (accs.error) return bot.sendMessage(chatId, '❌ ' + accs.error);
    const free = accs.find(a => a.status === 'AVAILABLE');
    if (!free) return bot.sendMessage(chatId, '❌ No accounts available right now.');

    // Reserve this ref for the target user so it can't be double-assigned
    await PendingRef.findOneAndUpdate(
      { userId: String(targetUserId) },
      { userId: String(targetUserId), ref: free.ref },
      { upsert: true }
    ).catch(() => {});

    bot.sendMessage(chatId,
`✅ *Approved!*

🔑 Ref: \`${free.ref}\`
👤 Reserved for: ${targetName} (\`${targetUserId}\`)
_Ref is now locked to this user._`,
      { parse_mode: 'Markdown' });

    if (/^\d+$/.test(targetUserId)) {
      bot.sendMessage(targetUserId,
`╔══════════════════╗
   ✅  *PAYMENT APPROVED*
╚══════════════════╝

🎉 Your account is ready!

🔑 Your Ref Code:
\`${free.ref}\`

➡️ Use /claim to activate your CPM2 account now!`,
        { parse_mode: 'Markdown' }
      ).catch(() => bot.sendMessage(chatId, '⚠️ Could not DM that user. Send the ref manually.'));
    }
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error: ' + e.message);
  }
});

bot.onText(/^\/stock$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  log(msg, '/stock', '', 'info');
  try {
    const s = await apiAdminStats();
    if (s.ok === false) return bot.sendMessage(chatId, '❌ ' + s.msg);
    bot.sendMessage(chatId,
`╔══════════════════╗
  📊  *STOCK REPORT*  📊
╚══════════════════╝

📦 Total:       *${s.total}*
🟢 Available:  *${s.available}*
🔴 Taken:       *${s.taken}*
🟡 Reserved:  *${s.reserved}*
⛔ Invalid:     *${s.invalid}*
💳 Wallets:    *${s.walletCount}*`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error.');
  }
});

bot.onText(/^\/reset (.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  const ref = match[1].trim().toUpperCase();
  bot.sendMessage(chatId, '🔄 Resetting...');
  try {
    const d = await apiAdminReset(ref);
    log(msg, '/reset', `ref=${ref} result=${d.ok?'ok':'fail'}`, d.ok?'ok':'fail');
    bot.sendMessage(chatId, d.ok ? `✅ ${d.msg}` : `❌ ${d.msg}`);
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error.');
  }
});

bot.onText(/^\/myid$/, (msg) => {
  log(msg, '/myid', '', 'info');
  bot.sendMessage(msg.chat.id,
`🪪 *Your IDs*

👤 User ID:  \`${msg.from.id}\`
💬 Chat ID:  \`${msg.chat.id}\``,
    { parse_mode: 'Markdown' });
});

bot.onText(/^\/menu$/, (msg) => {
  const chatId = msg.chat.id;
  const admin  = isAdmin(msg);
  log(msg, '/menu', '', 'info');

  const customerKeyboard = [
    [{ text: '💳 Payment Info',   callback_data: 'menu_pay'    }, { text: '🪙 My Wallet',    callback_data: 'menu_wallet' }],
    [{ text: '🎮 Claim Account',  callback_data: 'menu_claim'  }, { text: '🔑 Buy Ref Code',  callback_data: 'menu_buyref' }],
    [{ text: '💸 Send Coins',     callback_data: 'menu_send'   }, { text: '🪪 My ID',         callback_data: 'menu_myid'   }],
    [{ text: '🏆 Leaderboard',    callback_data: 'menu_top'    }, { text: '🏅 My Rank',       callback_data: 'menu_rank'   }],
    [{ text: '🔗 Referral Link',  callback_data: 'menu_ref'    }, { text: '🪪 My ID',          callback_data: 'menu_myid'   }],
  ];

  const adminKeyboard = admin ? [
    [{ text: '📊 Stats',           callback_data: 'adm_stats'    }, { text: '💳 All Wallets',  callback_data: 'adm_wallets' }],
    [{ text: '📋 List Accounts',   callback_data: 'adm_list'     }, { text: '🟡 Pending',      callback_data: 'adm_pending' }],
    [{ text: '📦 Stock',           callback_data: 'adm_stock'    }, { text: '📈 Log Stats',    callback_data: 'adm_logstats'}],
  ] : [];

  bot.sendMessage(chatId,
`╔════════════════════╗
  📟  *KALYPO MODS MENU*  📟
╚════════════════════╝

Tap a button or type a command:${admin ? '\n\n🔐 *Admin panel included below*' : ''}`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [...customerKeyboard, ...adminKeyboard] }
    }
  );
});

/* ─────────────────────────────────
   /broadcast
───────────────────────────────── */
bot.onText(/^\/broadcast (.+)$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  if (broadcastLock) return bot.sendMessage(chatId, '⏳ Broadcast already running. Wait for it to finish.');

  broadcastLock = true;
  const message = match[1].trim();

  // Reload from DB
  const dbUsers = await BotUser.find().catch(() => []);
  dbUsers.forEach(u => knownUsers.add(u.chatId));

  const users = [...knownUsers];
  if (!users.length) {
    broadcastLock = false;
    return bot.sendMessage(chatId, '❌ No users tracked yet.');
  }

  log(msg, '/broadcast', `msg="${message.substring(0,60)}" users=${users.length}`, 'info');
  bot.sendMessage(chatId, `📢 *Broadcasting to ${users.length} users...*`, { parse_mode: 'Markdown' });

  let sent = 0, failed = 0;
  for (const uid of users) {
    try {
      await bot.sendMessage(uid,
`📢 *Message from Kalypo Mods*
━━━━━━━━━━━━━━━━━━━
${message}
━━━━━━━━━━━━━━━━━━━
🎮 _Kalypo Mods — CPM2 Store_`,
        { parse_mode: 'Markdown' });
      sent++;
    } catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }

  broadcastLock = false;
  bot.sendMessage(chatId,
`✅ *Broadcast done!*

📨 Sent: *${sent}*
❌ Failed: *${failed}*`,
    { parse_mode: 'Markdown' });
});

/* ─────────────────────────────────
   /list
───────────────────────────────── */
bot.onText(/^\/list$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  log(msg, '/list', '', 'info');
  bot.sendMessage(chatId, '🔄 Loading accounts...');
  try {
    const accs = await apiAdminAccounts();
    if (accs.error) return bot.sendMessage(chatId, '❌ ' + accs.error);
    listState[chatId] = { accounts: accs, page: 0, filter: 'all' };
    const { text, buttons } = buildListPage(accs, 0);
    const keyboard = [];
    if (buttons.length) keyboard.push(buttons);
    keyboard.push([{ text: '🟡 Pending Only', callback_data: 'list_pending' }, { text: '📋 All', callback_data: 'list_all' }]);
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  } catch(e) { bot.sendMessage(chatId, '❌ Server error.'); }
});

/* ─────────────────────────────────
   /pending
───────────────────────────────── */
bot.onText(/^\/pending$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  bot.sendMessage(chatId, '🔄 Loading pending accounts...');
  try {
    const accs = await apiAdminAccounts();
    if (accs.error) return bot.sendMessage(chatId, '❌ ' + accs.error);
    const pending = accs.filter(a => a.status === 'RESERVED');
    if (!pending.length) return bot.sendMessage(chatId, '✅ No pending accounts right now.');
    listState[chatId] = { accounts: pending, page: 0, filter: 'pending' };
    const { text, buttons } = buildListPage(pending, 0);
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: buttons.length ? { inline_keyboard: [buttons] } : undefined });
  } catch(e) { bot.sendMessage(chatId, '❌ Server error.'); }
});

/* ─────────────────────────────────
   Inline keyboard — all button handlers
───────────────────────────────── */
/* Helper: inject a fake message update so onText handlers fire correctly */
function fakeMsg(query, text) {
  return bot.processUpdate({
    update_id: 0,
    message: {
      message_id: query.message.message_id,
      from: query.from,
      chat: query.message.chat,
      date: Math.floor(Date.now() / 1000),
      text
    }
  });
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const userId = String(query.from.id);
  const data   = query.data;
  bot.answerCallbackQuery(query.id).catch(() => {});

  // ── MENU buttons ──────────────────────────────────────────────────────────
  if (data === 'menu_pay')    { fakeMsg(query, '/pay');      return; }
  if (data === 'menu_wallet') { fakeMsg(query, '/wallet');   return; }
  if (data === 'menu_claim')  { fakeMsg(query, '/claim');    return; }
  if (data === 'menu_buyref') { fakeMsg(query, '/buyref');   return; }
  if (data === 'menu_top')    { fakeMsg(query, '/top');      return; }
  if (data === 'menu_rank')   { fakeMsg(query, '/rank');     return; }
  if (data === 'menu_myid')   { fakeMsg(query, '/myid');     return; }
  if (data === 'menu_ref')    { fakeMsg(query, '/referral'); return; }
  if (data.startsWith('ref_copy_')) {
    const uid = data.replace('ref_copy_', '');
    const uname = await getBotUsername();
    const link  = 'https://t.me/' + uname + '?start=' + uid;
    bot.answerCallbackQuery(query.id, { text: '🔗 Link: ' + link, show_alert: true });
    return;
  }
  if (data === 'menu_full')   { fakeMsg(query, '/menu');     return; }
  if (data === 'menu_send') {
    bot.sendMessage(chatId, '💸 *Send Coins*\n\nUsage: `/send @username 100`\nOr: `/send userId 100`\n\nMinimum: 10 coins · 30s cooldown between transfers', { parse_mode: 'Markdown' });
    return;
  }
  // Coin package Stars payment
  if (data.startsWith('buy_coins_')) {
    const pkgId = data.replace('buy_coins_', '');
    await sendCoinInvoice(chatId, query.from, pkgId);
    return;
  }
  // Open coin shop
  if (data === 'menu_pay') {
    await showCoinShop(chatId);
    return;
  }
  if (data === 'pay_manual') {
    bot.sendMessage(chatId,
`📸 *Manual Payment*

Send your payment proof to admin.
Admin will credit your coins using /gc.

Then use /buyref → /claim to get your account.`,
      { parse_mode: 'Markdown' });
    return;
  }


  // ── ADMIN panel buttons ───────────────────────────────────────────────────
  if (data === 'adm_stats') {
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: '🚫 Admin only', show_alert: true });
    fakeMsg(query, '/stats');    return;
  }
  if (data === 'adm_wallets') {
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: '🚫 Admin only', show_alert: true });
    fakeMsg(query, '/wallets');  return;
  }
  if (data === 'adm_list') {
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: '🚫 Admin only', show_alert: true });
    fakeMsg(query, '/list');     return;
  }
  if (data === 'adm_pending') {
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: '🚫 Admin only', show_alert: true });
    fakeMsg(query, '/pending');  return;
  }
  if (data === 'adm_stock') {
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: '🚫 Admin only', show_alert: true });
    fakeMsg(query, '/stock');    return;
  }
  if (data === 'adm_logstats') {
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: '🚫 Admin only', show_alert: true });
    fakeMsg(query, '/logstats'); return;
  }

  // ── LEADERBOARD pagination ────────────────────────────────────────────────
  if (data.startsWith('top_')) {
    const parts = data.split('_');
    const mode  = parts[1];
    const page  = parseInt(parts[2]) || 0;
    try {
      const lb = await buildLeaderboard(mode, page);
      if (!lb) return;
      bot.editMessageText(lb.text, {
        chat_id: chatId, message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: lb.keyboard }
      }).catch(() => {});
    } catch(e) {}
    return;
  }

  // ── LIST pagination (existing) ────────────────────────────────────────────
  if (!listState[chatId]) return;
  let { accounts, page, filter } = listState[chatId];

  if (data === 'list_next') page++;
  else if (data === 'list_prev') page--;
  else if (data === 'list_pending') {
    try {
      const accs = await apiAdminAccounts();
      accounts = accs.filter(a => a.status === 'RESERVED');
      filter = 'pending'; page = 0;
      if (!accounts.length) return bot.editMessageText('✅ No pending accounts right now.', { chat_id: chatId, message_id: msgId });
    } catch(e) { return; }
  } else if (data === 'list_all') {
    try { accounts = await apiAdminAccounts(); filter = 'all'; page = 0; } catch(e) { return; }
  }

  listState[chatId] = { accounts, page, filter };
  const { text, buttons } = buildListPage(accounts, page);
  const keyboard = [];
  if (buttons.length) keyboard.push(buttons);
  keyboard.push([{ text: '🟡 Pending Only', callback_data: 'list_pending' }, { text: '📋 All', callback_data: 'list_all' }]);
  bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }).catch(() => {});
});

/* ─────────────────────────────────
   /schedule /unschedule /schedules
───────────────────────────────── */
function parseTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { hour: h, minute: m };
}

bot.onText(/^\/schedule (\d{1,2}:\d{2}) (.+)$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const time = parseTime(match[1]);
  if (!time) return bot.sendMessage(chatId, '❌ Invalid time. Use HH:MM e.g. 09:00');

  const message = match[2].trim();
  const id = `${String(time.hour).padStart(2,'0')}:${String(time.minute).padStart(2,'0')}`;

  startSchedule(id, time.hour, time.minute, message);
  await Schedule.updateOne({ id }, { id, hour: time.hour, minute: time.minute, message }, { upsert: true }).catch(() => {});

  bot.sendMessage(chatId,
`✅ *Schedule saved!*

🕐 Time: *${id} GMT*
📢 _${message}_

Use /unschedule ${id} to cancel.`,
    { parse_mode: 'Markdown' });
});

bot.onText(/^\/unschedule (.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  const id = match[1].trim();
  if (!schedules[id]) return bot.sendMessage(chatId, `❌ No schedule found for *${id}*`, { parse_mode: 'Markdown' });
  clearTimeout(schedules[id].timer);
  delete schedules[id];
  await Schedule.deleteOne({ id }).catch(() => {});
  bot.sendMessage(chatId, `✅ Schedule *${id}* cancelled.`, { parse_mode: 'Markdown' });
});

bot.onText(/^\/schedules$/, (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  const list = Object.entries(schedules);
  if (!list.length) return bot.sendMessage(chatId, '📭 No active schedules.');
  let text = `╔══════════════════╗\n  📅  *ACTIVE SCHEDULES*\n╚══════════════════╝\n\n`;
  list.forEach(([id, s]) => { text += `🕐 *${id} GMT*\n📢 _${s.message}_\n\n`; });
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

/* ═══════════════════════════════════
   BAN SYSTEM  (definitions kept here for organisation — models/fns moved up)
═══════════════════════════════════ */

/* ═══════════════════════════════════
   WELCOMER
═══════════════════════════════════ */
bot.on('new_chat_members', (msg) => {
  const chatId = msg.chat.id;
  msg.new_chat_members.forEach(user => {
    if (user.is_bot) return;
    const name = user.first_name || 'Player';
    bot.sendMessage(chatId,
`╔═══════════════════╗
  🎮  *WELCOME TO KALYPO MODS*
╚═══════════════════╝

👋 Hey *${name}*, welcome!
You just joined the #1 CPM2 account store 🔥

┌─────────────────────┐
│ 💎 Premium CPM2 Accounts  │
│ 🪙 300 Coins included       │
│ 👑 King Rank + All Cars    │
│ 🎨 Full Unlocks               │
└─────────────────────┘

📲 *DM the bot to get started:*
👉 /start — see what's available
👉 /pay — payment info
👉 /claim — activate your account

⚠️ _No links allowed in this group._
😎 _Enjoy your stay!_`,
      { parse_mode: 'Markdown' }
    ).then(sent => {
      setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => {}), 60000);
    });
  });
});

/* ═══════════════════════════════════
   LEAVER
═══════════════════════════════════ */
bot.on('left_chat_member', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.left_chat_member.id;
  const name = msg.left_chat_member.first_name || 'User';

  // Message to group
  bot.sendMessage(chatId,
`👋 *${name}* has left the group.

See you next time! 🎮`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});

  // DM to user
  bot.sendMessage(userId,
`╔═════════════════════╗
  👋  *YOU LEFT KALYPO MODS*
╚═════════════════════╝

Hope to see you again soon! 🎮

If you need anything, just come back and DM the bot.
We'll be here! 💚`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

/* ═══════════════════════════════════
   LEADERBOARD COMMANDS
═══════════════════════════════════ */
const MEDALS = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

// /top — public leaderboard (top coin holders)
// /top claims — top claimers
async function buildLeaderboard(mode, page) {
  const sortField = mode === 'claims' ? { claims: -1, balance: -1 } : { balance: -1, claims: -1 };
  const perPage   = 10;
  const skip      = page * perPage;
  const [top, total] = await Promise.all([
    BotWallet.find().sort(sortField).skip(skip).limit(perPage).lean(),
    BotWallet.countDocuments()
  ]);
  if (!top.length) return null;

  const totalPages = Math.ceil(total / perPage);
  const title      = mode === 'claims' ? '🏆 TOP CLAIMERS' : '💰 TOP COIN HOLDERS';
  let text = `╔════════════════════╗\n  ${title}  (Page ${page+1}/${totalPages})\n╚════════════════════╝\n\n`;

  top.forEach((w, i) => {
    const rank   = skip + i + 1;
    const medal  = MEDALS[i] || `${rank}.`;
    const name   = w.displayName || (w.username ? w.username.replace('@','') : null) || `User ${String(w.userId).slice(-4)}`;
    const handle = w.username ? ` (${w.username})` : '';
    const value  = mode === 'claims' ? `*${w.claims || 0}* claims` : `*${w.balance || 0}* coins`;
    text += `${medal} *${name}*${handle}\n   ${value}\n\n`;
  });
  text += `_${total} total users_`;

  const nav = [];
  if (page > 0)               nav.push({ text: '◀️ Prev', callback_data: `top_${mode}_${page-1}` });
  if (page + 1 < totalPages)  nav.push({ text: 'Next ▶️', callback_data: `top_${mode}_${page+1}` });

  const modeSwitch = mode === 'coins'
    ? [{ text: '🏆 Switch to Claims', callback_data: `top_claims_0` }]
    : [{ text: '💰 Switch to Coins',  callback_data: `top_coins_0`  }];

  const keyboard = [];
  if (nav.length)   keyboard.push(nav);
  keyboard.push(modeSwitch);

  return { text, keyboard };
}

bot.onText(/^\/top(?: (coins|claims))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const mode   = (match[1] || 'coins').toLowerCase();
  log(msg, '/top', mode, 'info');
  const cdT = checkCooldown(String(msg.from.id), 'top', 20);
  if (!cdT.ok) return bot.sendMessage(chatId, '⏳ Check the leaderboard again in *'+cdT.remaining+'s*.', { parse_mode: 'Markdown' });

  try {
    const lb = await buildLeaderboard(mode, 0);
    if (!lb) return bot.sendMessage(chatId, '📭 No leaderboard data yet.');
    bot.sendMessage(chatId, lb.text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: lb.keyboard } });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error loading leaderboard.');
  }
});

// /rank — show your own rank
bot.onText(/^\/rank$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  log(msg, '/rank', '', 'info');
  const cdR = checkCooldown(userId, 'rank', 15);
  if (!cdR.ok) return bot.sendMessage(chatId, '⏳ Check your rank again in *'+cdR.remaining+'s*.', { parse_mode: 'Markdown' });

  try {
    const w = await getUserWallet(userId, msg.from);
    if (!w) return bot.sendMessage(chatId, '❌ No wallet found. Use /start first.');

    // Count how many users have more coins / more claims
    const coinsRank  = await BotWallet.countDocuments({ balance: { $gt: w.balance } }) + 1;
    const claimsRank = await BotWallet.countDocuments({ claims:  { $gt: w.claims  } }) + 1;
    const totalUsers = await BotWallet.countDocuments();

    const tier = coinsRank === 1 ? '👑 Legend'
               : coinsRank <= 3  ? '💎 Elite'
               : coinsRank <= 10 ? '🔥 Top 10'
               : coinsRank <= 25 ? '⭐ Rising'
               :                   '🎮 Member';

    bot.sendMessage(chatId,
`╔══════════════════╗
  🏅  *YOUR RANK*
╚══════════════════╝

👤 ${msg.from.first_name || 'You'}
${tier}

💰 Coins rank:  *#${coinsRank}* of ${totalUsers}
🎮 Claim rank:  *#${claimsRank}* of ${totalUsers}

💳 Balance:  *${w.balance}* coins
🏆 Claims:   *${w.claims || 0}* accounts
📈 All-time earned: *${w.totalEarned || 0}* coins

➡️ /top to see full leaderboard`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error fetching rank.');
  }
});

/* ═══════════════════════════════════
   /logs COMMAND (admin)
═══════════════════════════════════ */
// /logs          — last 20 entries
// /logs 50       — last N entries
// /logs fail     — only failures
// /logs ok       — only successes
// /logs <userId> — filter by user
bot.onText(/^\/logs(?: (.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const arg = (match[1] || '').trim();
  let filter = {};
  let limit = 20;

  if (!arg) {
    // default: last 20
  } else if (/^\d{4,}$/.test(arg)) {
    // looks like a userId
    filter.userId = arg;
  } else if (/^\d{1,3}$/.test(arg)) {
    limit = Math.min(parseInt(arg), 100);
  } else if (arg === 'fail') {
    filter.result = 'fail';
  } else if (arg === 'ok') {
    filter.result = 'ok';
  } else if (arg === 'info') {
    filter.result = 'info';
  } else if (arg.startsWith('@')) {
    filter.username = { $regex: arg.replace('@',''), $options: 'i' };
  }

  try {
    const entries = await ActivityLog.find(filter).sort({ timestamp: -1 }).limit(limit).catch(() => []);
    if (!entries.length) return bot.sendMessage(chatId, '📭 No logs found.');

    const resultIcon = { ok: '✅', fail: '❌', info: '📋' };

    let text = `╔════════════════════╗\n  📊  *BOT ACTIVITY LOG*\n╚════════════════════╝\n`;
    text += `_Showing ${entries.length} entries${arg ? ' · filter: ' + arg : ''}_\n\n`;

    for (const e of entries) {
      const time = new Date(e.timestamp);
      const timeStr = time.toLocaleString('en-GB', { hour12: false, timeZone: 'UTC' }) + ' UTC';
      const icon = resultIcon[e.result] || '📋';
      text += `${icon} *${e.action}*
`;
      text += `   👤 ${e.username} \`${e.userId}\`
`;
      if (e.detail) text += `   📝 ${e.detail}\n`;
      text += `   🕐 ${timeStr}\n\n`;
    }

    // Split if too long (Telegram 4096 char limit)
    if (text.length > 3800) {
      const chunks = [];
      const lines = text.split('\n\n');
      let chunk = '';
      for (const line of lines) {
        if ((chunk + line).length > 3500) {
          chunks.push(chunk);
          chunk = line + '\n\n';
        } else {
          chunk += line + '\n\n';
        }
      }
      if (chunk) chunks.push(chunk);
      for (const c of chunks) {
        await bot.sendMessage(chatId, c, { parse_mode: 'Markdown' }).catch(() =>
          bot.sendMessage(chatId, c)
        );
      }
    } else {
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() =>
        bot.sendMessage(chatId, text)
      );
    }
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error loading logs: ' + e.message);
  }
});

/* /logstats — summary counts per action */
bot.onText(/^\/logstats$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  try {
    const total      = await ActivityLog.countDocuments();
    const ok         = await ActivityLog.countDocuments({ result: 'ok' });
    const fail       = await ActivityLog.countDocuments({ result: 'fail' });
    const today      = new Date(); today.setUTCHours(0,0,0,0);
    const todayCount = await ActivityLog.countDocuments({ timestamp: { $gte: today } });

    const pipeline = await ActivityLog.aggregate([
      { $group: { _id: '$action', count: { $sum: 1 } } },
      { $sort:  { count: -1 } },
      { $limit: 10 }
    ]);

    let text = `╔════════════════════╗\n  📊  *LOG STATS*\n╚════════════════════╝\n\n`;
    text += `📦 Total entries: *${total}*\n`;
    text += `✅ Success: *${ok}*   ❌ Fail: *${fail}*\n`;
    text += `🕐 Today: *${todayCount}*\n\n`;
    text += `*Top Actions:*\n`;
    pipeline.forEach(p => { text += `  • \`${p._id}\` — *${p.count}*\n`; });

    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error: ' + e.message);
  }
});

/* ═══════════════════════════════════
   /ban COMMAND (admin)
═══════════════════════════════════ */
bot.onText(/^\/ban (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const userId = match[1];
  try {
    await banUser(userId);
    log(msg, '/ban', `target=${userId}`, 'ok');
    bot.sendMessage(chatId,
`🚫 *User banned!*

👤 User ID: \`${userId}\`
🔒 Status: Banned from bot`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error banning user.');
  }
});

/* /unban COMMAND (admin) */
bot.onText(/^\/unban (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const userId = match[1];
  try {
    await unbanUser(userId);
    log(msg, '/unban', `target=${userId}`, 'ok');
    bot.sendMessage(chatId,
`✅ *User unbanned!*

👤 User ID: \`${userId}\`
🟢 Status: Unbanned`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error unbanning user.');
  }
});

/* ═══════════════════════════════════
   ANTI-LINK (groups only)
═══════════════════════════════════ */
const LINK_REGEX = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/)/i;
const MUTE_DURATION = 7 * 24 * 60 * 60;

bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup') return;
  if (!LINK_REGEX.test(msg.text)) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const name   = msg.from.first_name || 'User';

  try {
    const member = await bot.getChatMember(chatId, userId);
    if (['administrator', 'creator'].includes(member.status)) return;
  } catch(e) { return; }

  bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  const warnDoc = await Warn.findOneAndUpdate(
    { userId: String(userId) },
    { $inc: { count: 1 } },
    { upsert: true, new: true }
  ).catch(() => null);

  const warns = warnDoc ? warnDoc.count : 1;

  log(msg, 'antilink:warn', `warns=${warns} user=${userId}`, 'fail');
  if (warns >= 3) {
    const until = Math.floor(Date.now() / 1000) + MUTE_DURATION;
    try {
      await bot.restrictChatMember(chatId, userId, {
        permissions: {
          can_send_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false
        },
        until_date: until
      });
      await Warn.deleteOne({ userId: String(userId) }).catch(() => {});
      bot.sendMessage(chatId,
`╔══════════════════╗
  🔇  *USER MUTED*
╚══════════════════╝

👤 *${name}* has been muted for *1 week*
🚫 Reason: Posting links (3 warnings)
📅 Mute expires in 7 days`,
        { parse_mode: 'Markdown' });
    } catch(e) {
      // Mute failed (bot not admin etc.) — reset warns so user gets warning cycle again
      await Warn.updateOne({ userId: String(userId) }, { count: 2 }).catch(() => {});
      bot.sendMessage(chatId, `⚠️ Could not mute ${name} — make sure I'm an admin with restrict permissions.

⚠️ Warning *3/3* kept active.`, { parse_mode: 'Markdown' });
    }
  } else {
    bot.sendMessage(chatId,
`🚫 *No links allowed here, ${name}!*

⚠️ Warning *${warns}/3*
_${3 - warns} more warning${3 - warns === 1 ? '' : 's'} = 1 week mute_`,
      { parse_mode: 'Markdown' });
  }
});

/* ═══════════════════════════════════
   CLAIM FLOW
═══════════════════════════════════ */
bot.on('message', async (msg) => {
  const chatId  = msg.chat.id;
  const text    = (msg.text || '').trim();
  const session = sessions[chatId];
  if (!session || text.startsWith('/')) return;

  if (session.step === 'awaiting_ref') {
    const ref = text.toUpperCase();
    bot.sendMessage(chatId, '🔄 Verifying ref code...');
    const d = await apiCheck(ref);
    if (!d.ok) {
      log(msg, 'claim:ref_fail', `ref=${ref} err=${d.msg||'invalid'}`, 'fail');
      bot.sendMessage(chatId, `❌ *Invalid ref code.*\n\n${d.msg || ''}\n\nTry /claim again.`, { parse_mode: 'Markdown' });
      resetSession(chatId); return;
    }
    session.data.ref = ref;
    session.step = 'awaiting_email';
    await saveSession(chatId, session);
    log(msg, 'claim:ref_ok', `ref=${ref}`, 'ok');
    bot.sendMessage(chatId, `✅ *Ref code confirmed!*\n\n📧 Now send the *email* you want for this CPM2 account:`, { parse_mode: 'Markdown' });
    return;
  }

  if (session.step === 'awaiting_email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      bot.sendMessage(chatId, '⚠️ Invalid email. Try again:'); return;
    }
    session.data.email = text;
    session.step = 'awaiting_password';
    await saveSession(chatId, session);
    log(msg, 'claim:email_set', `email=${text}`, 'info');
    bot.sendMessage(chatId, `🔑 Now send a *password* for the account:\n_Minimum 6 characters_`, { parse_mode: 'Markdown' });
    return;
  }

  if (session.step === 'awaiting_password') {
    if (text.length < 6) {
      bot.sendMessage(chatId, '⚠️ Password must be at least 6 characters. Try again:'); return;
    }
    session.data.password = text;
    bot.sendMessage(chatId, '🔄 Setting up your account... hang tight ⚡');
    const price = parseInt(PRICE_COINS);
    const paidViaByuref = !!session.data.paidViaByuref;

    try {
      const d = await apiClaim(session.data.ref, session.data.email, session.data.password);
      if (!d.ok) {
        log(msg, 'claim:fail', `ref=${session.data.ref} err=${d.msg||'unknown'} refund=${paidViaByuref}`, 'fail');
        // Claim failed — only refund if coins were already taken (buyref path)
        await PendingRef.deleteOne({ userId: String(msg.from.id) }).catch(() => {});
        if (paidViaByuref) {
          await addCoins(msg.from.id, price);
          const refunded = await getUserWallet(msg.from.id);
          bot.sendMessage(chatId,
`❌ *Claim failed!*

📋 Error: ${d.msg || 'Something went wrong.'}

💰 Coins refunded: *${price}*
💳 New balance: *${refunded.balance}* coins

Try again with /buyref or contact admin.`,
            { parse_mode: 'Markdown' });
        } else {
          bot.sendMessage(chatId,
`❌ *Claim failed!*

📋 Error: ${d.msg || 'Something went wrong.'}

💰 No coins were deducted.

Try again with /claim or contact admin.`,
            { parse_mode: 'Markdown' });
        }
      } else {
        // Claim successful — deduct now if not already done via /buyref
        if (!paidViaByuref) {
          await removeCoins(msg.from.id, price);
        }
        await PendingRef.deleteOne({ userId: String(msg.from.id) }).catch(() => {});
        const updated = await getUserWallet(msg.from.id);
        log(msg, 'claim:success', `ref=${session.data.ref} email=${session.data.email} coins=${price}`, 'ok');
        // Update leaderboard stats on wallet
        await BotWallet.findOneAndUpdate(
          { userId: String(msg.from.id) },
          {
            $inc: { claims: 1 },
            $set: {
              username:    msg.from.username ? '@' + msg.from.username : '',
              displayName: msg.from.first_name || ''
            }
          },
          { upsert: true }
        ).catch(() => {});

        bot.sendMessage(chatId,
`╔══════════════════╗
  🎉  *ACCOUNT CLAIMED!*
╚══════════════════╝

📧 Email:
\`${session.data.email}\`

🔑 Password:
\`${session.data.password}\`

💰 Coins deducted: *${price}*
💳 Remaining balance: *${updated.balance}* coins

🎮 Log into CPM2 now and enjoy!
💾 _Save these credentials safely._`,
          { parse_mode: 'Markdown' });
      }
    } catch(e) {
      // Network error — only refund if coins were already taken
      log(msg, 'claim:network_error', `ref=${session.data.ref} refund=${paidViaByuref}`, 'fail');
      await PendingRef.deleteOne({ userId: String(msg.from.id) }).catch(() => {});
      if (paidViaByuref) {
        await addCoins(msg.from.id, price);
        bot.sendMessage(chatId, '❌ Network error. Your coins have been refunded. Contact admin.');
      } else {
        bot.sendMessage(chatId, '❌ Network error. No coins were deducted. Contact admin.');
      }
    }
    resetSession(chatId);
  }
});

/* ═══════════════════════════════════
   /referral — get personal referral link
═══════════════════════════════════ */
bot.onText(/^\/referral$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  log(msg, '/referral', '', 'info');

  try {
    const w       = await getUserWallet(userId, msg.from);
    if (!w) return bot.sendMessage(chatId, '❌ Use /start first.');

    const uname   = await getBotUsername();
    const refLink = 'https://t.me/' + uname + '?start=' + userId;
    const reward  = parseInt(process.env.REFERRAL_COINS) || 100;

    bot.sendMessage(chatId,
`╔══════════════════════╗
  🔗  *YOUR REFERRAL LINK*
╚══════════════════════╝

Share your bot link to earn coins:
${refLink}

💰 You earn *${reward} coins* per referral!
👥 Total referrals: *${w.referrals || 0}*
💳 Your balance: *${w.balance}* coins

📢 Also invite them to our group:
https://t.me/cpmfreeaccss

_Friend must tap your link and press Start to count._`,
      { parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🤖 Share Bot Link', url: refLink }],
            [{ text: '📢 Join Our Group',  url: 'https://t.me/cpmfreeaccss' }]
          ]
        }
      });
  } catch(e) {
    console.error('/referral error:', e.message);
    bot.sendMessage(chatId, '❌ Error: ' + e.message);
  }
});

/* ═══════════════════════════════════
   REF EXPIRY WATCHDOG
   Warns user at 20h, refunds coins if ref expires at 24h
═══════════════════════════════════ */
const WARN_AFTER_MS   = 20 * 60 * 60 * 1000; // 20h — send warning
const EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h — refund and release

setInterval(async () => {
  try {
    const now     = Date.now();
    const pending = await PendingRef.find({}).lean();

    for (const p of pending) {
      const age = now - new Date(p.createdAt).getTime();

      // ── Warn at 20h ──────────────────────────────────────────────────────
      if (age >= WARN_AFTER_MS && !p.notified) {
        await PendingRef.findOneAndUpdate({ userId: p.userId }, { $set: { notified: true } }).catch(() => {});
        const price = parseInt(PRICE_COINS);
        bot.sendMessage(p.userId,
`⚠️ *Ref Code Expiring Soon!*

🔑 Your ref: \`${p.ref}\`

You have *~4 hours* to use /claim before your ref expires and *${price} coins are refunded*.

➡️ Use /claim now to activate your account!`,
          { parse_mode: 'Markdown' }).catch(() => {});
      }

      // ── Expire at 24h — refund coins ─────────────────────────────────────
      if (age >= EXPIRE_AFTER_MS) {
        const price = parseInt(PRICE_COINS);
        await PendingRef.deleteOne({ userId: p.userId }).catch(() => {});
        await BotWallet.findOneAndUpdate(
          { userId: p.userId },
          { $inc: { balance: price, totalEarned: price } }
        ).catch(() => {});
        bot.sendMessage(p.userId,
`⏰ *Ref Code Expired*

Your ref \`${p.ref}\` has expired after 24 hours.
💰 *${price} coins have been refunded* to your wallet.

Use /buyref to get a new ref code anytime.`,
          { parse_mode: 'Markdown' }).catch(() => {});
        log({ from: { id: p.userId, username: '', first_name: '' } }, 'ref_expired', `ref=${p.ref} refunded=${price}`, 'info');
      }
    }
  } catch(e) {
    console.error('Expiry watchdog error:', e.message);
  }
}, 30 * 60 * 1000); // check every 30 minutes

/* ═══════════════════════════════════
   LOW STOCK ALERT
   DMs admin when available accounts drop below threshold
═══════════════════════════════════ */
const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD) || 5;
let lastStockCount = Infinity; // track previous count to avoid spam

async function checkStockLevel() {
  try {
    const accs = await apiAdminAccounts();
    const available = accs.filter(a => a.status === 'AVAILABLE').length;

    // Only alert when count drops to/below threshold (not repeatedly)
    if (available <= LOW_STOCK_THRESHOLD && available < lastStockCount) {
      const icon = available === 0 ? '🚨' : '⚠️';
      const msg  = available === 0
        ? `🚨 *OUT OF STOCK!*\n\nNo accounts available. Users cannot buy right now!\n\nAdd stock immediately.`
        : `⚠️ *Low Stock Alert*\n\nOnly *${available}* account${available === 1 ? '' : 's'} remaining!\n\nConsider adding more stock soon.`;

      for (const adminId of ADMIN_IDS) {
        bot.sendMessage(adminId, msg, { parse_mode: 'Markdown' }).catch(() => {});
      }
    }
    lastStockCount = available;
  } catch(e) {
    // API may be down — silent fail
  }
}

// Check stock every 15 minutes
setInterval(checkStockLevel, 15 * 60 * 1000);

/* ═══════════════════════════════════
   /antifarm — show suspicious referral activity
═══════════════════════════════════ */
bot.onText(/^\/antifarm$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  log(msg, '/antifarm', '', 'info');

  try {
    // Find users with high referrals but no payment or claims
    const suspicious = await BotWallet.find({
      referrals: { $gte: 3 },
      hasPaid:   false,
      claims:    0
    }).sort({ referrals: -1 }).limit(20).lean();

    if (!suspicious.length) {
      return bot.sendMessage(chatId, '✅ No suspicious referral activity detected.');
    }

    let text = `╔════════════════════╗
  🚨  *SUSPICIOUS ACTIVITY*
╚════════════════════╝

`;
    text += `Users with many referrals but 0 purchases/claims:

`;

    for (const u of suspicious) {
      const name = u.displayName || u.username || 'Unknown';
      text += `👤 *${name}* (\`${u.userId}\`)
`;
      text += `   🔗 Referrals: *${u.referrals}*  💰 Balance: *${u.balance}*  🎮 Claims: *${u.claims}*

`;
    }

    text += `_Use /ban <userId> to ban suspicious users._`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error: ' + e.message);
  }
});

/* ═══════════════════════════════════
   /stats — admin dashboard
═══════════════════════════════════ */
bot.onText(/^\/stats$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');
  log(msg, '/stats', '', 'info');
  bot.sendMessage(chatId, '🔄 Building dashboard...');

  try {
    const [
      totalUsers,
      totalWallets,
      coinsData,
      topHolder,
      topClaimer,
      topReferrer,
      recentLogs,
      claimsToday,
      pendingRefs,
      stockData
    ] = await Promise.all([
      BotUser.countDocuments(),
      BotWallet.countDocuments(),
      BotWallet.aggregate([{ $group: { _id: null, total: { $sum: '$balance' }, totalEarned: { $sum: '$totalEarned' } } }]),
      BotWallet.findOne().sort({ balance: -1 }).lean(),
      BotWallet.findOne().sort({ claims: -1 }).lean(),
      BotWallet.findOne().sort({ referrals: -1 }).lean(),
      CommandLog.find().sort({ _id: -1 }).limit(50).lean(),
      ActivityLog.countDocuments({ action: 'claim', result: 'ok', timestamp: { $gte: new Date(Date.now() - 86400000) } }).catch(() => 0),
      PendingRef.countDocuments(),
      apiAdminAccounts().then(a => ({ available: a.filter(x => x.status === 'AVAILABLE').length, total: a.length })).catch(() => ({ available: '?', total: '?' }))
    ]);

    const totalCoins   = coinsData[0]?.total || 0;
    const totalEarned  = coinsData[0]?.totalEarned || 0;
    const richName     = topHolder ? (topHolder.displayName || topHolder.username || `User ${String(topHolder.userId).slice(-4)}`) : 'N/A';
    const claimerName  = topClaimer ? (topClaimer.displayName || topClaimer.username || `User ${String(topClaimer.userId).slice(-4)}`) : 'N/A';

    // Count commands in recent logs
    const cmdCounts = {};
    recentLogs.forEach(l => { cmdCounts[l.command] = (cmdCounts[l.command] || 0) + 1; });
    const topCmds = Object.entries(cmdCounts).sort((a,b) => b[1]-a[1]).slice(0,3).map(([c,n]) => `/${c} ×${n}`).join('  ');

    const refName = topReferrer ? (topReferrer.displayName || topReferrer.username || `User ${String(topReferrer.userId).slice(-4)}`) : 'N/A';
    const now = new Date();
    bot.sendMessage(chatId,
`╔══════════════════════╗
  📊  *STATS DASHBOARD*
╚══════════════════════╝

👥 *Users*
├ Registered: *${totalUsers}*
├ Wallets: *${totalWallets}*
└ Pending refs: *${pendingRefs}*

💰 *Coins*
├ In circulation: *${totalCoins.toLocaleString()}*
├ All-time issued: *${totalEarned.toLocaleString()}*
└ Avg per user: *${totalWallets ? Math.round(totalCoins/totalWallets) : 0}*

📦 *Stock*
├ Available accounts: *${stockData.available}* / ${stockData.total}
└ ${stockData.available <= LOW_STOCK_THRESHOLD ? '⚠️ LOW STOCK!' : '✅ Stock OK'}

🏆 *Top Users*
├ 💰 Richest: *${richName}* (${topHolder?.balance || 0} coins)
├ 🎮 Most Claims: *${claimerName}* (${topClaimer?.claims || 0})
└ 🔗 Top Referrer: *${refName}* (${topReferrer?.referrals || 0} refs)

📈 *Activity*
├ Claims today: *${claimsToday}*
└ Top commands: ${topCmds || 'N/A'}

🕐 _${now.toUTCString()}_`,
      { parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '💳 All Wallets', callback_data: 'adm_wallets' }, { text: '📋 Accounts', callback_data: 'adm_list' }],
          [{ text: '📊 Stock',       callback_data: 'adm_stock'   }, { text: '📈 Log Stats', callback_data: 'adm_logstats' }]
        ]}
      });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error building stats: ' + e.message);
  }
});

/* ═══════════════════════════════════
   /dm — send a DM to any user (admin)
═══════════════════════════════════ */
bot.onText(/^\/dm (@?\S+) (.+)$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const { userId, targetName, err } = await resolveTarget(msg, match[1]);
  if (err) return bot.sendMessage(chatId, '❌ ' + err);
  const message = match[2].trim();

  try {
    await bot.sendMessage(userId,
`📩 *Message from Admin*\n\n${message}`,
      { parse_mode: 'Markdown' });
    log(msg, '/dm', `to=${userId} msg="${message.substring(0,40)}"`, 'ok');
    bot.sendMessage(chatId,
`✅ *DM Sent!*

👤 To: ${targetName}
🆔 ID: \`${userId}\`
📩 _"${message.substring(0,60)}${message.length > 60 ? '…' : ''}"_`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, `❌ Could not DM that user. They may not have started the bot.\n\`${e.message}\``, { parse_mode: 'Markdown' });
  }
});


/* ═══════════════════════════════════
   STARTUP
═══════════════════════════════════ */
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB connected');
    // Load known users
    const users = await BotUser.find().catch(() => []);
    users.forEach(u => knownUsers.add(u.chatId));
    console.log(`👥 Loaded ${knownUsers.size} known user(s)`);
    // Load schedules
    await loadSchedules();
    // Restore sessions from DB (survive restarts)
    const savedSessions = await SessionStore.find().catch(() => []);
    savedSessions.forEach(s => { sessions[s.chatId] = { step: s.step, data: s.data }; });
    if (savedSessions.length) console.log(`🔄 Restored ${savedSessions.length} session(s) from DB`);
    console.log('🤖 Kalypo Mods Telegram bot is running...');
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    console.log('🤖 Bot starting without DB persistence...');
  });
