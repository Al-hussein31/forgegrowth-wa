const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const DATA_DIR = path.join('/Users/MAC/Desktop/forgegrowth-wa', 'session-data');
const SELECTION = '/Users/MAC/Desktop/forgegrowth-wa/forgegrowth_selection.json';
const OUTPUT = '/Users/MAC/Desktop/forgegrowth-wa/analysis_output.json';
const chromePath = '/Users/MAC/.cache/puppeteer/chrome/mac_arm-147.0.7727.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const sel = JSON.parse(fs.readFileSync(SELECTION, 'utf8'));
const selectedContacts = sel.selected.contacts;
console.log('Selected contacts to analyze: ' + selectedContacts.length);

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'auth') }),
    puppeteer: { headless: true, executablePath: chromePath,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] }
});

client.on('qr', () => { console.log('QR_EXPIRED'); process.exit(1); });
client.on('auth_failure', (m) => { console.log('AUTH_FAIL:', m); process.exit(1); });
client.on('ready', async () => {
    console.log('CONNECTED - fetching detailed analysis...');
    const chats = await client.getChats();
    const contacts = await client.getContacts();
    
    let results = [];
    let count = 0;
    
    // Process first 20 most recent for now
    for (const sc of selectedContacts.slice(0, 20)) {
        count++;
        try {
            const chat = chats.find(c => !c.isGroup && c.id.user === sc.number);
            if (!chat) { console.log('  ['+count+'] SKIP: '+sc.name+' (no chat)'); continue; }
            
            const contact = contacts.find(c => c.id._serialized === chat.id._serialized);
            const name = contact?.name || contact?.pushname || sc.name || 'Unknown';
            
            // Get last 20 messages for full context
            const msgs = await chat.fetchMessages({ limit: 20 });
            
            // Check delivery status of my last message
            const myLastMsg = [...msgs].reverse().find(m => m.fromMe);
            let delivered = false;
            let read = false;
            if (myLastMsg) {
                // In whatsapp-web.js, message status: 0=pending, 1=sent, 2=delivered, 3=read
                const ack = myLastMsg.ack;
                delivered = ack >= 2;
                read = ack >= 3;
            }
            
            // Build conversation history summary
            const history = msgs.map(m => ({
                fromMe: m.fromMe,
                text: (m.body || '(media/sticker)').slice(0, 200),
                time: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
                status: m.fromMe ? (m.ack >= 3 ? 'read' : m.ack >= 2 ? 'delivered' : m.ack >= 1 ? 'sent' : 'pending') : null
            }));
            
            // Determine conversation topic from history
            const allText = msgs.map(m => m.body || '').filter(Boolean).join(' ').toLowerCase();
            let topics = [];
            if (allText.includes('price') || allText.includes('cost') || allText.includes('naria') || allText.includes('fee') || allText.includes('package')) topics.push('pricing');
            if (allText.includes('whatsapp') || allText.includes('automation') || allText.includes('bot') || allText.includes('crm')) topics.push('whatsapp automation');
            if (allText.includes('onboard') || allText.includes('start') || allText.includes('getting started') || allText.includes('setup')) topics.push('onboarding');
            if (allText.includes('food') || allText.includes('restaurant') || allText.includes('menu') || allText.includes('eats')) topics.push('food/restaurant');
            if (allText.includes('thank') || allText.includes('ok') || allText.includes('noted')) topics.push('courtesy reply');
            if (allText.includes('agency') || allText.includes('visa') || allText.includes('travel')) topics.push('travel/visa agency');
            if (allText.includes('product') || allText.includes('service') || allText.includes('delivery')) topics.push('product/service inquiry');
            
            // Who initiated
            const firstMsg = msgs[0];
            const youInitiated = firstMsg?.fromMe || false;
            
            results.push({
                rank: count,
                name, number: sc.number,
                lastDate: sc.lastDate,
                myLastMsgDelivered: delivered,
                myLastMsgRead: read,
                youInitiated,
                topics: topics.length > 0 ? topics : ['general'],
                totalMessages: msgs.length,
                myMessages: msgs.filter(m => m.fromMe).length,
                theirMessages: msgs.filter(m => !m.fromMe).length,
                conversationHistory: history
            });
            
            const del = delivered ? '✅' : '❌';
            const rd = read ? '👁️' : '';
            console.log('  ['+count+'] '+name+' | Msgs:'+msgs.length+' | Delivered:'+del+rd+' | Topics:'+topics.join(','));
            
        } catch(e) {
            console.log('  ['+count+'] ERROR: '+sc.name+' - '+e.message);
        }
    }
    
    const output = {
        totalSelected: selectedContacts.length,
        analyzed: results.length,
        contacts: results
    };
    
    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
    console.log('\nANALYSIS SAVED to: ' + OUTPUT);
    console.log('Analyzed: ' + results.length + ' contacts (of ' + selectedContacts.length + ' selected)');
    console.log('Delivered check: ' + results.filter(r => r.myLastMsgDelivered).length + ' delivered');
    console.log('Read check: ' + results.filter(r => r.myLastMsgRead).length + ' read');
    process.exit(0);
});

client.initialize().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 180000);
