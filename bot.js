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
  userId:  { type: String, unique: true },
  balance: { type: Number, default: 0 }
});
const BotWallet = mongoose.model('BotWallet', BotWalletSchema);

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
  return ADMIN_IDS.includes(String(msg.from.id)) || ADMIN_IDS.includes(String(msg.chat.id));
}
function resetSession(chatId) { delete sessions[chatId]; }

function statusEmoji(s) {
  return { AVAILABLE: '🟢', TAKEN: '🔴', RESERVED: '🟡', INVALID: '⛔' }[s] || '⚪';
}

async function saveUser(chatId) {
  knownUsers.add(chatId);
  await BotUser.updateOne({ chatId: String(chatId) }, { chatId: String(chatId) }, { upsert: true }).catch(() => {});
}

async function getUserWallet(userId) {
  let w = await BotWallet.findOne({ userId: String(userId) }).catch(() => null);
  if (!w) w = await BotWallet.create({ userId: String(userId), balance: 0 }).catch(() => null);
  return w;
}

async function addCoins(userId, amount) {
  return BotWallet.findOneAndUpdate(
    { userId: String(userId) },
    { $inc: { balance: amount } },
    { upsert: true, new: true }
  ).catch(() => null);
}

async function removeCoins(userId, amount) {
  const w = await BotWallet.findOne({ userId: String(userId) }).catch(() => null);
  if (!w || w.balance < amount) return null;
  return BotWallet.findOneAndUpdate(
    { userId: String(userId) },
    { $inc: { balance: -amount } },
    { new: true }
  ).catch(() => null);
}

async function getWallet(chatId) {
  let w = await BotWallet.findOne({ chatId: String(chatId) }).catch(() => null);
  if (!w) w = await BotWallet.create({ chatId: String(chatId), balance: 0, history: [] }).catch(() => null);
  return w;
}
async function addCoins(chatId, amount, note) {
  const w = await getWallet(chatId);
  if (!w) return null;
  w.balance = +(w.balance + amount).toFixed(2);
  w.history.push({ type: 'credit', amount, note, at: new Date().toISOString() });
  await w.save().catch(() => {});
  return w;
}
async function deductCoins(chatId, amount, note) {
  const w = await getWallet(chatId);
  if (!w || w.balance < amount) return null;
  w.balance = +(w.balance - amount).toFixed(2);
  w.history.push({ type: 'debit', amount, note, at: new Date().toISOString() });
  await w.save().catch(() => {});
  return w;
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
  const r = await fetch(`${SERVER_URL}/api/check/${encodeURIComponent(ref)}`);
  return r.json();
}
async function apiClaim(ref, newEmail, newPassword) {
  const r = await fetch(`${SERVER_URL}/api/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, newEmail, newPassword })
  });
  return r.json();
}
async function apiAdminAccounts() {
  const r = await fetch(`${SERVER_URL}/api/admin/accounts`, { headers: { 'x-admin-key': ADMIN_KEY } });
  return r.json();
}
async function apiAdminStats() {
  const r = await fetch(`${SERVER_URL}/api/admin/stats`, { headers: { 'x-admin-key': ADMIN_KEY } });
  return r.json();
}
async function apiAdminReset(ref) {
  const r = await fetch(`${SERVER_URL}/api/admin/reset/${encodeURIComponent(ref)}`, {
    method: 'POST', headers: { 'x-admin-key': ADMIN_KEY }
  });
  return r.json();
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

/* ═══════════════════════════════════
   AUTO REACT + USER TRACKING
═══════════════════════════════════ */
bot.on('message', (msg) => {
  // Only save private chat users for broadcast
  if (msg.chat && msg.chat.type === 'private') saveUser(msg.chat.id);
  if (!msg.text) return;
  bot.setMessageReaction(msg.chat.id, msg.message_id, {
    reaction: [{ type: 'emoji', emoji: nextEmoji() }]
  }).catch(() => {});
});

/* ═══════════════════════════════════
   CUSTOMER COMMANDS
═══════════════════════════════════ */
bot.onText(/^\/start$/, (msg) => {
  const chatId = msg.chat.id;
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
    if (!d.ok) return bot.sendMessage(chatId, `❌ *Invalid ref code.*\n\n${d.msg || 'Not recognised.'}`, { parse_mode: 'Markdown' });

    // Also verify CPM2 login works
    const accs = await apiAdminAccounts();
    const acc = Array.isArray(accs) ? accs.find(a => a.ref === ref) : null;
    if (acc && acc.email && acc.password) {
      const loginCheck = await cpm2Login(acc.email, acc.password);
      if (!loginCheck.ok) {
        return bot.sendMessage(chatId,
`⚠️ *Ref found but account has issues*

🔑 \`${ref}\`
❌ CPM2 login failed: ${loginCheck.msg}

Contact admin to fix this account.`,
          { parse_mode: 'Markdown' });
      }
    }

    bot.sendMessage(chatId,
`✅ *Ref code valid!*

🔑 \`${ref}\`
🟢 Status: Available
🎮 CPM2 account verified ✓

➡️ Use /claim to activate it.`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error. Try again later.');
  }
});

