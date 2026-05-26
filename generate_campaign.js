const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const INPUT = path.join(ROOT, 'contacts_full_analysis.json');
const OUTPUT = path.join(ROOT, 'dm_campaign.json');

const CONFIG = {
    days: 14,
    maxPerDay: 25,
    startDate: new Date(),
    windows: [
        { start: '09:15', end: '11:45' },
        { start: '13:30', end: '16:30' },
        { start: '18:30', end: '20:45' }
    ]
};

const PIDGIN_WORDS = [
    'dey', 'abeg', 'oya', 'na ', 'wey', 'wetin', 'abi', 'shebi',
    'bros', 'boss', 'my guy', 'how far', 'no wahala'
];

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
}

function normalizePhone(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw.includes('+') && /[a-z]/i.test(raw)) return null;

    let digits = raw.replace(/\D/g, '');
    if (!digits) return null;

    if (raw.trim().startsWith('+')) return digits;
    if (digits.length === 11 && digits.startsWith('0')) return `234${digits.slice(1)}`;
    if (digits.length === 10 && /^[789]/.test(digits)) return `234${digits}`;
    if (digits.length >= 8 && digits.length <= 15) return digits;
    return null;
}

function displayName(contact) {
    return contact.contactName || contact.nameForDM || contact.name || contact.number || 'there';
}

