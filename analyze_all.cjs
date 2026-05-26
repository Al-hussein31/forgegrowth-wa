const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join('/Users/MAC/Desktop/forgegrowth-wa', 'session-data');
const SELECTION = '/Users/MAC/Desktop/forgegrowth-wa/forgegrowth_selection.json';
const OUTPUT = '/Users/MAC/Desktop/forgegrowth-wa/contacts_full_analysis.json';
const chromePath = '/Users/MAC/.cache/puppeteer/chrome/mac_arm-147.0.7727.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const sel = JSON.parse(fs.readFileSync(SELECTION, 'utf8'));
const contacts = sel.selected.contacts;
const TOTAL = contacts.length;

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'auth') }),
    puppeteer: { headless: true, executablePath: chromePath,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] }
});

client.on('qr', () => { console.log('QR_EXPIRED'); process.exit(1); });
client.on('auth_failure', (m) => { console.log('AUTH_FAIL:', m); process.exit(1); });
client.on('ready', async () => {
    console.log('CONNECTED - analyzing ' + TOTAL + ' contacts...\n');
    const chats = await client.getChats();
    const wwContacts = await client.getContacts();
    
    let results = [];
    
    for (let idx = 0; idx < TOTAL; idx++) {
        const sc = contacts[idx];
        try {
            const chat = chats.find(c => !c.isGroup && c.id.user === sc.number);
            if (!chat) {
                results.push({ index: idx+1, name: sc.name, number: sc.number, status: 'no_chat_found' });
                process.stdout.write('\r  ['+(idx+1)+'/'+TOTAL+'] SKIP: '+sc.name+' (no chat)');
                continue;
            }
            
            const msgs = await chat.fetchMessages({ limit: 30 });
            
            // Delivery & read check
            const myMsgs = msgs.filter(m => m.fromMe);
            const theirMsgs = msgs.filter(m => !m.fromMe);
            const lastMyMsg = myMsgs[myMsgs.length - 1];
            let delivered = false, read = false;
            if (lastMyMsg) {
                delivered = lastMyMsg.ack >= 2;
                read = lastMyMsg.ack >= 3;
            }
            
            // Build message timeline
            const timeline = msgs.map(m => ({
                fm: m.fromMe, 
                t: (m.body || '(media/sticker)').slice(0, 250),
                ts: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
                st: m.fromMe ? (m.ack >= 3 ? 'read' : m.ack >= 2 ? 'delivered' : m.ack >= 1 ? 'sent' : 'pending') : null
            }));
            
            // Conversation context analysis
            const allText = msgs.map(m => m.body || '').filter(Boolean).join(' ').toLowerCase();
            
            // Detect tone
            const pidginWords = ['dey','wana','abeg','oya','na','wey','dem','dey','bros','my guy','oga','chop','wetin','no be','abi','shebi'];
            const pidginScore = pidginWords.filter(w => allText.includes(w)).length;
            const tone = pidginScore >= 2 ? 'pidgin/informal' : (pidginScore >= 1 ? 'mixed' : 'formal');
            
            // Detect business type
            const businessTypes = [];
            if (allText.includes('food')||allText.includes('restaurant')||allText.includes('menu')||allText.includes('eatery')||allText.includes('kitchen')) businessTypes.push('food/restaurant');
            if (allText.includes('print')||allText.includes('printer')||allText.includes('printing')||allText.includes('design')) businessTypes.push('printing/design');
            if (allText.includes('agency')||allText.includes('travel')||allText.includes('visa')||allText.includes('tourism')) businessTypes.push('travel/agency');
            if (allText.includes('shop')||allText.includes('store')||allText.includes('retail')||allText.includes('market')) businessTypes.push('retail/shop');
            if (allText.includes('fashion')||allText.includes('tailor')||allText.includes('cloth')||allText.includes('dress')) businessTypes.push('fashion');
            if (allText.includes('hotel')||allText.includes('lodge')||allText.includes('apartment')||allText.includes('estate')) businessTypes.push('hospitality/realestate');
            if (allText.includes('car')||allText.includes('wash')||allText.includes('mechanic')||allText.includes('auto')||allText.includes('vehicle')) businessTypes.push('automotive');
            if (allText.includes('event')||allText.includes('plan')||allText.includes('party')||allText.includes('decoration')) businessTypes.push('events/planning');
            if (allText.includes('school')||allText.includes('class')||allText.includes('student')||allText.includes('learn')||allText.includes('tutor')) businessTypes.push('education');
            
            // Conversation stage
            let stage = 'unknown';
            const youLast = lastMyMsg && msgs[msgs.length-1]?.fromMe;
            if (msgs.length <= 1) stage = 'just_started';
            else if (!theirMsgs.length) stage = 'no_reply_yet';
            else if (youLast && delivered) stage = 'waiting_for_reply';
            else if (youLast && !delivered) stage = 'message_not_delivered';
            else if (!youLast) stage = 'awaiting_your_reply';
            
            // Contact name for personalization
            let firstName = sc.name.replace(/^\+234\s*/, '').trim();
            // If it's a phone number, try to find a contact name
            const wwContact = wwContacts.find(c => c.id._serialized === chat.id._serialized);
            const contactName = wwContact?.name || wwContact?.pushname || '';
            const nameForDM = contactName || sc.name;
            
            // My last message text
            const lastMsgText = lastMyMsg ? (lastMyMsg.body || '(media)').slice(0, 200) : '';
            
            results.push({
                index: idx+1, name: sc.name, number: sc.number,
                contactName, nameForDM,
                status: 'ok',
                delivered, read,
                totalMsgs: msgs.length, myMsgs: myMsgs.length, theirMsgs: theirMsgs.length,
                stage, tone,
                businessTypes: businessTypes.length ? businessTypes : ['general'],
                timeline,
                lastMsgFromMe: youLast,
                lastMsgText,
                lastDate: sc.lastDate
            });
            
            process.stdout.write('\r  ['+(idx+1)+'/'+TOTAL+'] '+nameForDM.slice(0,25)+' | '+msgs.length+'msgs | '+(delivered?'✅':'❌')+' | '+tone);
            
        } catch(e) {
            results.push({ index: idx+1, name: sc.name, number: sc.number, status: 'error', error: e.message });
            process.stdout.write('\r  ['+(idx+1)+'/'+TOTAL+'] ERROR: '+sc.name);
        }
    }
    
    const output = {
        totalAnalyzed: TOTAL,
        contacts: results,
        scheduleConfig: {
            startDate: '2026-05-26',
            days: 10,
            dailyRange: { min: 50, max: 80 },
            sendWindows: ['07:00-09:00', '19:00-21:00']
        }
    };
    
    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
    console.log('\n\n✅ FULL ANALYSIS COMPLETE');
    console.log('Saved to: ' + OUTPUT);
    console.log('Total: ' + results.length);
    console.log('Delivered: ' + results.filter(r => r.delivered).length);
    console.log('Not delivered: ' + results.filter(r => r.status==='ok' && !r.delivered).length);
    console.log('No chat found: ' + results.filter(r => r.status==='no_chat_found').length);
    process.exit(0);
});

client.initialize().catch(e => { console.log('FATAL:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 600000);
