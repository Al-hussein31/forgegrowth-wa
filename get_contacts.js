const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const DATA_DIR = path.join(__dirname, 'session-data');
const OUTPUT = '/tmp/wa_contacts.json';
const chromePath = '/Users/MAC/.cache/puppeteer/chrome/mac_arm-147.0.7727.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'auth') }),
    puppeteer: { headless: true, executablePath: chromePath,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] }
});

client.on('qr', () => { console.log('QR_EXPIRED'); process.exit(1); });
client.on('auth_failure', (m) => { console.log('AUTH_FAIL:', m); process.exit(1); });
client.on('ready', async () => {
    console.log('CONNECTED');
    const chats = await client.getChats();
    const contacts = await client.getContacts();
    const people = chats.filter(c => !c.isGroup && !c.isBroadcast);
    let list = [];

    for (const chat of people) {
        try {
            const c = contacts.find(x => x.id._serialized === chat.id._serialized);
            const name = c?.name || c?.pushname || chat.name || chat.id.user || 'Unknown';
            const msgs = await chat.fetchMessages({ limit: 3 });
            const last = msgs[msgs.length-1] || {};
            list.push({
                name, number: chat.id.user,
                lastDate: last.timestamp ? new Date(last.timestamp*1000).toISOString() : null,
                lastText: (last.body||'(media)').slice(0,100),
                lastFromYou: last.fromMe||false,
                unread: chat.unreadCount||0
            });
        } catch(e) {}
    }

    list.sort((a,b) => {
        if (!a.lastDate) return 1; if (!b.lastDate) return -1;
        return new Date(b.lastDate)-new Date(a.lastDate);
    });

    fs.writeFileSync(OUTPUT, JSON.stringify({ total: list.length, contacts: list }, null, 2));
    console.log(`SAVED: ${list.length} contacts`);
    process.exit(0);
});

client.initialize().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 120000);
