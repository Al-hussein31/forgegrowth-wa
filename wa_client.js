const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const AUTH_DIR = path.join(__dirname, 'session-data', 'baileys-auth');

let sock = null;
let isReady = false;

async function init() {
    if (sock) {
        if (isReady) return true;
        return ensureConnection();
    }

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'warn' });

    sock = makeWASocket({
        version,
        auth: state,
        logger,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        browser: Browsers.macOS('ForgeGrowthSender')
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n⚠️  QR CODE RECEIVED — Scan required from dashboard');
        }

        if (connection === 'open') {
            isReady = true;
            console.log('✅ WhatsApp READY');
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error ? Boom(lastDisconnect.error)?.output?.statusCode : null;

            if (reason === DisconnectReason.restartRequired) {
                isReady = false;
                sock = null;
                return;
            }

            isReady = false;
            sock = null;
            if (reason === DisconnectReason.loggedOut) {
                console.log('Session invalid — QR re-auth needed');
            } else {
                console.log('Disconnected');
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return ensureConnection();
}

async function ensureConnection() {
    if (isReady) return true;
    if (!sock) return false;

    return new Promise((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) { settled = true; resolve(false); }
        }, 90000);

        const handler = (update) => {
            if (settled) return;
            if (update.connection === 'open') {
                settled = true;
                clearTimeout(timeout);
                sock.ev.off('connection.update', handler);
                resolve(true);
            }
            if (update.connection === 'close') {
                settled = true;
                clearTimeout(timeout);
                sock.ev.off('connection.update', handler);
                resolve(false);
            }
        };
        sock.ev.on('connection.update', handler);
    });
}

async function sendMessage(to, body, maxRetries = 2) {
    if (!sock || !isReady) throw new Error('WhatsApp not ready');

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await sock.sendMessage(to, { text: body });
            return {
                ack: result?.status || 1,
                id: {
                    _serialized: result?.key?.id,
                    id: result?.key?.id
                }
            };
        } catch (e) {
            lastError = e;
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
            }
        }
    }
    throw lastError;
}

async function shutdown() {
    if (sock) {
        sock.end(undefined);
        sock = null;
        isReady = false;
    }
}

module.exports = { init, sendMessage, ensureConnection, shutdown };
