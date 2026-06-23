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
const BOT_TOKEN   = process.env.BOT_TOKEN  || '8645097113:AAHhYO7AFy6dWLZVqVIUXicy5yVoeVR4zWI';
const SERVER_URL  = process.env.SERVER_URL || 'https://kalypo-mods.onrender.com';
const ADMIN_KEY   = process.env.ADMIN_KEY  || '990';
const ADMIN_IDS   = (process.env.ADMIN_TELEGRAM_IDS || '7564594071').split(',').map(s => s.trim()).filter(Boolean);
const PRICE_COINS = process.env.PRICE_COINS || '500';
const MONGO_URI   = process.env.MONGODB_URI || 'mongodb+srv://rm1402678_db_user:52q7DBT4rJAE786p@cluster0.t0auzso.mongodb.net/kalypo?appName=Cluster0';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || '-1003787424518';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

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
  claims:      { type: Number, default: 0 }   // successful claims
});
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
  createdAt: { type: Date, default: Date.now, expires: 3600 } // auto-expire after 1 h
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

async function getUserWallet(userId) {
  try {
    let w = await BotWallet.findOne({ userId: String(userId) });
    if (!w) w = await BotWallet.create({ userId: String(userId), balance: 0 });
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
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Check if banned
  if (msg.chat.type === 'private') {
    const banned = await isBanned(msg.from.id);
    if (banned) {
      bot.sendMessage(chatId, '🚫 You have been banned from using this bot.');
      return;
    }
    saveUser(msg.from.id);
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

💰 Price: *${PRICE_COINS} Coins* per account

┌─────────────────────┐
│  📌  *HOW TO ORDER*      │
├─────────────────────┤
│ 1️⃣  Pay (use /pay)        │
│ 2️⃣  Get your ref code    │
│ 3️⃣  Use /claim to go! 🚀 │
└─────────────────────┘

📟 Type /menu to see all commands`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/help$/, (msg) => bot.emit('text', { ...msg, text: '/start' }));

bot.onText(/^\/pay$/, (msg) => {
  log(msg, '/pay', '', 'info');
  bot.sendMessage(msg.chat.id,
`╔══════════════════╗
   💳  *HOW TO PAY*  💳
╚══════════════════╝

Send *${PRICE_COINS} Coins* worth of payment
via your preferred method.

📸 Send *proof of payment* to the admin here.

┌────────────────────┐
│ ✅ Admin confirms     │
│ 🔑 You get a ref code │
│ 🎮 Use /claim         │
└────────────────────┘`,
    { parse_mode: 'Markdown' }
  );
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
  const w = await getUserWallet(userId);
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

bot.onText(/^\/wallets$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  bot.sendMessage(chatId, '🔄 Loading wallets...');
  try {
    const wallets = await BotWallet.find().sort({ balance: -1 }).limit(50).catch(() => []);
    if (!wallets.length) return bot.sendMessage(chatId, '📭 No wallets yet.');

    let text = `╔════════════════════╗\n  💰  *ALL USER WALLETS*\n╚════════════════════╝\n\n`;
    text += `Total users: *${wallets.length}*\n\n`;
    
    wallets.forEach((w, i) => {
      text += `${i + 1}. 👤 \`${w.userId}\`\n   💳 *${w.balance}* coins\n\n`;
    });

    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error.');
  }
});



