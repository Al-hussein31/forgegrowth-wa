const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CAMPAIGN = path.join(ROOT, 'dm_campaign.json');
const MAX_PER_DAY = 25;
const MIN_LEAD_MINUTES = 20;
const WINDOWS = [
    { start: '09:15', end: '11:45' },
    { start: '13:30', end: '16:30' },
    { start: '18:30', end: '20:45' }
];

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
}

function parseArgs(argv) {
    return {
        dryRun: !argv.includes('--write')
    };
}

function timeToMinutes(value) {
    const [hh, mm] = value.split(':').map(Number);
    return hh * 60 + mm;
}

function dateAtMinute(day, minute) {
    const date = new Date(day);
    date.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    return date;
}

function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function yyyyMmDd(date) {
    return date.toISOString().slice(0, 10);
}

function countPendingByDay(schedule) {
    const counts = {};
    for (const item of schedule) {
        if (item.status === 'sent' || item.status === 'cancelled') continue;
        const day = yyyyMmDd(new Date(item.sendAt));
        counts[day] = (counts[day] || 0) + 1;
    }
    return counts;
}

function usedTimes(schedule) {
    return new Set(schedule.map(item => item.sendAt));
}

function nextSlot(schedule, counts, used, now) {
    const earliest = new Date(now.getTime() + MIN_LEAD_MINUTES * 60 * 1000);

    for (let dayOffset = 0; dayOffset < 45; dayOffset++) {
        const day = new Date(now);
        day.setHours(0, 0, 0, 0);
        day.setDate(day.getDate() + dayOffset);
        const key = yyyyMmDd(day);
        if ((counts[key] || 0) >= MAX_PER_DAY) continue;

        for (let attempt = 0; attempt < 300; attempt++) {
            const window = WINDOWS[randomInt(0, WINDOWS.length - 1)];
            const minute = randomInt(timeToMinutes(window.start), timeToMinutes(window.end));
            const candidate = dateAtMinute(day, minute);
            if (candidate <= earliest) continue;
            const iso = candidate.toISOString();
            if (used.has(iso)) continue;
            used.add(iso);
            counts[key] = (counts[key] || 0) + 1;
            return iso;
        }
    }

    throw new Error('Could not find a future schedule slot');
}

function reschedule(campaign, options) {
    const now = new Date();
    const counts = countPendingByDay(campaign.schedule);
    const used = usedTimes(campaign.schedule);
    const changed = [];

    for (const item of campaign.schedule) {
        if (item.status !== 'pending') continue;
        const dueAt = new Date(item.nextAttemptAt || item.sendAt);
        if (Number.isNaN(dueAt.getTime()) || dueAt >= now) continue;

        const oldSendAt = item.sendAt;
        const oldNextAttemptAt = item.nextAttemptAt || item.sendAt;
        const oldDay = yyyyMmDd(new Date(item.sendAt));
        counts[oldDay] = Math.max(0, (counts[oldDay] || 1) - 1);
        used.delete(item.sendAt);

        const newSendAt = nextSlot(campaign.schedule, counts, used, now);
        item.sendAt = newSendAt;
        item.nextAttemptAt = newSendAt;
        item.rescheduledAt = now.toISOString();
        item.rescheduleReason = 'overdue_pending';
        item.lastError = item.lastError || 'Scheduled time passed before send';

        changed.push({
            id: item.id,
            reviewStatus: item.reviewStatus,
            oldSendAt,
            oldNextAttemptAt,
            newSendAt
        });
    }

    if (changed.length) {
        campaign.lastRescheduledAt = now.toISOString();
        campaign.lastRescheduledCount = changed.length;
    }

    return changed;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const campaign = readJson(CAMPAIGN);
    const changed = reschedule(campaign, options);

    if (!options.dryRun && changed.length) {
        writeJsonAtomic(CAMPAIGN, campaign);
    }

    console.log(JSON.stringify({
        mode: options.dryRun ? 'dry-run' : 'write',
        changed: changed.length,
        items: changed
    }, null, 2));
}

main();