bot.onText(/^\/claim$/, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: 'awaiting_ref', data: {} };
  bot.sendMessage(chatId,
`🎮 *Claim Your Account*

Send your *ref code* below:
_(e.g. KAL-49TEX8)_`,
    { parse_mode: 'Markdown' });
});

/* ═══════════════════════════════════
   CUSTOMER WALLET COMMANDS
═══════════════════════════════════ */
bot.onText(/^\/wallet$/, async (msg) => {
  const chatId = msg.chat.id;
  const w = await getUserWallet(msg.from.id);
  bot.sendMessage(chatId,
`╔══════════════════╗
  💰  *YOUR WALLET*  💰
╚══════════════════╝

🪙 Balance: *${w ? w.balance : 0} Coins*
💵 Account Price: *${PRICE_COINS} Coins*

${w && w.balance >= PRICE_COINS ? '✅ You have enough to claim!' : '❌ Not enough coins. Contact admin to buy coins.'}`,
    { parse_mode: 'Markdown' });
});

/* ═══════════════════════════════════
   ADMIN WALLET COMMANDS
═══════════════════════════════════ */
bot.onText(/^\/addcoins (\d+) (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const userId = match[1];
  const amount = parseInt(match[2]);

  if (amount <= 0) return bot.sendMessage(chatId, '❌ Amount must be positive.');

  const w = await addCoins(userId, amount);
  if (!w) return bot.sendMessage(chatId, '❌ Error adding coins.');

  bot.sendMessage(chatId,
`✅ *Coins added!*

👤 User: \`${userId}\`
➕ Added: *${amount}* coins
💰 New Balance: *${w.balance}* coins`,
    { parse_mode: 'Markdown' });
});

bot.onText(/^\/removecoins (\d+) (\d+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const userId = match[1];
  const amount = parseInt(match[2]);

  if (amount <= 0) return bot.sendMessage(chatId, '❌ Amount must be positive.');

  const w = await removeCoins(userId, amount);
  if (!w) return bot.sendMessage(chatId, `❌ User doesn't have enough coins or doesn't exist.`);

  bot.sendMessage(chatId,
`✅ *Coins removed!*

👤 User: \`${userId}\`
➖ Removed: *${amount}* coins
💰 New Balance: *${w.balance}* coins`,
    { parse_mode: 'Markdown' });
});

/* ═══════════════════════════════════
   /buyref — buy a ref code with coins
═══════════════════════════════════ */
bot.onText(/^\/buyref$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const price = parseInt(PRICE_COINS);

  const w = await getUserWallet(userId);
  if (!w || w.balance < price) {
    return bot.sendMessage(chatId,
`❌ *Insufficient coins!*

💰 Your balance: *${w ? w.balance : 0}* coins
💵 Required: *${price}* coins
📉 Deficit: *${parseInt(price) - (w ? w.balance : 0)}* coins

Contact admin to buy coins.`,
      { parse_mode: 'Markdown' });
  }

  try {
    const accs = await apiAdminAccounts();
    const free = accs.find(a => a.status === 'AVAILABLE');
    if (!free) return bot.sendMessage(chatId, '❌ No accounts available right now.');

    // Deduct coins immediately
    await removeCoins(userId, price);
    const updated = await getUserWallet(userId);

    bot.sendMessage(chatId,
`✅ *Ref code purchased!*

🔑 Your Ref Code:
\`${free.ref}\`

💰 Coins deducted: *${price}*
💳 New balance: *${updated.balance}* coins

➡️ Use /claim to activate this account.`,
      { parse_mode: 'Markdown' });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error.');
  }
});

