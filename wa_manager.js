const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const pino = require('pino');

const AUTH_DIR = path.join(__dirname, 'session-data', 'baileys-auth');

let sock = null;
let statusListeners = [];
let state = {
    connected: false,
    status: 'not_started',
    user: null,
    error: null,
    qr: null,
    qrDataUrl: null,
    pairingCode: null,
    checkedAt: null,
    engine: 'baileys',
    authPath: AUTH_DIR
};

let saveCreds = null;

function notifyListeners() {
    const current = getStatus();
    for (const fn of statusListeners) {
        try { fn(current); } catch (_) {}
    }
}

function patchState(patch) {
    state = { ...state, ...patch, checkedAt: new Date().toISOString() };
    notifyListeners();
    return getStatus();
}

function getStatus() {
    return { ...state };
}

function onStatusChange(fn) {
    statusListeners.push(fn);
    return () => { statusListeners = statusListeners.filter(l => l !== fn); };
}

async function createSocket() {
    if (sock) {
        try { sock.end(undefined); } catch (_) {}
        sock = null;
    }

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const authState = await useMultiFileAuthState(AUTH_DIR);
    saveCreds = authState.saveCreds;
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'warn' });

    sock = makeWASocket({
        version,
        auth: authState.state,
        logger,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        browser: Browsers.macOS('ForgeGrowth')
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const qrDataUrl = await qrcode.toDataURL(qr, { width: 360, margin: 2 });
                patchState({
                    connected: false,
                    status: 'qr_ready',
                    qr,
                    qrDataUrl,
                    pairingCode: null,
                    error: null,
                    user: null
                });
            } catch (err) {
                patchState({
                    connected: false,
                    status: 'qr_error',
                    error: err.message,
                    qr,
                    qrDataUrl: null
                });
            }
        }

        if (connection === 'open') {
            let user = 'Connected';
            try {
                const creds = sock?.authState?.creds;
                if (creds?.me) {
                    const name = creds.me.name || 'WhatsApp';
                    const id = (creds.me.id || '').split('@')[0] || '';
                    user = `${name} (${id})`.trim();
                }
            } catch (_) {}
            patchState({
                connected: true,
                status: 'connected',
                user,
                error: null,
                qr: null,
                qrDataUrl: null,
                pairingCode: null
            });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error ? Boom(lastDisconnect.error)?.output?.statusCode : null;

            if (statusCode === DisconnectReason.restartRequired) {
                patchState({
                    connected: false,
                    status: 'reconnecting',
                    error: null,
                    qr: null,
                    qrDataUrl: null
                });
                setTimeout(() => {
                    createSocket().catch(() => {});
                }, 500);
                return;
            }

            const wasConnected = state.connected;
            sock = null;
            if (statusCode === DisconnectReason.loggedOut) {
                patchState({
                    connected: false,
                    status: 'logged_out',
                    error: 'Logged out — scan QR again',
                    user: null
                });
            } else {
                patchState({
                    connected: false,
                    status: wasConnected ? 'disconnected' : 'error',
                    error: wasConnected ? 'Disconnected' : 'Connection closed',
                    user: null
                });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    return sock;
}

async function init() {
    if (state.connected) return getStatus();
    if (sock && ['initializing', 'qr_ready', 'reconnecting'].includes(state.status)) return getStatus();

    patchState({
        connected: false,
        status: 'initializing',
        error: null,
        qr: null,
        qrDataUrl: null,
        pairingCode: null
    });

    try {
        await createSocket();
    } catch (error) {
        sock = null;
        patchState({
            connected: false,
            status: 'error',
            error: error.message,
            qr: null,
            qrDataUrl: null
        });
    }

    return getStatus();
}

async function requestPairingCode(phone) {
    if (state.connected) return getStatus();

    await init();

    if (phone) {
        const cleaned = phone.replace(/[^0-9]/g, '');
        if (cleaned.length < 7) {
            return {
                ...getStatus(),
                error: 'Invalid phone number. Include country code (e.g. 2349010926847)'
            };
        }
        try {
            if (!sock) return { ...getStatus(), error: 'Socket not initialized' };
            const code = await sock.requestPairingCode(cleaned);
            patchState({
                status: 'pairing_code_ready',
                pairingCode: code,
                qr: null,
                qrDataUrl: null,
                error: null
            });
            return getStatus();
        } catch (e) {
            return {
                ...getStatus(),
                error: `Pairing code failed: ${e.message}`
            };
        }
    }

    return getStatus();
}

async function disconnect() {
    if (sock) {
        try { sock.end(undefined); } catch (_) {}
        sock = null;
    }
    return patchState({
        connected: false,
        status: 'stopped',
        user: null,
        error: null,
        qr: null,
        qrDataUrl: null,
        pairingCode: null
    });
}

async function resetSession() {
    await disconnect();
    try {
        const entries = fs.readdirSync(AUTH_DIR);
        for (const entry of entries) {
            fs.rmSync(path.join(AUTH_DIR, entry), { recursive: true, force: true });
        }
    } catch (_) {}
    return patchState({
        connected: false,
        status: 'reset',
        user: null,
        error: null,
        qr: null,
        qrDataUrl: null,
        pairingCode: null
    });
}

async function shutdown() {
    await disconnect();
    statusListeners = [];
}

module.exports = {
    init,
    getStatus,
    onStatusChange,
    requestPairingCode,
    disconnect,
    resetSession,
    shutdown
};
