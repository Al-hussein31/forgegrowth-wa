const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');

const AUTH_DIR = path.join(__dirname, 'session-data', 'auth');
const CLIENT_ID = 'forgegrowth';
const MODERN_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let client = null;
let statusListeners = [];
let state = {
    connected: false,
    status: 'not_started',
    user: null,
    error: null,
    qr: null,
    qrDataUrl: null,
    checkedAt: null,
    engine: 'whatsapp-web.js',
    authPath: AUTH_DIR
};

function resolveChromePath() {
    const candidates = [
        process.env.CHROME_PATH,
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Users/MAC/.cache/puppeteer/chrome/mac_arm-147.0.7727.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    ].filter(Boolean);

    return candidates.find(candidate => fs.existsSync(candidate)) || undefined;
}

function notifyListeners() {
    const current = getStatus();
    for (const fn of statusListeners) {
        try { fn(current); } catch (_) {}
    }
}

function patchState(patch) {
    state = {
        ...state,
        ...patch,
        checkedAt: new Date().toISOString()
    };
    notifyListeners();
    return getStatus();
}

function getStatus() {
    return { ...state };
}

function onStatusChange(fn) {
    statusListeners.push(fn);
    return () => { statusListeners = statusListeners.filter(listener => listener !== fn); };
}

function createClient() {
    if (client) return client;

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const executablePath = resolveChromePath();
    const puppeteer = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions'
        ]
    };
    if (executablePath) puppeteer.executablePath = executablePath;

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: AUTH_DIR,
            clientId: CLIENT_ID
        }),
        puppeteer,
        userAgent: MODERN_UA,
        takeoverOnConflict: false,
        takeoverTimeoutMs: 0
    });

    client.on('qr', async (qr) => {
        try {
            const qrDataUrl = await qrcode.toDataURL(qr, { width: 360, margin: 2 });
            patchState({
                connected: false,
                status: 'qr_ready',
                qr,
                qrDataUrl,
                error: null,
                user: null
            });
        } catch (error) {
            patchState({
                connected: false,
                status: 'qr_error',
                error: error.message,
                qr,
                qrDataUrl: null
            });
        }
    });

    client.on('authenticated', () => {
        patchState({
            connected: false,
            status: 'authenticated',
            error: null
        });
    });

    client.on('ready', async () => {
        let user = 'Connected';
        try {
            const info = await client.info;
            user = `${info.pushname || 'WhatsApp'} (${info.wid?.user || info.me?.user || ''})`.trim();
        } catch (_) {}

        patchState({
            connected: true,
            status: 'connected',
            user,
            error: null,
            qr: null,
            qrDataUrl: null
        });
    });

    client.on('auth_failure', (message) => {
        patchState({
            connected: false,
            status: 'auth_failure',
            error: `Auth failed: ${message || 're-auth needed'}`,
            user: null
        });
    });

    client.on('disconnected', (reason) => {
        client = null;
        patchState({
            connected: false,
            status: reason === 'LOGOUT' ? 'logged_out' : 'disconnected',
            error: reason === 'LOGOUT' ? 'Logged out - scan QR again' : `Disconnected: ${reason}`,
            user: null
        });
    });

    return client;
}

async function init() {
    if (state.connected) return getStatus();
    if (client && ['initializing', 'qr_ready', 'authenticated'].includes(state.status)) return getStatus();

    patchState({
        connected: false,
        status: 'initializing',
        error: null,
        qr: null,
        qrDataUrl: null
    });

    try {
        createClient();
        await client.initialize();
    } catch (error) {
        client = null;
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

async function requestPairingCode() {
    await init();
    return {
        ...getStatus(),
        pairingCode: null,
        pairingSupported: false,
        pairingMessage: 'This sender uses WhatsApp Web session auth. Scan the QR code shown here; it creates the exact session used by the sender.'
    };
}

async function disconnect() {
    if (client) {
        try { await client.destroy(); } catch (_) {}
        client = null;
    }
    return patchState({
        connected: false,
        status: 'stopped',
        user: null,
        error: null,
        qr: null,
        qrDataUrl: null
    });
}

async function resetSession() {
    await disconnect();
    const sessionDir = path.join(AUTH_DIR, `session-${CLIENT_ID}`);
    try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (_) {}
    return patchState({
        connected: false,
        status: 'reset',
        user: null,
        error: null,
        qr: null,
        qrDataUrl: null
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