/* ═══════════════════════════════════
   ADMIN WALLET COMMANDS
═══════════════════════════════════ */
// /gc <amount>        — reply to someone's message to give them coins
// /gc <userId> <amount> — explicit userId (works anywhere)
bot.onText(/^\/gc(?: (\d+))? (\d+)$/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const inGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (!ADMIN_IDS.includes(String(msg.from.id))) {
    if (!inGroup) bot.sendMessage(chatId, '🚫 Admin only.');
    return;
  }

  // Resolve target userId:
  // - If replying to a message → use that user's ID
  // - If first capture group present → use it as userId
  // - Otherwise invalid
  let userId, targetName;
  if (msg.reply_to_message) {
    const sender = msg.reply_to_message.from;
    if (!sender || sender.is_bot) {
      if (!inGroup) bot.sendMessage(chatId, '❌ Can\'t give coins to a bot.');
      return;
    }
    userId     = String(sender.id);
    targetName = sender.username ? `@${sender.username}` : sender.first_name;
  } else if (match[1]) {
    userId     = match[1];
    targetName = `\`${userId}\``;
  } else {
    if (!inGroup) bot.sendMessage(chatId, '❌ Either reply to someone\'s message or use /gc <userId> <amount>');
    return;
  }

  const amount = parseInt(match[2]);
  if (amount <= 0) return;

  try {
    await CommandLog.create({
      userId: String(msg.from.id),
      username: msg.from.username || msg.from.first_name || 'Unknown',
      command: 'gc',
      params: { targetUserId: userId, amount }
    }).catch(() => {});

    const w = await addCoins(userId, amount);
    if (!w) {
      if (!inGroup) bot.sendMessage(chatId, '❌ Error updating balance.');
      return;
    }
    // Save target's display name if we got it from reply
    if (msg.reply_to_message?.from) {
      const t = msg.reply_to_message.from;
      await BotWallet.findOneAndUpdate(
        { userId: String(userId) },
        { $set: { username: t.username ? '@'+t.username : '', displayName: t.first_name||'' } }
      ).catch(() => {});
    }

    if (inGroup) {
      // Delete the admin's command message
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});

      // Try DM first, fall back to a self-destructing group reply only you can see
      const confirmText =
`✅ *Done (silent)*

👤 User: ${targetName}
🆔 ID: \`${userId}\`
➕ Added: *${amount}* coins
💰 New Balance: *${w.balance}* coins`;

      const dmSent = await bot.sendMessage(msg.from.id, confirmText, { parse_mode: 'Markdown' })
        .then(() => true)
        .catch(() => false);

      if (!dmSent) {
        // DM failed (haven't started bot in DM) — send in group, auto-delete after 6s
        const tempMsg = await bot.sendMessage(chatId, confirmText, {
          parse_mode: 'Markdown',
          disable_notification: true
        }).catch(() => null);
        if (tempMsg) {
          setTimeout(() => bot.deleteMessage(chatId, tempMsg.message_id).catch(() => {}), 6000);
        }
      }
    } else {
      bot.sendMessage(chatId,
`✅ *Coins added!*

👤 User: ${targetName}
🆔 ID: \`${userId}\`
➕ Added: *${amount}* coins
💰 New Balance: *${w.balance}* coins`,
        { parse_mode: 'Markdown' });
    }
  } catch(e) {
    if (!inGroup) bot.sendMessage(chatId, '❌ Error: ' + e.message);
  }
});

bot.onText(/^\/removecoins (\d+) (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const userId = match[1];
  const amount = parseInt(match[2]);

  if (amount <= 0) return bot.sendMessage(chatId, '❌ Amount must be positive.');

  const w = await removeCoins(userId, amount);
  if (!w) { log(msg, '/removecoins', `target=${userId} amount=${amount} FAIL`, 'fail'); return bot.sendMessage(chatId, `❌ User doesn't have enough coins or doesn't exist.`); }
  log(msg, '/removecoins', `target=${userId} amount=${amount} newbal=${w.balance}`, 'ok');
  bot.sendMessage(chatId,
`✅ *Coins removed!*

👤 User: \`${userId}\`
➖ Removed: *${amount}* coins
💰 New Balance: *${w.balance}* coins`,
    { parse_mode: 'Markdown' });
});

/* ═══════════════════════════════════
   /buyref — buy a ref code with coins
   Coins are deducted IMMEDIATELY and the ref is reserved to this user.
   If /claim fails later the coins are refunded automatically.
═══════════════════════════════════ */
bot.onText(/^\/buyref$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const price = parseInt(PRICE_COINS);

  // Check if user already has a pending reserved ref
  const existing = await PendingRef.findOne({ userId: String(userId) }).catch(() => null);
  if (existing) {
    return bot.sendMessage(chatId,
`⚠️ *You already have a reserved ref!*

🔑 Your Ref Code:
\`${existing.ref}\`

➡️ Use /claim to activate it.
_If you need a new one, use /claim first or contact admin._`,
      { parse_mode: 'Markdown' });
  }

  const w = await getUserWallet(userId);
  if (!w || w.balance < price) {
    log(msg, '/buyref', `insufficient coins bal=${w?w.balance:0}`, 'fail');
    return bot.sendMessage(chatId,
`❌ *Insufficient coins!*

💰 Your balance: *${w ? w.balance : 0}* coins
💵 Required: *${price}* coins
📉 Deficit: *${price - (w ? w.balance : 0)}* coins

Contact admin to buy coins.`,
      { parse_mode: 'Markdown' });
  }

  try {
    const accs = await apiAdminAccounts();
    const free = accs.find(a => a.status === 'AVAILABLE');
    if (!free) { log(msg, '/buyref', 'no stock available', 'fail'); return bot.sendMessage(chatId, '❌ No accounts available right now. Try again soon.'); }

    // Deduct coins NOW before showing the ref
    const deducted = await removeCoins(userId, price);
    if (!deducted) return bot.sendMessage(chatId, '❌ Failed to deduct coins. Try again.');

    // Reserve this ref for this user (upsert in case of retry edge case)
    await PendingRef.findOneAndUpdate(
      { userId: String(userId) },
      { userId: String(userId), ref: free.ref },
      { upsert: true, new: true }
    ).catch(() => {});

    log(msg, '/buyref', `ref=${free.ref} coins=${price}`, 'ok');
    bot.sendMessage(chatId,
`✅ *Ref code purchased!*

🔑 Your Ref Code:
\`${free.ref}\`

💰 Coins deducted: *${price}*
💳 Remaining balance: *${deducted.balance}* coins

➡️ Use /claim to activate your account.
_Your ref is reserved for you. Coins are refunded if claim fails._`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error. No coins were deducted.');
  }
});

