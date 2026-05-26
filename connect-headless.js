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
        headless: true,  // Changed to headless for terminal use
        executablePath: chromePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--window-size=800,600'
        ]
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

client.on('qr', async (qr) => {
    // Save QR as image
    await qrcode.toFile(QR_FILE, qr, { type: 'png', width: 400, margin: 2 });
    console.log('QR_READY');
    console.log('QR code saved to /tmp/wa_qr.png');
});

client.on('authenticated', () => {
    console.log('AUTH_OK');
});

client.on('auth_failure', (m) => {
    console.error('AUTH_FAILED:', m);
});

client.on('ready', async () => {
    console.log('CONNECTED');
    
    try {
        const chats = await client.getChats();
        const contacts = await client.getContacts();
        console.log(`TOTAL_CHATS:${chats.length}`);
        console.log(`TOTAL_CONTACTS:${contacts.length}`);
        
        // Get info about the user
        const info = await client.info;
        console.log(`USER_NAME:${info.pushname || 'N/A'}`);
        console.log(`USER_NUMBER:${info.wid.user || 'N/A'}`);
        
        // Analyze chats
        const people = chats.filter(c => !c.isGroup);
        const groups = chats.filter(c => c.isGroup);
        
        console.log(`PEOPLE_CHATS:${people.length}`);
        console.log(`GROUP_CHATS:${groups.length}`);
        
        // Sort by last message time
        people.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        
        for (const chat of people.slice(0, 30)) {
            try {
                const contact = contacts.find(x => x.id._serialized === chat.id._serialized);
                const name = contact?.name || contact?.pushname || chat.name || chat.id.user || 'Unknown';
                const msgs = await chat.fetchMessages({ limit: 1 });
                const last = msgs[msgs.length - 1] || {};
                const body = last.body || '(media/sticker)';
                const dir = last.fromMe ? 'OUT' : 'IN';
                const time = chat.timestamp ? new Date(chat.timestamp * 1000).toLocaleString() : '';
                const unread = chat.unreadCount || 0;
                console.log(`CHAT:${dir}:${name}:${time}:${unread}:${String(body.replace(/\n/g, ' ')).slice(0,100)}`);
            } catch(e) {}
        }
        
        console.log('ANALYSIS_DONE');
    } catch(e) {
        console.error('ANALYSIS_ERROR:', e.message);
    }
    
    process.exit(0);
});

client.on('disconnected', (reason) => {
    console.log('DISCONNECTED:', reason);
    process.exit(1);
});

client.initialize().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
});

setTimeout(() => {
    console.log('TIMEOUT');
    process.exit(1);
}, 180000);
