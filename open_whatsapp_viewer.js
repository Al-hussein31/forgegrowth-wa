const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const qrcode = require('qrcode-terminal');

const AUTH_DIR = path.join(__dirname, 'session-data', 'auth');
const CHROME_PATH = process.env.CHROME_PATH || '/Users/MAC/.cache/puppeteer/chrome/mac_arm-147.0.7727.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const MODERN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: AUTH_DIR,
        clientId: 'forgegrowth'
    }),
    puppeteer: {
        headless: false,
        executablePath: CHROME_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1280,900'
        ]
    },
    userAgent: MODERN_UA,
    takeoverOnConflict: false
});

client.on('qr', qr => {
    console.log('QR needed. Scan this if the visible browser asks for login:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('Authenticated.'));

client.on('ready', async () => {
    const info = await client.info;
    console.log(`WhatsApp viewer ready for ${info.pushname} (${info.me.user}).`);
    console.log('Keep this process running while you inspect the visible Chrome window.');
    console.log('Press Ctrl+C here when you are done.');
});

client.on('auth_failure', msg => {
    console.error('Auth failure:', msg);
});

client.on('disconnected', reason => {
    console.log('Viewer disconnected:', reason);
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\nClosing WhatsApp viewer...');
    try {
        await client.destroy();
    } catch (_) {}
    process.exit(0);
});

client.initialize().catch(error => {
    console.error('Viewer failed:', error.message);
    process.exit(1);
});
