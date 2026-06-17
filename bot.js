require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const qrcode   = require('qrcode');
const axios    = require('axios');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');

process.on('uncaughtException', err => console.error('💥 Uncaught exception:', err));
process.on('unhandledRejection', err => console.error('💥 Unhandled rejection:', err));

const PORT      = process.env.PORT || 3000;
const API_BASE  = process.env.API_BASE_URL || 'http://localhost:3000';
const MONGO_URI = process.env.MONGO_URI;
// Digits only, with country code, no "+" — e.g. 233241234567. Leave unset to use QR instead.
const PAIR_PHONE_NUMBER = process.env.PAIR_PHONE_NUMBER || null;

if (!MONGO_URI) {
  console.error('❌ MONGO_URI is not set.');
  process.exit(1);
}

const api = axios.create({ baseURL: API_BASE, timeout: 15000 });

// In-memory per-chat session: WhatsApp chat ID -> { token, email, country }
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
}

let latestQr   = null;
let latestCode = null;
let isReady    = false;

const HELP = `*Kalypo Mods Bot* — commands:

📋 *menu* — show this menu
💰 *price* — show current price
📝 *register <email> <password>* — create a wallet
🔑 *login <email> <password>* — log in to your wallet
👤 *balance* — check wallet balance & purchases
💳 *deposit <paystackRef>* — credit a confirmed Paystack payment
🛒 *buy <newEmail> <newPassword>* — buy an account using wallet balance
🎫 *claim <ref> <newEmail> <newPassword>* — claim a specific ref code
🔍 *check <ref>* — check if a ref code is valid/available

_<newEmail>/<newPassword> = the login you want set on the purchased account._`;

