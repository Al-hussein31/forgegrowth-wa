const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');

const DATA_DIR = path.join(__dirname, 'session-data');
const QR_FILE = '/tmp/wa_qr.png';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const chromePath = '/Users/MAC/.cache/puppeteer/chrome/mac_arm-147.0.7727.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'auth') }),
    puppeteer: {
        headless: false,
        executablePath: chromePath,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
    }
});

client.on('qr', async (qr) => {
    await qrcode.toFile(QR_FILE, qr, { type: 'png', width: 400, margin: 2 });
    console.log('QR_READY');
});
client.on('authenticated', () => console.log('AUTH_OK'));
client.on('auth_failure', (m) => console.error('AUTH_FAIL:', m));
client.on('ready', async () => {
    console.log('CONNECTED');
    const chats = await client.getChats();
    const contacts = await client.getContacts();
    const people = chats.filter(c => !c.isGroup);
    console.log(`CHATS:${chats.length}, CONTACTS:${contacts.length}`);
    for (const chat of people.slice(0, 25)) {
        try {
            const c = contacts.find(x => x.id._serialized === chat.id._serialized);
            const name = c?.name || c?.pushname || chat.name || chat.id.user;
            const msgs = await chat.fetchMessages({ limit: 2 });
            const last = msgs[msgs.length-1] || {};
            console.log(`CHAT:${last.fromMe?'OUT':'IN'}:${name}:${(last.body||'(media)').slice(0,80)}`);
        } catch(e) {}
    }
    console.log('ANALYSIS_DONE');
    process.exit(0);
});
client.on('disconnected', (r) => console.log('DISC:', r));
client.initialize().catch(e => { console.error('FATAL:', e); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 180000);
