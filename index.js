const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '25mb' }));

const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'change-this-secret-token';
const PORT = process.env.PORT || 10000;
const sessions = new Map();

// Authentication middleware
app.use((req, res, next) => {
  const token = req.headers['x-bridge-token'];
  if (!token || token !== BRIDGE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: invalid x-bridge-token' });
  }
  next();
});

async function initSession(sessionId) {
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    if (existing.status === 'connected') return existing;
  }

  const sessionDir = path.join(__dirname, 'auth_sessions', sessionId);
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['B2BKAR Web', 'Chrome', '120.0.0']
  });

  const sessionObj = { sock, qr: null, status: 'connecting', phone: null };
  sessions.set(sessionId, sessionObj);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionObj.status = 'qr';
      sessionObj.qr = await QRCode.toDataURL(qr);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      sessionObj.status = 'disconnected';
      sessionObj.qr = null;
      if (shouldReconnect) {
        initSession(sessionId).catch(() => {});
      } else {
        sessions.delete(sessionId);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
      }
    } else if (connection === 'open') {
      sessionObj.status = 'connected';
      sessionObj.qr = null;
      sessionObj.phone = sock.user?.id ? sock.user.id.split(':')[0] : null;
    }
  });

  return sessionObj;
}

// 1. Start session & retrieve QR
app.post('/session/start', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    let s = sessions.get(sessionId);
    if (!s || s.status === 'disconnected') {
      s = await initSession(sessionId);
    }
    await new Promise((r) => setTimeout(r, 1200));
    res.json({ status: s.status, qr: s.qr, phone: s.phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Poll session status
app.get('/session/status', (req, res) => {
  const sessionId = req.query.sessionId;
  const s = sessions.get(sessionId);
  if (!s) return res.json({ status: 'disconnected', qr: null, phone: null });
  res.json({ status: s.status, qr: s.qr, phone: s.phone });
});

// 3. Request 8-digit phone pairing code
app.post('/session/pair', async (req, res) => {
  try {
    const { sessionId, phone } = req.body;
    let s = sessions.get(sessionId);
    if (!s || s.status === 'disconnected') s = await initSession(sessionId);

    const cleanPhone = String(phone).replace(/\D/g, '');
    const code = await s.sock.requestPairingCode(cleanPhone);
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Logout session
app.post('/session/logout', async (req, res) => {
  const { sessionId } = req.body;
  const s = sessions.get(sessionId);
  if (s && s.sock) {
    try { await s.sock.logout(); } catch (_) {}
    sessions.delete(sessionId);
  }
  const sessionDir = path.join(__dirname, 'auth_sessions', sessionId);
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
  res.json({ ok: true });
});

// 5. Send plain text message
app.post('/send/text', async (req, res) => {
  try {
    const { sessionId, to, text } = req.body;
    const s = sessions.get(sessionId);
    if (!s || s.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp session not connected' });
    }
    const cleanTo = String(to).replace(/\D/g, '');
    const jid = `${cleanTo}@s.whatsapp.net`;
    const sent = await s.sock.sendMessage(jid, { text });
    res.json({ messageId: sent?.key?.id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Send PDF document attachment
app.post('/send/document', async (req, res) => {
  try {
    const { sessionId, to, filename, caption, base64 } = req.body;
    const s = sessions.get(sessionId);
    if (!s || s.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp session not connected' });
    }
    const cleanTo = String(to).replace(/\D/g, '');
    const jid = `${cleanTo}@s.whatsapp.net`;
    const buffer = Buffer.from(base64, 'base64');
    const sent = await s.sock.sendMessage(jid, {
      document: buffer,
      mimetype: 'application/pdf',
      fileName: filename || 'catalogue.pdf',
      caption: caption || ''
    });
    res.json({ messageId: sent?.key?.id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Baileys Bridge listening on port ${PORT}`);
});