/* ═══════════════════════════════════
   ADMIN COMMANDS
═══════════════════════════════════ */
bot.onText(/^\/approve (.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  const targetUserId = match[1].trim();
  bot.sendMessage(chatId, '🔄 Finding a free account...');
  try {
    const accs = await apiAdminAccounts();
    if (accs.error) return bot.sendMessage(chatId, '❌ ' + accs.error);
    const free = accs.find(a => a.status === 'AVAILABLE');
    if (!free) return bot.sendMessage(chatId, '❌ No accounts available right now.');

    bot.sendMessage(chatId,
`✅ *Approved!*

🔑 Ref: \`${free.ref}\`
Send this ref to the customer.`,
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
    bot.sendMessage(chatId, d.ok ? `✅ ${d.msg}` : `❌ ${d.msg}`);
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error.');
  }
});

bot.onText(/^\/myid$/, (msg) => {
  bot.sendMessage(msg.chat.id,
`🪪 *Your IDs*

👤 User ID:  \`${msg.from.id}\`
💬 Chat ID:  \`${msg.chat.id}\``,
    { parse_mode: 'Markdown' });
});

bot.onText(/^\/menu$/, (msg) => {
  const chatId = msg.chat.id;
  const admin = isAdmin(msg);
  bot.sendMessage(chatId,
`╔════════════════════╗
  📟  *KALYPO MODS MENU*  📟
╚════════════════════╝

👤 *CUSTOMER COMMANDS*
┌──────────────────────┐
│ 🏠 /start   — welcome screen    │
│ 💳 /pay     — payment info       │
│ 🔍 /check   — verify ref code   │
│ 🎮 /claim   — activate account  │
│ 📟 /menu    — show this menu    │
└──────────────────────┘${admin ? `

🔐 *ADMIN COMMANDS*
┌──────────────────────┐
│ 📋 /list                — all accounts        │
│ 🟡 /pending          — reserved only       │
│ 📊 /stock             — stock summary      │
│ ✅ /approve <id>   — approve payment   │
│ 🔄 /reset <ref>     — reset account       │
│ 📢 /broadcast       — DM all users        │
│ 📅 /schedule        — set daily message  │
│ 🗑 /unschedule     — cancel schedule     │
│ 📋 /schedules       — list schedules      │
│ 🪪 /myid             — your Telegram ID   │
└──────────────────────┘

👥 *Users tracked:* ${knownUsers.size}` : ''}`,
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
      setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => {}), 30000);
    });
  });
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
      bot.sendMessage(chatId, `⚠️ Could not mute ${name} — make sure I'm an admin with restrict permissions.`);
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
      bot.sendMessage(chatId, `❌ *Invalid ref code.*\n\n${d.msg || ''}\n\nTry /claim again.`, { parse_mode: 'Markdown' });
      resetSession(chatId); return;
    }
    session.data.ref = ref;
    session.step = 'awaiting_email';
    bot.sendMessage(chatId, `✅ *Ref code confirmed!*\n\n📧 Now send the *email* you want for this CPM2 account:`, { parse_mode: 'Markdown' });
    return;
  }

  if (session.step === 'awaiting_email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      bot.sendMessage(chatId, '⚠️ Invalid email. Try again:'); return;
    }
    session.data.email = text;
    session.step = 'awaiting_password';
    bot.sendMessage(chatId, `🔑 Now send a *password* for the account:\n_Minimum 6 characters_`, { parse_mode: 'Markdown' });
    return;
  }

  if (session.step === 'awaiting_password') {
    if (text.length < 6) {
      bot.sendMessage(chatId, '⚠️ Password must be at least 6 characters. Try again:'); return;
    }
    session.data.password = text;
    bot.sendMessage(chatId, '🔄 Setting up your account... hang tight ⚡');
    try {
      const d = await apiClaim(session.data.ref, session.data.email, session.data.password);
      if (!d.ok) {
        // Login failed — refund coins
        const price = parseInt(PRICE_COINS);
        await addCoins(msg.from.id, price);
        const refunded = await getUserWallet(msg.from.id);
        bot.sendMessage(chatId,
`❌ *Claim failed!*

📋 Error: ${d.msg || 'Something went wrong.'}

💰 Coins refunded: *${price}*
💳 New balance: *${refunded.balance}* coins

Try another ref code or contact admin.`,
          { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId,
`╔══════════════════╗
  🎉  *ACCOUNT CLAIMED!*
╚══════════════════╝

📧 Email:
\`${session.data.email}\`

🔑 Password:
\`${session.data.password}\`

🎮 Log into CPM2 now and enjoy!
💾 _Save these credentials safely._`,
          { parse_mode: 'Markdown' });
      }
    } catch(e) {
      // Network error — refund coins
      const price = parseInt(PRICE_COINS);
      await addCoins(msg.from.id, price);
      bot.sendMessage(chatId, '❌ Network error. Coins refunded. Contact admin.');
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
    console.log('🤖 Kalypo Mods Telegram bot is running...');
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    console.log('🤖 Bot starting without DB persistence...');
  });