function firstUsableName(contact) {
    const name = displayName(contact).trim();
    if (!name || /^\+?\d[\d\s-]+$/.test(name)) return '';
    return name.split(/\s+/)[0].replace(/[^\w.'-]/g, '');
}

function contactPhone(contact) {
    return normalizePhone(contact.name) || normalizePhone(contact.nameForDM) || normalizePhone(contact.contactName);
}

function contactJid(contact) {
    const phone = contactPhone(contact);
    return phone ? `${phone}@c.us` : null;
}

function allConversationText(contact) {
    return (contact.timeline || [])
        .map(m => m.t || '')
        .join(' ')
        .toLowerCase();
}

function latestTheirMessage(contact) {
    return [...(contact.timeline || [])].reverse().find(m => !m.fm && m.t && m.t !== '(media/sticker)');
}

function latestHumanTheirMessage(contact) {
    return [...(contact.timeline || [])].reverse().find(m => {
        if (m.fm || !m.t || m.t === '(media/sticker)') return false;
        return !isLikelyAutoReply(m.t);
    });
}

function latestMeaningfulTheirMessage(contact) {
    return [...(contact.timeline || [])].reverse().find(m => {
        if (m.fm || !m.t || m.t === '(media/sticker)') return false;
        if (isLikelyAutoReply(m.t) || isLowSignalReply(m.t)) return false;
        return true;
    });
}

function latestMyMessage(contact) {
    return [...(contact.timeline || [])].reverse().find(m => m.fm && m.t && m.t !== '(media/sticker)');
}

function cleanSnippet(text, max = 120) {
    if (!text) return '';
    return String(text)
        .replace(/\s+/g, ' ')
        .replace(/\*/g, '')
        .trim()
        .slice(0, max);
}

function includesAny(text, words) {
    return words.some(word => text.includes(word));
}

function isLikelyAutoReply(text) {
    const clean = String(text || '').toLowerCase();
    return clean.includes('thank you for contacting')
        || clean.includes('please let us know how we can help')
        || clean.includes('to serve you seamlessly')
        || clean.includes('what location;')
        || clean.includes('business details:');
}

function isLowSignalReply(text) {
    const clean = String(text || '').toLowerCase().replace(/[^\w\s]/g, '').trim();
    return [
        'ok', 'okay', 'k', 'yes', 'no', 'thanks', 'thank you', 'thanks you',
        'alright', 'noted', 'hello', 'hi', 'hey'
    ].includes(clean);
}

function isPhoneOnlyText(text) {
    const clean = String(text || '').toLowerCase().trim();
    const digits = clean.replace(/\D/g, '');
    return digits.length >= 8 && (
        clean.includes('phone number')
        || clean.includes('my number')
        || /^[+\d\s().-]+$/.test(clean)
    );
}

function businessPhrase(type) {
    const labels = {
        'catering/restaurant': 'catering business',
        'printing/packaging': 'printing or packaging business',
        'shortlet/real estate': 'shortlet or real estate business',
        'events/service business': 'event or service business',
        'auto/service business': 'auto service business',
        'retail/shop': 'shop or retail business',
        'education': 'education business',
        'business': 'business'
    };
    return labels[type] || 'business';
}

function extractBusinessName(contact) {
    const text = (contact.timeline || [])
        .map(m => m.t || '')
        .find(t => /thank you for contacting/i.test(t));
    if (text) {
        const match = text.match(/thank you for contacting\s+([^!\n]+)/i);
        if (match && match[1]) return cleanSnippet(match[1], 50);
    }

    const latest = latestHumanTheirMessage(contact);
    if (latest && /business name:\s*([^\n]+)/i.test(latest.t)) {
        return cleanSnippet(latest.t.match(/business name:\s*([^\n]+)/i)[1], 50);
    }

    const named = [...(contact.timeline || [])].reverse().find(m => {
        if (m.fm || !m.t || isLikelyAutoReply(m.t) || isLowSignalReply(m.t)) return false;
        const clean = cleanSnippet(m.t, 60);
        return /^[a-z0-9 .,&'-]{3,60}$/i.test(clean) && clean.split(/\s+/).length <= 5;
    });
    if (named) return cleanSnippet(named.t, 50);

    return '';
}

function isEligibleContact(contact) {
    const text = allConversationText(contact);
    const name = displayName(contact).toLowerCase();
    if (name.includes('forge-ops')) return false;
    if (text.includes("i'm the one creating you") || text.includes('i am the one creating you')) return false;
    if (text.includes('test send me an invoice')) return false;
    return true;
}

function inferTone(contact) {
    const text = allConversationText(contact);
    if (contact.tone === 'pidgin/informal') return 'pidgin';
    if (contact.tone === 'mixed' || includesAny(text, PIDGIN_WORDS)) return 'warm';
    if ((contact.theirMsgs || 0) <= 1 && (contact.myMsgs || 0) <= 2) return 'brief';
    return 'formal';
}

function inferBusiness(contact) {
    const types = contact.businessTypes || [];
    const text = allConversationText(contact);

    if (
        types.includes('events/planning')
        || includesAny(text, ['event', 'dj', 'music producer', 'photographer', 'video', 'sound engineer', 'performer', 'entertainer', 'content creator'])
    ) return {
        type: 'events/service business',
        customer: 'clients',
        details: 'event date, location, service needed, budget, package choice and booking details',
        pain: 'clients ask about packages, prices and availability on WhatsApp'
    };

    if (types.includes('food/restaurant')) return {
        type: 'catering/restaurant',
        customer: 'customers',
        details: 'menu, packages, photos, booking details, event date and delivery/location info',
        pain: 'people ask about menu, price and availability on WhatsApp'
    };
    if (types.includes('printing/design')) return {
        type: 'printing/packaging',
        customer: 'customers',
        details: 'paper size, quantity, design needs, prices, delivery date and order details',
        pain: 'customers ask for quotes and order details on WhatsApp'
    };
    if (types.includes('hospitality/realestate')) return {
        type: 'shortlet/real estate',
        customer: 'guests and prospects',
        details: 'location, check-in date, duration, number of guests, availability and budget',
        pain: 'people ask about rooms, dates, location and availability on WhatsApp'
    };
    if (types.includes('automotive')) return {
        type: 'auto/service business',
        customer: 'customers',
        details: 'service needed, car details, location, budget and booking time',
        pain: 'customers ask questions and expect quick replies on WhatsApp'
    };
    if (types.includes('retail/shop')) return {
        type: 'retail/shop',
        customer: 'buyers',
        details: 'product interest, size/spec, price, location and delivery details',
        pain: 'buyers ask price and availability on WhatsApp'
    };
    if (text.includes('school') || text.includes('student') || text.includes('class')) return {
        type: 'education',
        customer: 'parents/students',
        details: 'class, fees, schedule, location and enrollment details',
        pain: 'people ask the same questions on WhatsApp before deciding'
    };

    return {
        type: 'business',
        customer: 'customers',
        details: 'what they need, price questions, booking/order details and contact information',
        pain: 'customers ask questions on WhatsApp and expect fast replies'
    };
}

function inferRelationship(contact) {
    const theirMsgs = contact.theirMsgs || 0;
    const myMsgs = contact.myMsgs || 0;
    const text = allConversationText(contact);

    if (text.includes('payment confirmed') || text.includes('invoice')) return 'customer/active lead';
    if (text.includes('price') || text.includes('how much') || text.includes('package') || text.includes('account details')) return 'pricing lead';
    if (text.includes('waitlist') || text.includes('beta list') || text.includes('onboard')) return 'beta/warm lead';
    if (theirMsgs >= 3 && myMsgs >= 3) return 'warm lead';
    if (theirMsgs > 0) return 'replied lead';
    return 'cold/no-reply lead';
}

function inferStrategy(contact) {
    const text = allConversationText(contact);
    if (!contact.delivered || contact.stage === 'message_not_delivered') return 'reconnect-undelivered';
    if (contact.stage === 'awaiting_your_reply') return 'reply-and-pivot';
    if (text.includes('end of the year') || text.includes('later') || text.includes('not that soon')) return 'no-pressure-pivot';
    if (text.includes('manual')) return 'manual-reply-pain';
    if (text.includes('how much') || text.includes('price') || text.includes('package')) return 'value-before-price';
    if (contact.stage === 'no_reply_yet') return 'soft-reconnect';
    return 'warm-permission';
}

function summarizeConversation(contact) {
    const their = latestMeaningfulTheirMessage(contact) || latestHumanTheirMessage(contact) || latestTheirMessage(contact);
    const mine = latestMyMessage(contact);
    const pieces = [];

    if (their) pieces.push(`They last said: "${cleanSnippet(their.t)}"`);
    if (mine) pieces.push(`You last said: "${cleanSnippet(mine.t)}"`);
    if (!pieces.length) pieces.push('No meaningful text history beyond media/stickers.');
    return pieces.join(' ');
}

function analyzeContact(contact) {
    const business = inferBusiness(contact);
    const phone = contactPhone(contact);
    const jid = contactJid(contact);

    return {
        tone: inferTone(contact),
        relationship: inferRelationship(contact),
        businessType: business.type,
        customerLabel: business.customer,
        automationDetails: business.details,
        painPoint: business.pain,
        strategy: inferStrategy(contact),
        lastConversationSummary: summarizeConversation(contact),
        lastMessageDelivered: Boolean(contact.delivered),
        lastMessageRead: Boolean(contact.read),
        sendable: Boolean(jid),
        phone,
        jid
    };
}

function greeting(contact, analysis) {
    const name = firstUsableName(contact);
    const honorific = analysis.tone === 'pidgin' || analysis.tone === 'warm' ? 'Boss' : '';
    if (name) return `Good morning ${name}, Hussein from Forge Growth.`;
    if (analysis.tone === 'pidgin') return 'Boss good morning, Hussein from Forge Growth.';
    if ((contact.name || '').includes('+') && analysis.businessType.includes('catering')) return 'Good morning ma, Hussein from Forge Growth.';
    if ((contact.name || '').includes('+')) return 'Good morning, Hussein from Forge Growth.';
    return `Good morning ${honorific || 'there'}, Hussein from Forge Growth.`;
}

function contextLine(contact, analysis) {
    const their = latestMeaningfulTheirMessage(contact);
    const business = extractBusinessName(contact);
    const businessName = firstUsableName(contact);
    const phrase = businessPhrase(analysis.businessType);

    if (analysis.strategy === 'reconnect-undelivered') {
        return 'Not sure my last message entered well, so I just wanted to reconnect properly.';
    }

    if (analysis.strategy === 'reply-and-pivot' && their && !isPhoneOnlyText(their.t)) {
        return `I saw your last message: "${cleanSnippet(their.t, 80)}". I wanted to follow up with something that may help your ${phrase} directly.`;
    }

    if (analysis.strategy === 'reply-and-pivot' && business) {
        return `I saw the message from ${business}, so I wanted to follow up with something that may help your ${phrase} directly.`;
    }

    if (analysis.strategy === 'reply-and-pivot') {
        return `I remembered our chat, so I wanted to follow up with something that may help your ${phrase} directly.`;
    }

    if (analysis.strategy === 'no-pressure-pivot') {
        return 'I remembered you said the bigger website plan may be for later. No pressure on that at all.';
    }

    if (analysis.strategy === 'manual-reply-pain') {
        return `I remembered you said you handle replies manually, so I wanted to show you something that can reduce that stress for your ${phrase}.`;
    }

    if (analysis.relationship === 'beta/warm lead') {
        return 'I remembered I added you to the beta list before, so I wanted to come back with the clearest version of what we built.';
    }

    if (analysis.relationship === 'pricing lead') {
        return 'I remembered our chat around pricing and getting your business properly set up online.';
    }

    if (business) {
        return `I remembered our chat around ${business} and your ${phrase}.`;
    }

    if (businessName) {
        return `I remembered our chat about your ${phrase}.`;
    }

    return `I wanted to quickly show you something we built for ${phrase} owners.`;
}

function valueLine(analysis) {
    return `We built a WhatsApp system that can reply ${analysis.customerLabel} automatically, collect ${analysis.automationDetails}, and keep serious inquiries organized before you respond.`;
}

function permissionLine(analysis) {
    if (analysis.tone === 'pidgin') {
        return 'If e make sense, I fit show you a quick demo so you see how e work.';
    }
    if (analysis.tone === 'brief') {
        return 'If this sounds useful, I can show you a quick demo.';
    }
    return 'If you are interested, I can show you a quick demo so you see how it works.';
}

function buildDm(contact, analysis) {
    if (analysis.tone === 'pidgin') {
        return [
            greeting(contact, analysis),
            '',
            'I remember say we don talk before about your business and how customer follow-up fit stress person sometimes.',
            '',
            `We build one WhatsApp system wey fit reply customers automatically, ask them ${analysis.automationDetails}, and keep the chat going before you come online.`,
            '',
            permissionLine(analysis)
        ].join('\n');
    }

    return [
        greeting(contact, analysis),
        '',
        contextLine(contact, analysis),
        '',
        valueLine(analysis),
        '',
        permissionLine(analysis)
    ].join('\n');
}

function parseTimeToMinutes(value) {
    const [hh, mm] = value.split(':').map(Number);
    return hh * 60 + mm;
}

function minutesToDate(date, minutes) {
    const next = new Date(date);
    next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return next;
}

function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function buildSlots(count, config) {
    const daysNeeded = Math.max(config.days, Math.ceil(count / config.maxPerDay));
    const totalCapacity = daysNeeded * config.maxPerDay;
    if (count > totalCapacity) {
        throw new Error(`Need ${count} slots but only ${totalCapacity} available. Increase days or maxPerDay.`);
    }

    const slots = [];
    const used = new Set();
    const start = new Date(config.startDate);
    start.setHours(0, 0, 0, 0);

    for (let day = 0; day < daysNeeded; day++) {
        const date = new Date(start);
        date.setDate(start.getDate() + day);

        let daySlots = [];
        let guard = 0;
        while (daySlots.length < config.maxPerDay && guard < 5000) {
            guard++;
            const window = config.windows[randomInt(0, config.windows.length - 1)];
            const minute = randomInt(parseTimeToMinutes(window.start), parseTimeToMinutes(window.end));
            const candidate = minutesToDate(date, minute);
            const iso = candidate.toISOString();
            if (candidate <= new Date()) continue;
            if (used.has(iso)) continue;
            used.add(iso);
            daySlots.push(iso);
        }

        slots.push(...daySlots.sort());
    }

    return slots.slice(0, count).sort();
}

function scoreContact(contact) {
    let score = 0;
    if (contact.delivered) score += 20;
    if (contact.read) score += 15;
    if ((contact.theirMsgs || 0) > 0) score += 20;
    if (contact.stage === 'awaiting_your_reply') score += 20;
    if (contact.stage === 'waiting_for_reply') score += 10;
    if (allConversationText(contact).includes('manual')) score += 15;
    if (allConversationText(contact).includes('how much')) score += 10;
    if (contactPhone(contact)) score += 30;
    return score;
}

function main() {
    const data = readJson(INPUT);
    const contacts = data.contacts
        .filter(c => c.status === 'ok')
        .filter(isEligibleContact)
        .map(c => {
            const analysis = analyzeContact(c);
            return {
                contact: {
                    index: c.index,
                    name: c.name,
                    number: c.number,
                    contactName: c.contactName,
                    nameForDM: c.nameForDM,
                    status: c.status,
                    delivered: c.delivered,
                    read: c.read,
                    stage: c.stage,
                    tone: c.tone,
                    businessTypes: c.businessTypes,
                    lastDate: c.lastDate,
                    phone: analysis.phone,
                    jid: analysis.jid
                },
                analysis,
                dm: buildDm(c, analysis),
                priorityScore: scoreContact(c)
            };
        })
        .filter(item => item.analysis.sendable)
        .sort((a, b) => b.priorityScore - a.priorityScore);

    const daysNeeded = Math.max(CONFIG.days, Math.ceil(contacts.length / CONFIG.maxPerDay));
    const slots = buildSlots(contacts.length, CONFIG);
    const schedule = contacts.map((item, index) => ({
        id: `fgd-${String(index + 1).padStart(4, '0')}`,
        contact: item.contact,
        analysis: item.analysis,
        dm: item.dm,
        sendAt: slots[index],
        day: Math.floor(index / CONFIG.maxPerDay) + 1,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: slots[index],
        lastError: null,
        waMessageId: null,
        ack: null,
        reviewStatus: 'needs_review'
    })).sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));

    const skipped = data.contacts
        .filter(c => c.status === 'ok')
        .filter(c => !contactJid(c) || !isEligibleContact(c))
        .map(c => ({
            index: c.index,
            name: c.name,
            number: c.number,
            reason: !isEligibleContact(c)
                ? 'Skipped likely internal/test conversation.'
                : 'No sendable phone number could be normalized from contact name.'
        }));

    const result = {
        version: 2,
        generatedAt: new Date().toISOString(),
        objective: 'Ask permission to show a Forge Growth WhatsApp automation demo. Do not send demo links in this first DM.',
        total: schedule.length,
        skipped: skipped.length,
        requestedDays: CONFIG.days,
        days: daysNeeded,
        maxPerDay: CONFIG.maxPerDay,
        sendWindows: CONFIG.windows,
        startDate: schedule[0]?.sendAt?.slice(0, 10) || null,
        endDate: schedule[schedule.length - 1]?.sendAt?.slice(0, 10) || null,
        schedule,
        skippedContacts: skipped
    };

    writeJsonAtomic(OUTPUT, result);

    const perDay = {};
    for (const item of schedule) {
        const day = item.sendAt.slice(0, 10);
        perDay[day] = (perDay[day] || 0) + 1;
    }

    console.log('=== PERSONALIZED PERMISSION CAMPAIGN GENERATED ===');
    console.log(`Generated: ${result.total}`);
    console.log(`Skipped unsendable: ${result.skipped}`);
    console.log(`Requested days: ${result.requestedDays}`);
    console.log(`Actual days: ${result.days}, max/day: ${result.maxPerDay}`);
    console.log(`Range: ${result.startDate} -> ${result.endDate}`);
    console.log('\nPer day:');
    for (const [day, count] of Object.entries(perDay)) console.log(`  ${day}: ${count}`);
    console.log('\nSamples:');
    for (const sample of schedule.slice(0, 5)) {
        console.log(`\n--- ${sample.id} | ${sample.contact.name} | ${sample.analysis.businessType} | ${sample.analysis.strategy} ---`);
        console.log(sample.dm);
    }
    console.log(`\nSaved to: ${OUTPUT}`);
}

main();