/* ═══════════════════════════════════
   ADMIN COMMANDS
═══════════════════════════════════ */
bot.onText(/^\/approve (.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const targetUserId = match[1].trim();
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
👤 Reserved for: \`${targetUserId}\`
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
  const admin = isAdmin(msg);
  log(msg, '/menu', '', 'info');
  bot.sendMessage(chatId,
`╔════════════════════╗
  📟  *KALYPO MODS MENU*  📟
╚════════════════════╝

👤 *CUSTOMER COMMANDS*
┌──────────────────────────┐
│ 🏠 /start      — welcome screen        │
│ 💳 /pay        — payment info           │
│ 🪙 /wallet     — check coin balance    │
│ 🔑 /buyref     — buy ref code          │
│ 🎮 /claim      — activate account      │
│ 📟 /menu       — show this menu        │
│ 🪪 /myid       — your Telegram ID      │
│ 🏆 /top        — coin leaderboard      │
│ 🏅 /rank       — your rank & stats     │
└──────────────────────────┘${admin ? `

🔐 *ADMIN COMMANDS*
┌──────────────────────────┐
│ ➖ /removecoins <id> <amt> — remove coins │
│ 💳 /wallets                 — all wallets    │
│ 📋 /list                    — all accounts  │
│ 🟡 /pending                — reserved      │
│ 📊 /stock                  — stock status  │
│ ✅ /approve <id>          — give ref      │
│ 🔄 /reset <ref>           — reset account │
│ 📢 /broadcast <msg>       — DM all users  │
│ 📅 /schedule <time> <msg> — daily msg     │
│ 🗑️ /unschedule <time>     — cancel        │
│ 📋 /schedules             — list active   │
│ 📊 /logs [n/fail/ok/id]  — activity log  │
│ 📈 /logstats              — log summary   │
└──────────────────────────┘

👥 *Users tracked:* ${knownUsers.size}
🔐 *Admin:* ${admin ? 'Yes ✅' : 'No'}` : ''}`,
    { parse_mode: 'Markdown' }
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
   Inline keyboard (list pagination)
───────────────────────────────── */
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  bot.answerCallbackQuery(query.id).catch(() => {});
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
bot.onText(/^\/top(?: (coins|claims))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const mode = (match[1] || 'coins').toLowerCase();
  log(msg, '/top', mode, 'info');

  try {
    const sortField = mode === 'claims' ? { claims: -1 } : { balance: -1 };
    const top = await BotWallet.find().sort(sortField).limit(10).catch(() => []);

    if (!top.length) return bot.sendMessage(chatId, '📭 No leaderboard data yet.');

    const title = mode === 'claims' ? '🏆 TOP CLAIMERS' : '💰 TOP COIN HOLDERS';
    let text = `╔════════════════════╗\n  ${title}\n╚════════════════════╝\n\n`;

    top.forEach((w, i) => {
      const medal  = MEDALS[i] || `${i+1}.`;
      const name   = w.displayName || w.username || `User ${w.userId.slice(-4)}`;
      const handle = w.username ? ` (${w.username})` : '';
      const value  = mode === 'claims'
        ? `*${w.claims || 0}* claims`
        : `*${w.balance}* coins`;
      text += `${medal} ${name}${handle}\n   ${value}\n\n`;
    });

    text += `_Updated live · /top claims for claim ranks_`;
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Error loading leaderboard.');
  }
});

// /rank — show your own rank
bot.onText(/^\/rank$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  log(msg, '/rank', '', 'info');

  try {
    const w = await getUserWallet(userId);
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
