const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const P = require('pino');

const DATA_DIR = path.join(__dirname, 'baileys-auth');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Clean stale state - remove everything except keep the directory
const entries = fs.readdirSync(DATA_DIR);
for (const entry of entries) {
    const fullPath = path.join(DATA_DIR, entry);
    if (entry !== '.gitkeep') {
        fs.rmSync(fullPath, { recursive: true, force: true });
    }
}

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Baileys v${version.join('.')} (latest: ${isLatest})`);

    const sock = makeWASocket({
        version,
        logger: P({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,  // Must be false for pairing code
        browser: ['Chrome (Forge Growth)', 'macOS', '131.0.0.0'],
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        syncFullHistory: true,
        // Fix: try without specifying generateHighQualityLink
    });

    // Connection status
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR code was generated (unexpected, falling back to pairing)');
        }

        if (connection === 'open') {
            console.log('CONNECTED');
            console.log(`USER:${sock.user?.name || 'N/A'}`);
            console.log(`NUMBER:${sock.user?.id || 'N/A'}`);
            
            // Get all chats
            const chats = Object.values(sock.chats || {});
            console.log(`TOTAL_CHATS:${chats.length}`);
            
            // Get contacts
            try {
                const contacts = await sock.getContacts();
                console.log(`TOTAL_CONTACTS:${contacts.length}`);
            } catch(e) {
                console.log('CONTACTS_ERROR:' + e.message);
            }
            
            // List groups
            const groups = chats.filter(c => c.id.endsWith('@g.us'));
            console.log(`TOTAL_GROUPS:${groups.length}`);
            
            // List recent conversations (people only)
            const people = chats.filter(c => !c.id.endsWith('@g.us') && !c.id.endsWith('@broadcast'));
            const sorted = (people || []).sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0));
            
            for (const chat of sorted.slice(0, 30)) {
                try {
                    const name = chat.name || chat.id.split('@')[0];
                    const lastMsg = chat.lastMessage?.message?.conversation || 
                                   chat.lastMessage?.message?.extendedTextMessage?.text || 
                                   chat.lastMessage?.message?.imageMessage?.caption || '(media/sticker)';
                    const dir = chat.lastMessage?.key?.fromMe ? 'OUT' : 'IN';
                    const time = chat.conversationTimestamp ? new Date(chat.conversationTimestamp * 1000).toLocaleString() : '';
                    console.log(`CHAT:${dir}:${name}:${time}:${String(lastMsg).slice(0,100)}`);
                } catch(e) {}
            }
            
            console.log('ANALYSIS_DONE');
            process.exit(0);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reasonText = lastDisconnect?.error?.output?.payload?.error || lastDisconnect?.error?.message || 'unknown';
            
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('LOGGED_OUT');
            } else if (statusCode === DisconnectReason.restartRequired) {
                console.log('RESTART_REQUIRED');
            } else if (statusCode === DisconnectReason.badSession) {
                console.log('BAD_SESSION');
            } else {
                console.log(`CLOSED:${statusCode}:${reasonText}`);
            }
            process.exit(1);
        }
    });

    // If not registered, request pairing code
    if (!sock.authState.creds.registered) {
        console.log('PAIRING_MODE');
        // Phone number WITHOUT + or spaces, just country code + number
        const phoneNumber = '2349010926847';
        
        try {
            const pairingCode = await sock.requestPairingCode(phoneNumber);
            // Pairing code is returned in chunks - join them
            const formattedCode = pairingCode.match(/.{1,4}/g)?.join('-') || pairingCode;
            console.log(`PAIRING_CODE:${formattedCode}`);
            console.log('WAITING_FOR_SCAN');
        } catch (e) {
            console.log(`PAIRING_ERROR:${e.message}`);
            process.exit(1);
        }
    }

    // Listen for messages after connection
    sock.ev.on('messages.upsert', async (m) => {
        // Will handle incoming messages after connection
    });

    sock.ev.on('creds.update', saveCreds);
}

start().catch(e => {
    console.error('FATAL:' + e.message);
    process.exit(1);
});

// Timeout after 3 minutes
setTimeout(() => { 
    console.log('TIMEOUT'); 
    process.exit(1); 
}, 180000);