async function start() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Mongo connected (used for WhatsApp session storage)');

  const store = new MongoStore({ mongoose });
  const clientOptions = {
    authStrategy: new RemoteAuth({
      store,
      backupSyncIntervalMs: 5 * 60 * 1000
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  };

  if (PAIR_PHONE_NUMBER) {
    clientOptions.pairWithPhoneNumber = {
      phoneNumber: PAIR_PHONE_NUMBER,
      showNotification: true
    };
    console.log(`🔢 Will request a pairing code for +${PAIR_PHONE_NUMBER} instead of a QR code.`);
  }

  const client = new Client(clientOptions);

  client.on('qr', qr => {
    if (!PAIR_PHONE_NUMBER) {
      latestQr = qr;
      isReady = false;
      console.log('📷 New QR generated — open /qr in your browser to scan it.');
    }
  });
  client.on('code', code => {
    latestCode = code;
    isReady = false;
    console.log(`🔢 Pairing code: ${code} — open /qr in your browser to view it.`);
  });
  client.on('ready', () => {
    isReady = true;
    latestQr = null;
    latestCode = null;
    console.log('✅ WhatsApp bot is ready.');
  });
  client.on('auth_failure', m => console.error('❌ Auth failure:', m));
  client.on('disconnected', r => { isReady = false; console.warn('⚠️ Disconnected:', r); });
  client.on('remote_session_saved', () => console.log('💾 Session saved to Mongo — no rescan needed after redeploys.'));

  client.on('message', async msg => {
    const text = (msg.body || '').trim();
    if (!text) return;

    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const session = getSession(msg.from);

    try {
      switch (cmd) {
        case 'menu':
        case 'help':
          return msg.reply(HELP);

        case 'price': {
          const { data } = await api.get('/api/config');
          return msg.reply(`💰 Price: GHS ${data.prices.GH}\nMinimum deposit: GHS ${data.minDep.GH}`);
        }

        case 'register': {
          const [email, password] = rest;
          if (!email || !password) return msg.reply('Usage: register <email> <password>');
          const { data } = await api.post('/api/wallet/register', { email, password, country: 'GH' });
          if (!data.ok) return msg.reply(`❌ ${data.msg}`);
          session.token = data.token; session.email = email; session.country = data.country;
          return msg.reply(`✅ Wallet created for ${email}. Balance: GHS ${data.balance}`);
        }

        case 'login': {
          const [email, password] = rest;
          if (!email || !password) return msg.reply('Usage: login <email> <password>');
          const { data } = await api.post('/api/wallet/login', { email, password });
          if (!data.ok) return msg.reply(`❌ ${data.msg}`);
          session.token = data.token; session.email = email; session.country = data.country;
          return msg.reply(`✅ Logged in as ${email}. Balance: GHS ${data.balance}`);
        }

        case 'balance': {
          if (!session.token) return msg.reply('You need to *login* or *register* first.');
          const { data } = await api.get('/api/wallet/me', { headers: { 'x-wallet-token': session.token } });
          if (!data.ok) return msg.reply(`❌ ${data.msg}`);
          return msg.reply(`👤 ${data.email}\n💰 Balance: GHS ${data.balance}\n🛍 Purchases: ${data.purchases.length}`);
        }

        case 'deposit': {
          if (!session.token) return msg.reply('You need to *login* first.');
          const [reference] = rest;
          if (!reference) return msg.reply('Usage: deposit <paystackReference>');
          const { data } = await api.post('/api/wallet/deposit', { reference },
            { headers: { 'x-wallet-token': session.token } });
          if (!data.ok) return msg.reply(`❌ ${data.msg}`);
          return msg.reply(`✅ Credited GHS ${data.credited}. New balance: GHS ${data.balance}`);
        }

        case 'buy': {
          if (!session.token) return msg.reply('You need to *login* first.');
          const [newEmail, newPassword] = rest;
          if (!newEmail || !newPassword) return msg.reply('Usage: buy <newEmail> <newPassword>');
          const { data } = await api.post('/api/wallet/buy', { newEmail, newPassword },
            { headers: { 'x-wallet-token': session.token } });
          if (!data.ok) return msg.reply(`❌ ${data.msg}`);
          return msg.reply(`✅ Purchase complete! Ref: ${data.purchase.ref}\nNew balance: GHS ${data.balance}`);
        }

        case 'claim': {
          const [ref, newEmail, newPassword] = rest;
          if (!ref || !newEmail || !newPassword) return msg.reply('Usage: claim <ref> <newEmail> <newPassword>');
          const { data } = await api.post('/api/claim', { ref, newEmail, newPassword });
          if (!data.ok) return msg.reply(`❌ ${data.msg}`);
          return msg.reply(`✅ Ref ${ref.toUpperCase()} claimed successfully!`);
        }

        case 'check': {
          const [ref] = rest;
          if (!ref) return msg.reply('Usage: check <ref>');
          const { data } = await api.get(`/api/check/${ref}`);
          if (!data.ok) return msg.reply(`❌ ${data.msg || 'Not available.'}`);
          return msg.reply(`✅ Ref ${ref.toUpperCase()} is available.`);
        }

        default:
          return msg.reply('Unknown command. Send *menu* to see what I can do.');
      }
    } catch (err) {
      console.error(err);
      return msg.reply('⚠️ Something went wrong talking to the server. Try again shortly.');
    }
  });

  client.initialize();

  // --- tiny web server: gives Render an open port, and lets you scan the QR from a browser ---
  const app = express();

  app.get('/', (req, res) => {
    res.send(isReady ? '✅ WhatsApp bot is connected.' : '⏳ Not connected yet — visit /qr');
  });

  app.get('/qr', async (req, res) => {
    if (isReady) return res.send('<h2>✅ Already connected — nothing to scan.</h2>');

    if (latestCode) {
      return res.send(`
        <h2>Enter this code on your phone</h2>
        <p>WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number instead"</p>
        <h1 style="font-size:48px;letter-spacing:8px;font-family:monospace;">${latestCode}</h1>
        <p><small>Codes expire after a few minutes — refresh this page to get a new one if it stops working.</small></p>
      `);
    }
    if (!latestQr) return res.send('<h2>⏳ Generating code… refresh in a few seconds.</h2>');
    const dataUrl = await qrcode.toDataURL(latestQr);
    res.send(`<h2>Scan with WhatsApp → Linked Devices</h2><img src="${dataUrl}" />`);
  });

  app.listen(PORT, () => console.log(`🌐 Health server listening on port ${PORT}`));
}

start();
