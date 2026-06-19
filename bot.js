const TelegramBot = require('node-telegram-bot-api');

/* ═══════════════════════════════════
   CONFIG
═══════════════════════════════════ */
const BOT_TOKEN  = process.env.BOT_TOKEN || '8645097113:AAHhYO7AFy6dWLZVqVIUXicy5yVoeVR4zWI';
const SERVER_URL = process.env.SERVER_URL || 'https://kalypo-mods.onrender.com';
const ADMIN_KEY   = process.env.ADMIN_KEY || 'kalypo-admin-2024';
const ADMIN_IDS   = (process.env.ADMIN_TELEGRAM_IDS || '7564594071').split(',').map(s => s.trim()).filter(Boolean);
const PRICE_GHS   = process.env.PRICE_GHS || '20';

if (!BOT_TOKEN || !SERVER_URL || !ADMIN_KEY) {
  console.error('❌ Missing required env vars: BOT_TOKEN, SERVER_URL, ADMIN_KEY');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* In-memory session state per chat (resets on bot restart — fine for this use case) */
const sessions = {}; // chatId -> { step, data }

function isAdmin(msg) {
  return ADMIN_IDS.includes(String(msg.from.id)) || ADMIN_IDS.includes(String(msg.chat.id));
}

function resetSession(chatId) {
  delete sessions[chatId];
}

/* ═══════════════════════════════════
   SERVER API HELPERS
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
  const r = await fetch(`${SERVER_URL}/api/admin/accounts`, {
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  return r.json();
}

async function apiAdminStats() {
  const r = await fetch(`${SERVER_URL}/api/admin/stats`, {
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  return r.json();
}

async function apiAdminReset(ref) {
  const r = await fetch(`${SERVER_URL}/api/admin/reset/${encodeURIComponent(ref)}`, {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY }
  });
  return r.json();
}

/* ═══════════════════════════════════
   CUSTOMER COMMANDS
═══════════════════════════════════ */

bot.onText(/^\/start$/, (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  bot.sendMessage(chatId,
`🎮 *Welcome to Kalypo Mods*
CPM2 Account Store

Each account comes with:
🪙 300 Coins  🚗 10–20 Cars  👑 King Rank
🔓 All Cars  🎨 All Paintings  💡 Headlights
👕 Clothes  🎬 Animations

💰 Price: *GHS ${PRICE_GHS}* per account

*How to order:*
1️⃣ Pay the admin (ask for payment details with /pay)
2️⃣ Wait for your ref code to be approved
3️⃣ Use /claim to activate your account

Commands:
/pay — how to pay
/check <ref> — check if a ref code is valid
/claim — claim your account with a ref code
/help — show this menu`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/help$/, (msg) => bot.emit('text', { ...msg, text: '/start' }));

bot.onText(/^\/pay$/, (msg) => {
  bot.sendMessage(msg.chat.id,
`💳 *How to Pay*

Send *GHS ${PRICE_GHS}* via your preferred method, then send proof of payment to the admin in this chat.

Once confirmed, the admin will approve you and you'll receive a ref code to claim your account with /claim.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/check (.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ref = match[1].trim().toUpperCase();
  bot.sendMessage(chatId, '🔄 Checking...');
  try {
    const d = await apiCheck(ref);
    if (d.ok) {
      bot.sendMessage(chatId, `✅ *${ref}* is valid and available.\n\nUse /claim to activate it.`, { parse_mode: 'Markdown' });
    } else {
      bot.sendMessage(chatId, d.msg || '❌ Invalid ref code.');
    }
  } catch(e) {
    bot.sendMessage(chatId, '❌ Server error. Try again later.');
  }
});

bot.onText(/^\/claim$/, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: 'awaiting_ref', data: {} };
  bot.sendMessage(chatId, '🎮 Send me your *ref code* (e.g. KAL-49TEX8):', { parse_mode: 'Markdown' });
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

    bot.sendMessage(chatId, `✅ Assigned ref *${free.ref}* — send this to the customer:\n\n\`${free.ref}\``, { parse_mode: 'Markdown' });

    // Try to DM the customer directly if their numeric Telegram ID was given
    if (/^\d+$/.test(targetUserId)) {
      bot.sendMessage(targetUserId,
`✅ *Payment approved!*

Your ref code: \`${free.ref}\`

Use /claim in this bot to activate your CPM2 account.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {
        bot.sendMessage(chatId, '⚠️ Could not DM that user ID directly (they may not have started the bot). Send the ref manually.');
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
`📊 *Kalypo Mods Stock*

Total: ${s.total}
✅ Available: ${s.available}
🔴 Taken: ${s.taken}
🟠 Invalid: ${s.invalid}
🔵 Reserved: ${s.reserved}
💳 Wallets: ${s.walletCount}`,
      { parse_mode: 'Markdown' }
    );
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
  bot.sendMessage(msg.chat.id, `Your Telegram ID: \`${msg.from.id}\`\nChat ID: \`${msg.chat.id}\``, { parse_mode: 'Markdown' });
});

/* ═══════════════════════════════════
   CONVERSATIONAL CLAIM FLOW
═══════════════════════════════════ */
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();
  const session = sessions[chatId];

  if (!session || text.startsWith('/')) return; // let command handlers deal with it

  if (session.step === 'awaiting_ref') {
    const ref = text.toUpperCase();
    bot.sendMessage(chatId, '🔄 Verifying ref code...');
    const d = await apiCheck(ref);
    if (!d.ok) {
      bot.sendMessage(chatId, (d.msg || '❌ Invalid ref code.') + '\n\nTry /claim again with a valid code.');
      resetSession(chatId);
      return;
    }
    session.data.ref = ref;
    session.step = 'awaiting_email';
    bot.sendMessage(chatId, '✅ Valid! Now send the *new email* you want for this CPM2 account:', { parse_mode: 'Markdown' });
    return;
  }

  if (session.step === 'awaiting_email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      bot.sendMessage(chatId, '⚠️ That doesn\'t look like a valid email. Try again:');
      return;
    }
    session.data.email = text;
    session.step = 'awaiting_password';
    bot.sendMessage(chatId, '🔑 Now send the *new password* (min 6 characters):', { parse_mode: 'Markdown' });
    return;
  }

  if (session.step === 'awaiting_password') {
    if (text.length < 6) {
      bot.sendMessage(chatId, '⚠️ Password must be at least 6 characters. Try again:');
      return;
    }
    session.data.password = text;
    bot.sendMessage(chatId, '🔄 Changing CPM2 credentials... this can take a few seconds.');

    try {
      const d = await apiClaim(session.data.ref, session.data.email, session.data.password);
      if (!d.ok) {
        bot.sendMessage(chatId, `❌ ${d.msg || 'Something went wrong.'}`);
      } else {
        bot.sendMessage(chatId,
`✅ *Account claimed!*

📧 Email: \`${session.data.email}\`
🔑 Password: \`${session.data.password}\`

Log into CPM2 with these credentials now. Save them somewhere safe!`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch(e) {
      bot.sendMessage(chatId, '❌ Network error. Contact admin.');
    }
    resetSession(chatId);
    return;
  }
});

console.log('🤖 Kalypo Mods Telegram bot is running...');
