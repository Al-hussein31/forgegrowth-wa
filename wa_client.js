/**
 * wa_client.js — Robust WhatsApp Web client with persistent sessions.
 * 
 * Fixes:
 *  - Uses realistic user agent (matches actual Chrome version)
 *  - Persistent LocalAuth (never wipes session unless asked)
 *  - Auto-reconnect on disconnect
 *  - Proper ACK tracking with retries
 *  - Single reusable client instance
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'session-data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');

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
    return candidates.find(candidate => fs.existsSync(candidate));
}

// Modern user agent matching actual Chrome 147 on macOS Sequoia
const MODERN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

let client = null;
let isReady = false;
let pendingSends = [];

function createClient() {
    if (client) return client;

    console.log('Initializing WhatsApp client...');
    
    const executablePath = resolveChromePath();
    const puppeteer = { 
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ]
    };
    if (executablePath) puppeteer.executablePath = executablePath;

    client = new Client({
        authStrategy: new LocalAuth({ 
            dataPath: AUTH_DIR,
            clientId: 'forgegrowth' // stable client ID
        }),
        puppeteer,
        userAgent: MODERN_UA,
        takeoverOnConflict: true,
        takeoverTimeoutMs: 0,
    });

    client.on('qr', (qr) => {
        console.log('\n⚠️  QR CODE NEEDED — Scan required!');
        console.log('   Open WhatsApp > Linked Devices > Link a Device\n');
        isReady = false;
    });

    client.on('authenticated', () => {
        console.log('✅ Authenticated');
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Auth failure:', msg);
        isReady = false;
    });

    client.on('loading_screen', (percent, msg) => {
        if (percent < 100) console.log(`Loading: ${percent}%`);
    });

    client.on('ready', async () => {
        isReady = true;
        const info = await client.info;
        console.log(`\n✅ WhatsApp READY`);
        console.log(`   Account: ${info.pushname} (${info.me.user})`);
        console.log(`   Platform: ${info.platform}`);
        console.log(`   Session: ${AUTH_DIR}\n`);

        // Flush any pending sends
        for (const send of pendingSends) {
            await sendMessage(send.to, send.body);
        }
        pendingSends = [];
    });

    client.on('disconnected', async (reason) => {
        console.log(`⚠️  Disconnected: ${reason}`);
        isReady = false;
        
        if (reason === 'NAVIGATION' || reason === 'LOGOUT') {
            console.log('Session invalid — will need re-auth');
        } else {
            // Try to reconnect
            console.log('Attempting reconnect in 5s...');
            await new Promise(r => setTimeout(r, 5000));
            if (!isReady) {
                try {
                    await client.initialize();
                } catch(e) {
                    console.error('Reconnect failed:', e.message);
                }
            }
        }
    });

    client.on('message_ack', (msg, ack) => {
        const ackNames = ['PENDING', 'SENT', 'DELIVERED', 'READ', 'PLAYED'];
        console.log(`📨 ACK update: ${msg.id._serialized.substring(0, 30)} → ${ackNames[ack] || ack}`);
    });

    return client;
}

/**
 * Send a message with retry logic and ACK verification.
 */
async function sendMessage(to, body, maxRetries = 2) {
    if (!client || !isReady) {
        throw new Error('WhatsApp not ready');
    }

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await client.sendMessage(to, body);
            const ackFromEvent = await waitForMessageAck(result, 8000);
            
            if (ackFromEvent !== null) {
                result.ack = Math.max(result.ack || 0, ackFromEvent);
            }

            if (result.ack >= 1) {
                console.log(`✅ Sent to ${to} (ACK: ${result.ack})`);
                return result;
            } else {
                console.log(`⚠️  ACK still ${result.ack} after 8s — caller should keep this pending`);
                return result;
            }
        } catch(e) {
            lastError = e;
            console.log(`⚠️  Attempt ${attempt + 1} failed: ${e.message}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
            }
        }
    }

    throw lastError;
}

function waitForMessageAck(message, timeoutMs) {
    const id = message?.id?._serialized;
    if (!id) {
        return new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
    }

    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            client.removeListener('message_ack', handler);
            resolve(null);
        }, timeoutMs);

        const handler = (msg, ack) => {
            if (msg?.id?._serialized !== id) return;
            if (ack < 1) return;
            clearTimeout(timeout);
            client.removeListener('message_ack', handler);
            resolve(ack);
        };

        client.on('message_ack', handler);
    });
}

/**
 * Ensure client is connected. Returns false if QR scan needed.
 */
async function ensureConnection() {
    if (isReady) return true;

    if (!client) {
        createClient();
    }

    return new Promise((resolve) => {
        let settled = false;
        let sawQr = false;

        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            client.removeListener('ready', readyHandler);
            client.removeListener('qr', qrHandler);
            client.removeListener('auth_failure', authFailureHandler);
            resolve(value);
        };

        const timeout = setTimeout(() => {
            if (sawQr) console.log('QR was requested and WhatsApp did not become ready before timeout.');
            finish(false);
        }, 90000);

        const readyHandler = async () => {
            finish(true);
        };

        const qrHandler = () => {
            sawQr = true;
            console.log('QR event received; still waiting briefly in case existing auth completes...');
        };

        const authFailureHandler = () => {
            finish(false);
        };

        if (isReady) {
            finish(true);
            return;
        }

        client.once('ready', readyHandler);
        client.on('qr', qrHandler);
        client.once('auth_failure', authFailureHandler);

        client.initialize().catch(e => {
            console.error('Init error:', e.message);
            finish(false);
        });
    });
}

/**
 * Initialize once (call at startup).
 */
async function init() {
    createClient();
    return ensureConnection();
}

/**
 * Clean shutdown.
 */
async function shutdown() {
    if (client) {
        try {
            await client.destroy();
        } catch(e) {}
        client = null;
        isReady = false;
    }
}

module.exports = { init, sendMessage, ensureConnection, shutdown, createClient };
