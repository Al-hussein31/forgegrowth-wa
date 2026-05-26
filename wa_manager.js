const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const P = require('pino');

const DATA_DIR = path.join(__dirname, 'baileys-auth');

let sock = null;
let isConnected = false;
let statusListeners = [];
let pairingCodeInfo = null;
let logger = P({ level: 'silent' });
let socketReadyResolve = null;
let socketReadyPromise = null;

function notifyListeners() {
  const status = getStatus();
  for (const fn of statusListeners) {
    try { fn(status); } catch (e) { /* ignore */ }
  }
}

function getStatus() {
  return {
    connected: isConnected,
    pairingCode: pairingCodeInfo ? pairingCodeInfo.code : null,
    pairingPhone: pairingCodeInfo ? pairingCodeInfo.phone : null,
    user: isConnected && sock ? (sock.user?.name || sock.user?.id || 'Connected') : null,
    error: pairingCodeInfo ? pairingCodeInfo.error : null
  };
}

function onStatusChange(fn) {
  statusListeners.push(fn);
  return () => { statusListeners = statusListeners.filter(f => f !== fn); };
}

async function init() {
  if (sock) return getStatus();

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR);
  const { version } = await fetchLatestBaileysVersion();

  socketReadyPromise = new Promise((resolve) => {
    socketReadyResolve = resolve;
  });

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['Chrome (Forge Growth)', 'Linux', '131.0.0.0'],
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    syncFullHistory: false,
    emitOwnEvents: true,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !isConnected && !sock.authState.creds.registered) {
      if (socketReadyResolve) {
        socketReadyResolve();
        socketReadyResolve = null;
      }
    }

    if (connection === 'open') {
      isConnected = true;
      pairingCodeInfo = null;
      if (socketReadyResolve) {
        socketReadyResolve();
        socketReadyResolve = null;
      }
      notifyListeners();
    }

    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        pairingCodeInfo = { error: 'Logged out — re-auth needed' };
        sock = null;
      } else {
        setTimeout(() => {
          if (!isConnected && sock) {
            sock.initialize().catch(() => {});
          }
        }, 5000);
      }
      notifyListeners();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  if (sock.authState.creds.registered) {
    isConnected = true;
    if (socketReadyResolve) {
      socketReadyResolve();
      socketReadyResolve = null;
    }
    notifyListeners();
  }

  return getStatus();
}

async function requestPairingCode(phoneNumber) {
  if (!sock) await init();

  const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
  if (cleanPhone.length < 10) {
    pairingCodeInfo = { error: 'Invalid phone number (use e.g. 2349010926847)', phone: phoneNumber };
    notifyListeners();
    return getStatus();
  }

  if (!isConnected) {
    try {
      if (socketReadyPromise) {
        await Promise.race([
          socketReadyPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connection to WhatsApp servers timed out after 45s. Check network or try again.')), 45000))
        ]);
      }
    } catch (e) {
      sock = null;
      socketReadyPromise = null;
      socketReadyResolve = null;
      pairingCodeInfo = { error: e.message, phone: cleanPhone };
      notifyListeners();
      return getStatus();
    }
  }

  try {
    const code = await sock.requestPairingCode(cleanPhone);
    const formatted = code.toString().match(/.{1,4}/g)?.join('-') || code.toString();
    pairingCodeInfo = { code: formatted, phone: cleanPhone };
    notifyListeners();

    const timeout = setTimeout(() => {
      if (pairingCodeInfo && pairingCodeInfo.code === formatted) {
        pairingCodeInfo = { ...pairingCodeInfo, error: 'Pairing timed out — scan the code on your phone within 2 minutes' };
        notifyListeners();
      }
    }, 120000);
    const origUnsub = onStatusChange((s) => {
      if (s.connected) { clearTimeout(timeout); origUnsub(); }
    });

    return getStatus();
  } catch (e) {
    pairingCodeInfo = { error: 'Pairing request failed: ' + e.message, phone: cleanPhone };
    notifyListeners();
    return getStatus();
  }
}

async function disconnect() {
  if (sock) {
    try {
      sock.end(new Error('User disconnected'));
    } catch (e) { /* ignore */ }
    sock = null;
  }
  isConnected = false;
  pairingCodeInfo = null;
  socketReadyPromise = null;
  socketReadyResolve = null;
  notifyListeners();
  return getStatus();
}

async function shutdown() {
  await disconnect();
  statusListeners = [];
}

async function sendMessage(jid, text) {
  if (!sock || !isConnected) throw new Error('WhatsApp not connected');
  return sock.sendMessage(jid, { text });
}

module.exports = { init, getStatus, onStatusChange, requestPairingCode, disconnect, shutdown, sendMessage };
