/**
 * Safe campaign sender.
 *
 * Default mode is DRY RUN. Nothing is sent unless both flags are present:
 *   --send --real-send-approved
 *
 * Test two real messages:
 *   node dm_sender.js --send --real-send-approved --max 2 --ids fgd-0001,fgd-0002 --ignore-time
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const wa = require('./wa_client.js');

const CAMPAIGN = path.join(__dirname, 'dm_campaign.json');
const SENT_LOG = path.join(__dirname, 'dm_sent_log.json');
const RETRY_DELAY_MS = 5 * 60 * 1000;

function parseArgs(argv) {
    const args = {
        send: false,
        approved: false,
        dryRun: true,
        max: null,
        ids: [],
        ignoreTime: false,
        list: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--send') args.send = true;
        else if (arg === '--real-send-approved') args.approved = true;
        else if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--ignore-time') args.ignoreTime = true;
        else if (arg === '--list') args.list = true;
        else if (arg === '--max') args.max = Number(argv[++i]);
        else if (arg.startsWith('--max=')) args.max = Number(arg.slice('--max='.length));
        else if (arg === '--ids') args.ids = String(argv[++i] || '').split(',').filter(Boolean);
        else if (arg.startsWith('--ids=')) args.ids = arg.slice('--ids='.length).split(',').filter(Boolean);
        else throw new Error(`Unknown argument: ${arg}`);
    }

    args.dryRun = !(args.send && args.approved);
    return args;
}

function readJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
}

function messageHash(item) {
    return crypto.createHash('sha256')
        .update(`${item.id}|${item.contact?.jid}|${item.dm}`)
        .digest('hex')
        .slice(0, 16);
}

function loadCampaign() {
    const campaign = readJson(CAMPAIGN, null);
    if (!campaign || !Array.isArray(campaign.schedule)) {
        throw new Error(`Invalid campaign file: ${CAMPAIGN}`);
    }
    return campaign;
}

function loadSentLog() {
    const existing = readJson(SENT_LOG, null);
    if (existing && Array.isArray(existing.sent)) {
        existing.failed = Array.isArray(existing.failed) ? existing.failed : [];
        existing.runs = Array.isArray(existing.runs) ? existing.runs : [];
        return existing;
    }
    if (Array.isArray(existing)) {
        return { sent: existing, failed: [], runs: [] };
    }
    return { sent: [], failed: [], runs: [] };
}

function isSentAlready(sentLog, item) {
    const hash = messageHash(item);
    return sentLog.sent.some(entry =>
        entry.id === item.id
        || entry.messageHash === hash
        || (entry.jid && entry.jid === item.contact?.jid && entry.status === 'sent')
    );
}

function isDue(item, now) {
    const sendAt = new Date(item.sendAt);
    const nextAttemptAt = new Date(item.nextAttemptAt || item.sendAt);
    return sendAt <= now && nextAttemptAt <= now;
}

function selectCandidates(campaign, sentLog, args) {
    const now = new Date();
    const idSet = new Set(args.ids);
    let items = campaign.schedule.filter(item => {
        if (!item || item.status === 'sent' || item.status === 'cancelled') return false;
        if (!item.contact?.jid) return false;
        if (isSentAlready(sentLog, item)) return false;
        if (!args.dryRun && item.reviewStatus !== 'approved') return false;
        if (idSet.size && !idSet.has(item.id)) return false;
        if (args.ignoreTime) return true;
        return isDue(item, now);
    });

    items = items.sort((a, b) => new Date(a.nextAttemptAt || a.sendAt) - new Date(b.nextAttemptAt || b.sendAt));
    if (Number.isInteger(args.max)) items = items.slice(0, args.max);
    return items;
}

function validateSafety(args) {
    if (args.ignoreTime && args.ids.length === 0) {
        throw new Error('--ignore-time requires explicit --ids');
    }

    if (!args.dryRun) {
        if (!Number.isInteger(args.max) || args.max < 1) {
            throw new Error('Real send requires --max N');
        }
        if (args.max > 25) {
            throw new Error('Refusing to send more than 25 messages in one run');
        }
        if (args.ignoreTime && args.max > args.ids.length) {
            throw new Error('--max cannot exceed the number of explicit --ids when --ignore-time is used');
        }
    }
}

function validateRealSendCandidates(candidates) {
    const unapproved = candidates.filter(item => item.reviewStatus !== 'approved');
    if (unapproved.length) {
        throw new Error(`Real send blocked. Approve these messages first: ${unapproved.map(item => item.id).join(', ')}`);
    }
}

async function hasNetwork() {
    try {
        await dns.lookup('web.whatsapp.com');
        return true;
    } catch (_) {
        return false;
    }
}

function markRetry(campaign, item, error) {
    const stored = campaign.schedule.find(entry => entry.id === item.id);
    if (!stored) return;
    stored.status = 'pending';
    stored.attempts = Number(stored.attempts || 0) + 1;
    stored.lastError = error.message || String(error);
    stored.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
}

function markSent(campaign, item, result) {
    const stored = campaign.schedule.find(entry => entry.id === item.id);
    if (!stored) return;
    stored.status = 'sent';
    stored.sentAt = new Date().toISOString();
    stored.ack = result?.ack ?? null;
    stored.waMessageId = result?.id?._serialized || result?.id?.id || null;
    stored.lastError = null;
}

function printItems(title, items) {
    console.log(`\n${title}: ${items.length}`);
    for (const item of items.slice(0, 20)) {
        console.log(`- ${item.id} | ${item.contact?.name || item.contact?.phone} | ${item.sendAt} | ${item.analysis?.businessType || 'business'}`);
        console.log(`  ${String(item.dm || '').split('\n').join(' ').slice(0, 170)}${item.dm?.length > 170 ? '...' : ''}`);
    }
    if (items.length > 20) console.log(`  ...and ${items.length - 20} more`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    validateSafety(args);

    const campaign = loadCampaign();
    const sentLog = loadSentLog();
    const candidates = selectCandidates(campaign, sentLog, args);

    console.log(`Campaign: ${campaign.total || campaign.schedule.length} generated messages`);
    console.log(`Mode: ${args.dryRun ? 'DRY RUN - no messages will be sent' : 'REAL SEND'}`);
    console.log(`Max: ${args.max ?? 'none'}`);
    if (args.ids.length) console.log(`IDs: ${args.ids.join(', ')}`);
    if (args.ignoreTime) console.log('Time filter: ignored for explicit test IDs');

    printItems(args.list ? 'Listed messages' : 'Selected messages', candidates);

    if (args.dryRun || args.list) {
        console.log('\nNo send happened.');
        console.log('For the 2-message test, use: node dm_sender.js --send --real-send-approved --max 2 --ids fgd-0001,fgd-0002 --ignore-time');
        return;
    }

    if (candidates.length === 0) {
        console.log('\nNo due/selected messages to send.');
        return;
    }

    validateRealSendCandidates(candidates);

    if (!(await hasNetwork())) {
        console.log('\nNetwork check failed. Keeping messages local and retrying later.');
        for (const item of candidates) markRetry(campaign, item, new Error('Network check failed'));
        writeJsonAtomic(CAMPAIGN, campaign);
        return;
    }

    console.log('\nConnecting to WhatsApp...');
    const connected = await wa.init();
    if (!connected) {
        console.log('WhatsApp is not ready. Keeping messages local and retrying later.');
        for (const item of candidates) markRetry(campaign, item, new Error('WhatsApp not ready'));
        writeJsonAtomic(CAMPAIGN, campaign);
        await wa.shutdown();
        return;
    }

    let sent = 0;
    let failed = 0;

    for (let i = 0; i < candidates.length; i++) {
        const item = candidates[i];
        if (i > 0) {
            const delay = 45000 + Math.floor(Math.random() * 60000);
            console.log(`Waiting ${Math.round(delay / 1000)}s before next send...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        try {
            console.log(`[${i + 1}/${candidates.length}] Sending ${item.id} to ${item.contact.jid}`);
            const result = await wa.sendMessage(item.contact.jid, item.dm);

            if ((result?.ack ?? 0) < 1) {
                throw new Error(`Message returned ACK ${result?.ack ?? 'unknown'}, not confirmed sent`);
            }

            markSent(campaign, item, result);
            sentLog.sent.push({
                id: item.id,
                jid: item.contact.jid,
                phone: item.contact.phone,
                contactName: item.contact.contactName || item.contact.name,
                sentAt: new Date().toISOString(),
                scheduledFor: item.sendAt,
                status: 'sent',
                ack: result.ack,
                waMessageId: result?.id?._serialized || result?.id?.id || null,
                messageHash: messageHash(item)
            });
            sent++;
            writeJsonAtomic(CAMPAIGN, campaign);
            writeJsonAtomic(SENT_LOG, sentLog);
            console.log(`  Sent with ACK ${result.ack}`);
        } catch (error) {
            failed++;
            markRetry(campaign, item, error);
            sentLog.failed.push({
                id: item.id,
                jid: item.contact.jid,
                phone: item.contact.phone,
                contactName: item.contact.contactName || item.contact.name,
                failedAt: new Date().toISOString(),
                error: error.message,
                messageHash: messageHash(item)
            });
            writeJsonAtomic(CAMPAIGN, campaign);
            writeJsonAtomic(SENT_LOG, sentLog);
            console.log(`  Failed: ${error.message}`);
        }
    }

    sentLog.runs.push({
        at: new Date().toISOString(),
        selected: candidates.length,
        sent,
        failed,
        ids: candidates.map(item => item.id)
    });
    writeJsonAtomic(SENT_LOG, sentLog);
    await wa.shutdown();

    console.log(`\nDone: ${sent} sent, ${failed} failed`);
}

main().catch(async error => {
    console.error('Fatal:', error.message);
    try { await wa.shutdown(); } catch (_) {}
    process.exit(1);
});
