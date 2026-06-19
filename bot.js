const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

/* Render keepalive */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Kalypo Mods bot is running.');
}).listen(PORT, () => console.log(`🌐 Health check listener on port ${PORT}`));

/* ═══════════════════════════════════
   CONFIG
═══════════════════════════════════ */
const BOT_TOKEN  = process.env.BOT_TOKEN  || '8645097113:AAHhYO7AFy6dWLZVqVIUXicy5yVoeVR4zWI';
const SERVER_URL = process.env.SERVER_URL || 'https://kalypo-mods.onrender.com';
const ADMIN_KEY  = process.env.ADMIN_KEY  || 'kalypo-admin-2024';
const ADMIN_IDS  = (process.env.ADMIN_TELEGRAM_IDS || '7564594071').split(',').map(s => s.trim()).filter(Boolean);
const PRICE_COINS = process.env.PRICE_COINS || '500';

if (!BOT_TOKEN || !SERVER_URL || !ADMIN_KEY) {
  console.error('❌ Missing required env vars: BOT_TOKEN, SERVER_URL, ADMIN_KEY');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* ═══════════════════════════════════
   STATE
═══════════════════════════════════ */
const sessions  = {};  // chatId -> { step, data }
const listState = {};  // chatId -> { accounts, page, filter }
const PAGE_SIZE = 10;

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
  console.log('isAdmin check:', msg.from.id, ADMIN_IDS);
  return ADMIN_IDS.includes(String(msg.from.id)) || ADMIN_IDS.includes(String(msg.chat.id));
}
function resetSession(chatId) { delete sessions[chatId]; }

function statusEmoji(s) {
  return { AVAILABLE: '🟢', TAKEN: '🔴', RESERVED: '🟡', INVALID: '⛔' }[s] || '⚪';
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
  if (page > 0)              buttons.push({ text: '⬅️ Prev', callback_data: `list_prev` });
  if (page + 1 < totalPages) buttons.push({ text: 'Next ➡️', callback_data: `list_next` });

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
   AUTO REACT — fires on every message
═══════════════════════════════════ */
bot.on('message', (msg) => {
  if (!msg.text) return; // skip media-only messages silently
  bot.setMessageReaction(msg.chat.id, msg.message_id, {
    reaction: [{ type: 'emoji', emoji: nextEmoji() }]
  }).catch(() => {}); // silently ignore if bot lacks permission
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

📟 *Commands*
• /pay — payment info
• /check \`<ref>\` — verify a ref
• /claim — activate your account
• /help — show this menu`,
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
    if (d.ok) {
      bot.sendMessage(chatId,
`✅ *Ref code valid!*

🔑 \`${ref}\`
🟢 Status: Available

➡️ Use /claim to activate it.`,
        { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, `❌ *Invalid ref code.*\n\n${d.msg || 'This code is not recognised.'}`, { parse_mode: 'Markdown' });
    }
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
      ).catch(() => {
        bot.sendMessage(chatId, '⚠️ Could not DM that user. Send the ref manually.');
      });
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

/* ─────────────────────────────────
   /list — paginated account list (admin)
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

    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error.');
  }
});

/* ─────────────────────────────────
   /pending — reserved accounts only (admin)
───────────────────────────────── */
bot.onText(/^\/pending$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) return bot.sendMessage(chatId, '🚫 Admin only.');

  bot.sendMessage(chatId, '🔄 Loading pending accounts...');
  try {
    const accs = await apiAdminAccounts();
    if (accs.error) return bot.sendMessage(chatId, '❌ ' + accs.error);

    const pending = accs.filter(a => a.status === 'RESERVED');
    if (!pending.length) return bot.sendMessage(chatId, '✅ No pending (reserved) accounts right now.');

    listState[chatId] = { accounts: pending, page: 0, filter: 'pending' };
    const { text, buttons } = buildListPage(pending, 0);

    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: buttons.length ? { inline_keyboard: [buttons] } : undefined
    });
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error.');
  }
});

/* ─────────────────────────────────
   Inline keyboard callbacks (list pagination)
───────────────────────────────── */
bot.on('callback_query', async (query) => {
  const chatId  = query.message.chat.id;
  const msgId   = query.message.message_id;
  const data    = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});

  if (!listState[chatId]) return;

  let { accounts, page, filter } = listState[chatId];

  if (data === 'list_next') page++;
  else if (data === 'list_prev') page--;
  else if (data === 'list_pending') {
    try {
      const accs = await apiAdminAccounts();
      accounts = accs.filter(a => a.status === 'RESERVED');
      filter = 'pending';
      page = 0;
      if (!accounts.length) {
        return bot.editMessageText('✅ No pending accounts right now.', { chat_id: chatId, message_id: msgId });
      }
    } catch(e) { return; }
  } else if (data === 'list_all') {
    try {
      accounts = await apiAdminAccounts();
      filter = 'all';
      page = 0;
    } catch(e) { return; }
  }

  listState[chatId] = { accounts, page, filter };
  const { text, buttons, totalPages } = buildListPage(accounts, page);

  const keyboard = [];
  if (buttons.length) keyboard.push(buttons);
  keyboard.push([{ text: '🟡 Pending Only', callback_data: 'list_pending' }, { text: '📋 All', callback_data: 'list_all' }]);

  bot.editMessageText(text, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  }).catch(() => {});
});

/* ═══════════════════════════════════
   CONVERSATIONAL CLAIM FLOW
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
      bot.sendMessage(chatId, `❌ *Invalid ref code.*\n\n${d.msg || ''}\n\nTry /claim again with a valid code.`, { parse_mode: 'Markdown' });
      resetSession(chatId);
      return;
    }
    session.data.ref = ref;
    session.step = 'awaiting_email';
    bot.sendMessage(chatId,
`✅ *Ref code confirmed!*

📧 Now send the *email* you want for this CPM2 account:`,
      { parse_mode: 'Markdown' });
    return;
  }

  if (session.step === 'awaiting_email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      bot.sendMessage(chatId, '⚠️ That doesn\'t look like a valid email. Try again:');
      return;
    }
    session.data.email = text;
    session.step = 'awaiting_password';
    bot.sendMessage(chatId,
`🔑 Now send a *password* for the account:
_Minimum 6 characters_`,
      { parse_mode: 'Markdown' });
    return;
  }

  if (session.step === 'awaiting_password') {
    if (text.length < 6) {
      bot.sendMessage(chatId, '⚠️ Password must be at least 6 characters. Try again:');
      return;
    }
    session.data.password = text;
    bot.sendMessage(chatId, '🔄 Setting up your account... hang tight ⚡');

    try {
      const d = await apiClaim(session.data.ref, session.data.email, session.data.password);
      if (!d.ok) {
        bot.sendMessage(chatId, `❌ *Failed:* ${d.msg || 'Something went wrong.'}`, { parse_mode: 'Markdown' });
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
      bot.sendMessage(chatId, '❌ Network error. Contact admin.');
    }
    resetSession(chatId);
    return;
  }
});

console.log('🤖 Kalypo Mods Telegram bot is running...');
