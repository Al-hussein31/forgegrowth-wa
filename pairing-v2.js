const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const P = require('pino');

// Force stdout flush for background process compatibility
const log = (msg) => { process.stdout.write(msg + '\n'); };

const DATA_DIR = path.join(__dirname, 'baileys-auth');
const PHONE = '2349010926847'; // <--- CHANGE THIS TO YOUR NUMBER

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Clean slate
for (const f of fs.readdirSync(DATA_DIR)) {
    if (f !== '.gitkeep') fs.rmSync(path.join(DATA_DIR, f), { recursive: true, force: true });
}

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState(DATA_DIR);
    const { version } = await fetchLatestBaileysVersion();
    log(`Baileys v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        logger: P({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ['Chrome (macOS)', '', ''],
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: true,
        syncFullHistory: true,
    });

    let pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // If a QR was generated, that means the socket is connected to the server
        // This is our signal to try pairing code instead
        if (qr && !pairingRequested && !sock.authState.creds.registered) {
            pairingRequested = true;
            log('SOCKET_ALIVE — requesting pairing code...');
            try {
                const code = await sock.requestPairingCode(PHONE);
                // Format nicely: ABCD-EFGH
                const formatted = code.toString().match(/.{1,4}/g)?.join('-') || code.toString();
                log(`PAIRING_CODE:${formatted}`);
                log('Go to WhatsApp → Linked Devices → Link a Device → PAIR WITH CODE');
                log(`Enter this code on your phone: ${formatted}`);

                // Also write to file for easier capture from background
                try {
                    fs.writeFileSync('/tmp/wa_pairing_code.txt', formatted);
                    fs.writeFileSync('/tmp/wa_pairing_ready.txt', 'true');
                } catch (e) { /* ignore file errors */ }
            } catch (e) {
                log(`PAIRING_FAILED:${e.message}`);
                // Don't exit yet — let the connection keep trying
            }
        }

        if (connection === 'open') {
            log('CONNECTED');
            log(`USER:${sock.user?.name || ''}`);
            log(`ID:${sock.user?.id || ''}`);
            try { fs.writeFileSync('/tmp/wa_connected.txt', 'true'); } catch(e) {}

            // Analyze
            try {
                const chats = Object.values(sock.chats || {});
                const contacts = await sock.getContacts();
                log(`CHATS:${chats.length}`);
                log(`CONTACTS:${contacts.length}`);

                const people = chats.filter(c => !c.id.endsWith('@g.us') && !c.id.endsWith('@broadcast'));
                people.sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0));

                for (const chat of people.slice(0, 25)) {
                    try {
                        const name = chat.name || chat.id.split('@')[0];
                        const lastMsg = chat.lastMessage?.message?.conversation
                            || chat.lastMessage?.message?.extendedTextMessage?.text
                            || '(media)';
                        log(`CHAT:${chat.lastMessage?.key?.fromMe ? 'OUT' : 'IN'}:${name}:${String(lastMsg).slice(0, 80)}`);
                    } catch (e) { }
                }
                log('ANALYSIS_DONE');
            } catch (e) {
                log('ANALYSIS_ERROR:' + e.message);
            }
            process.exit(0);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const msg = lastDisconnect?.error?.message || '';
            log(`CLOSED:${code}:${msg}`);
            // Only exit if it's a definitive failure
            if (code === DisconnectReason.loggedOut) {
                log('LOGGED_OUT');
                process.exit(1);
            }
            // For other cases (restart required, etc.), the socket will auto-reconnect
        }
    });

    sock.ev.on('messages.upsert', () => { });
    sock.ev.on('creds.update', saveCreds);
}

start().catch(e => {
    log('FATAL:' + e.message);
    process.exit(1);
});

setTimeout(() => { log('TIMEOUT'); process.exit(1); }, 120000);
