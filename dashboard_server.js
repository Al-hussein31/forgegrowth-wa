const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
let wa;
try { wa = require('./wa_manager.js'); } catch (e) { wa = null; }

const ROOT = __dirname;
const CAMPAIGN = path.join(ROOT, 'dm_campaign.json');
const SENT_LOG = path.join(ROOT, 'dm_sent_log.json');
const AUTOMATION_STATE = path.join(ROOT, 'automation_state.json');
const RUNNER_LOG = path.join(ROOT, 'automation_runner.log');
const PORT = Number(process.env.PORT || 3030);

function readJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
}

function loadCampaign() {
    const campaign = readJson(CAMPAIGN, null);
    if (!campaign || !Array.isArray(campaign.schedule)) {
        return { version: 1, generatedAt: null, objective: '', total: 0, skipped: 0, days: 0, startDate: null, endDate: null, schedule: [] };
    }
    let changed = false;
    for (const item of campaign.schedule) {
        if (!item.reviewStatus) {
            item.reviewStatus = 'needs_review';
            changed = true;
        }
    }
    if (changed) writeJsonAtomic(CAMPAIGN, campaign);
    return campaign;
}

function loadSentLog() {
    return readJson(SENT_LOG, { sent: [], failed: [], runs: [] });
}

function isPidRunning(pid) {
    if (!pid || !Number.isInteger(Number(pid))) return false;
    try {
        process.kill(Number(pid), 0);
        return true;
    } catch (_) {
        return false;
    }
}

function loadAutomationState() {
    const state = readJson(AUTOMATION_STATE, {
        status: 'stopped',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        heartbeatAt: null,
        lastRunAt: null,
        lastOutput: '',
        lastError: null
    });
    const running = isPidRunning(state.pid) && state.status === 'running';
    return {
        ...state,
        running,
        status: running ? 'running' : (state.status === 'running' ? 'stale' : state.status || 'stopped')
    };
}

function saveAutomationState(patch) {
    const current = readJson(AUTOMATION_STATE, {});
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    writeJsonAtomic(AUTOMATION_STATE, next);
    return loadAutomationState();
}

function startAutomation() {
    const current = loadAutomationState();
    if (current.running) return current;

    const out = fs.openSync(RUNNER_LOG, 'a');
    const child = spawn(process.execPath, ['campaign_runner.js'], {
        cwd: ROOT,
        env: process.env,
        detached: true,
        stdio: ['ignore', out, out]
    });
    child.unref();

    return saveAutomationState({
        status: 'running',
        pid: child.pid,
        startedAt: new Date().toISOString(),
        stopRequested: false,
        lastError: null
    });
}

function stopAutomation() {
    const current = loadAutomationState();
    saveAutomationState({ stopRequested: true, status: current.running ? 'stopping' : 'stopped' });
    if (current.pid && isPidRunning(current.pid)) {
        try {
            process.kill(Number(current.pid), 'SIGTERM');
        } catch (_) {}
    }
    return saveAutomationState({
        status: 'stopped',
        stoppedAt: new Date().toISOString(),
        stopRequested: false
    });
}

function sendJson(res, status, data) {
    const json = JSON.stringify(data, null, 2);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(json);
}

function sendGzipJson(res, status, data, accept) {
    const json = JSON.stringify(data, null, 2);
    if (accept && accept.includes('gzip') && json.length > 1024) {
        const compressed = zlib.gzipSync(json);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Encoding': 'gzip',
            'Cache-Control': 'no-store'
        });
        res.end(compressed);
    } else {
        sendJson(res, status, data);
    }
}

function sendHtml(res, html) {
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(html);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 2_000_000) reject(new Error('Request body too large'));
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function summarize(campaign, sentLog) {
    const counts = {};
    const review = {};
    const perDay = {};
    for (const item of campaign.schedule) {
        counts[item.status || 'pending'] = (counts[item.status || 'pending'] || 0) + 1;
        review[item.reviewStatus || 'needs_review'] = (review[item.reviewStatus || 'needs_review'] || 0) + 1;
        const day = String(item.sendAt || '').slice(0, 10);
        if (day) perDay[day] = (perDay[day] || 0) + 1;
    }
    const pending = campaign.schedule
        .filter(item => (item.status || 'pending') === 'pending')
        .sort((a, b) => new Date(a.nextAttemptAt || a.sendAt) - new Date(b.nextAttemptAt || b.sendAt));

    return {
        total: campaign.schedule.length,
        skipped: campaign.skipped || 0,
        generatedAt: campaign.generatedAt,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        days: campaign.days,
        maxPerDay: campaign.maxPerDay,
        counts,
        review,
        perDay,
        next: pending[0] || null,
        sentLog: {
            sent: Array.isArray(sentLog.sent) ? sentLog.sent.length : 0,
            failed: Array.isArray(sentLog.failed) ? sentLog.failed.length : 0,
            runs: Array.isArray(sentLog.runs) ? sentLog.runs.length : 0
        }
    };
}

function publicItem(item) {
    return {
        id: item.id,
        contact: item.contact,
        analysis: item.analysis,
        dm: item.dm,
        sendAt: item.sendAt,
        nextAttemptAt: item.nextAttemptAt,
        day: item.day,
        status: item.status || 'pending',
        reviewStatus: item.reviewStatus || 'needs_review',
        attempts: item.attempts || 0,
        lastError: item.lastError || null,
        ack: item.ack ?? null,
        sentAt: item.sentAt || null
    };
}

function publicItemList(item) {
    return {
        id: item.id,
        contact: { name: item.contact?.name, phone: item.contact?.phone, contactName: item.contact?.contactName },
        analysis: item.analysis ? { businessType: item.analysis.businessType, strategy: item.analysis.strategy, tone: item.analysis.tone, relationship: item.analysis.relationship } : null,
        dm: (item.dm || '').slice(0, 120),
        sendAt: item.sendAt,
        day: item.day,
        status: item.status || 'pending',
        reviewStatus: item.reviewStatus || 'needs_review',
        ack: item.ack ?? null
    };
}

function runSender(args) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['dm_sender.js', ...args], {
            cwd: ROOT,
            env: process.env
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { output += chunk.toString(); });
        child.on('close', code => resolve({ code, output }));
    });
}

function runRescheduler(write) {
    return new Promise((resolve) => {
        const args = ['reschedule_overdue.js'];
        if (write) args.push('--write');
        const child = spawn(process.execPath, args, {
            cwd: ROOT,
            env: process.env
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { output += chunk.toString(); });
        child.on('close', code => resolve({ code, output }));
    });
}

function runWaStatus() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['wa_status.js'], {
            cwd: ROOT,
            env: process.env
        });
        let output = '';
        const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            resolve({
                connected: false,
                status: 'timeout',
                checkedAt: new Date().toISOString(),
                error: 'WhatsApp status check timed out'
            });
        }, 70000);

        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { output += chunk.toString(); });
        child.on('close', () => {
            clearTimeout(timeout);
            const jsonLine = output.trim().split('\n').reverse().find(line => line.trim().startsWith('{'));
            if (!jsonLine) {
                return resolve({
                    connected: false,
                    status: 'error',
                    checkedAt: new Date().toISOString(),
                    error: output.trim() || 'No status output'
                });
            }
            try {
                resolve(JSON.parse(jsonLine));
            } catch (error) {
                resolve({
                    connected: false,
                    status: 'error',
                    checkedAt: new Date().toISOString(),
                    error: error.message
                });
            }
        });
    });
}

async function handleApi(req, res, url) {
    try {
        if (req.method === 'GET' && url.pathname === '/api/campaign') {
            const campaign = loadCampaign();
            const sentLog = loadSentLog();
            return sendGzipJson(res, 200, {
                summary: summarize(campaign, sentLog),
                automation: loadAutomationState(),
                schedule: campaign.schedule.map(publicItemList),
                skippedContacts: campaign.skippedContacts || []
            }, req.headers['accept-encoding']);
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/message/')) {
            const id = decodeURIComponent(url.pathname.split('/').pop());
            const campaign = loadCampaign();
            const item = campaign.schedule.find(entry => entry.id === id);
            if (!item) return sendJson(res, 404, { error: 'Message not found' });
            return sendGzipJson(res, 200, publicItem(item), req.headers['accept-encoding']);
        }

        if (req.method === 'GET' && url.pathname === '/api/automation/status') {
            return sendJson(res, 200, loadAutomationState());
        }

        if (req.method === 'POST' && url.pathname === '/api/automation/start') {
            return sendJson(res, 200, startAutomation());
        }

        if (req.method === 'POST' && url.pathname === '/api/automation/stop') {
            return sendJson(res, 200, stopAutomation());
        }

        if (url.pathname === '/api/wa/status' || url.pathname === '/api/wa/connect' || url.pathname === '/api/wa/pair' || url.pathname === '/api/wa/disconnect' || url.pathname === '/api/wa/reset') {
            if (!wa) return sendJson(res, 500, { error: 'WhatsApp manager not available' });
        }

        if (req.method === 'GET' && url.pathname === '/api/wa/status') {
            return sendJson(res, 200, wa.getStatus());
        }

        if (req.method === 'POST' && url.pathname === '/api/wa/connect') {
            return sendJson(res, 200, await wa.init());
        }

        if (req.method === 'POST' && url.pathname === '/api/wa/pair') {
            const body = await readBody(req);
            return sendJson(res, 200, await wa.requestPairingCode(body.phone || ''));
        }

        if (req.method === 'POST' && url.pathname === '/api/wa/disconnect') {
            return sendJson(res, 200, await wa.disconnect());
        }

        if (req.method === 'POST' && url.pathname === '/api/wa/reset') {
            return sendJson(res, 200, await wa.resetSession());
        }

        if (req.method === 'POST' && url.pathname === '/api/reschedule-overdue') {
            const result = await runRescheduler(true);
            return sendJson(res, 200, result);
        }

        if (req.method === 'PATCH' && url.pathname.startsWith('/api/messages/')) {
            const id = decodeURIComponent(url.pathname.split('/').pop());
            const body = await readBody(req);
            const campaign = loadCampaign();
            const item = campaign.schedule.find(entry => entry.id === id);
            if (!item) return sendJson(res, 404, { error: 'Message not found' });
            if (typeof body.dm === 'string') item.dm = body.dm.trim();
            if (typeof body.sendAt === 'string') {
                const parsed = new Date(body.sendAt);
                if (Number.isNaN(parsed.getTime())) return sendJson(res, 400, { error: 'Invalid sendAt' });
                item.sendAt = parsed.toISOString();
                item.nextAttemptAt = item.nextAttemptAt || item.sendAt;
            }
            if (typeof body.reviewStatus === 'string') {
                const allowed = new Set(['needs_review', 'approved', 'rejected']);
                if (!allowed.has(body.reviewStatus)) return sendJson(res, 400, { error: 'Invalid reviewStatus' });
                item.reviewStatus = body.reviewStatus;
            }
            item.updatedAt = new Date().toISOString();
            writeJsonAtomic(CAMPAIGN, campaign);
            return sendJson(res, 200, { item: publicItem(item) });
        }

        if (req.method === 'POST' && url.pathname === '/api/messages/bulk-review') {
            const body = await readBody(req);
            const ids = Array.isArray(body.ids) ? body.ids : [];
            const reviewStatus = body.reviewStatus;
            const allowed = new Set(['needs_review', 'approved', 'rejected']);
            if (!allowed.has(reviewStatus)) return sendJson(res, 400, { error: 'Invalid reviewStatus' });
            const campaign = loadCampaign();
            let changed = 0;
            for (const item of campaign.schedule) {
                if (ids.includes(item.id)) {
                    item.reviewStatus = reviewStatus;
                    item.updatedAt = new Date().toISOString();
                    changed++;
                }
            }
            writeJsonAtomic(CAMPAIGN, campaign);
            return sendJson(res, 200, { changed });
        }

        if (req.method === 'POST' && url.pathname === '/api/send/dry-run') {
            const body = await readBody(req);
            const ids = Array.isArray(body.ids) ? body.ids : [];
            if (!ids.length) return sendJson(res, 400, { error: 'Select at least one message' });
            if (ids.length > 25) return sendJson(res, 400, { error: 'Dry-run is capped at 25 selected messages' });
            const result = await runSender(['--ids', ids.join(','), '--ignore-time', '--max', String(ids.length)]);
            return sendJson(res, 200, result);
        }

        if (req.method === 'POST' && url.pathname === '/api/send/real') {
            const body = await readBody(req);
            const ids = Array.isArray(body.ids) ? body.ids : [];
            if (body.confirm !== 'SEND 2') return sendJson(res, 400, { error: 'Type SEND 2 to confirm' });
            if (ids.length !== 2) return sendJson(res, 400, { error: 'Select exactly 2 messages for this test' });
            const campaign = loadCampaign();
            const selected = campaign.schedule.filter(item => ids.includes(item.id));
            const blocked = selected.filter(item => item.reviewStatus !== 'approved');
            if (blocked.length) return sendJson(res, 400, { error: `Approve first: ${blocked.map(item => item.id).join(', ')}` });
            const result = await runSender(['--send', '--real-send-approved', '--ids', ids.join(','), '--ignore-time', '--max', '2']);
            return sendJson(res, 200, result);
        }

        return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
        return sendJson(res, 500, { error: error.message });
    }
}

function page() {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ForgeGrowth DM Review</title>
<style>
:root {
  color-scheme: light;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #17202a;
  --muted: #64748b;
  --line: #d9e1ea;
  --accent: #0f8b8d;
  --accent-2: #f25f5c;
  --ok: #16805c;
  --warn: #9a6a00;
  --bad: #b42318;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}
button, input, select, textarea { font: inherit; }
.app { min-height: 100vh; display: grid; grid-template-rows: auto auto 1fr; }
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; background: #102a43; color: #fff; border-bottom: 1px solid #0b1f33;
}
h1 { font-size: 18px; margin: 0; font-weight: 700; }
.sub { color: #bcccdc; font-size: 13px; }
.toolbar {
  display: grid; grid-template-columns: minmax(240px, 1.3fr) repeat(3, minmax(150px, .45fr)) repeat(4, max-content);
  gap: 10px; padding: 12px 18px; background: #edf2f7; border-bottom: 1px solid var(--line); align-items: center;
}
.toolbar input, .toolbar select {
  height: 38px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; background: #fff;
}
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px;
  padding: 12px 18px; background: #fff; border-bottom: 1px solid var(--line);
}
.stat { border: 1px solid var(--line); border-radius: 6px; padding: 10px; background: #fbfcfd; }
.stat b { display: block; font-size: 20px; }
.stat span { color: var(--muted); font-size: 12px; }
.stat button { margin-top: 6px; height: 28px; padding: 0 8px; }
.stat .row { display: flex; gap: 6px; flex-wrap: wrap; }
.liveDot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); margin-right: 6px; }
.liveMeta { color: var(--muted); font-size: 12px; margin-left: 10px; }
.main { display: grid; grid-template-columns: minmax(520px, 1.35fr) minmax(390px, .9fr); min-height: 0; }
.tableWrap { overflow: auto; border-right: 1px solid var(--line); background: #fff; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td { border-bottom: 1px solid var(--line); padding: 9px 10px; text-align: left; vertical-align: top; }
th { position: sticky; top: 0; background: #f8fafc; z-index: 2; color: #334e68; font-size: 12px; }
td { font-size: 13px; }
tr { cursor: pointer; }
tr:hover, tr.active { background: #eef8f8; }
.colCheck { width: 42px; }
.colId { width: 86px; }
.colStatus { width: 112px; }
.colDate { width: 150px; }
.preview { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); background: #fff; }
.selectedCount { justify-content: center; height: 30px; min-width: 86px; }
.approved { color: var(--ok); border-color: #aad9c7; background: #eefaf5; }
.needs_review { color: var(--warn); border-color: #f5d37b; background: #fff8e5; }
.rejected { color: var(--bad); border-color: #f3b3aa; background: #fff0ee; }
.detail { min-width: 0; overflow: auto; padding: 16px; background: var(--panel); }
.detail h2 { margin: 0 0 4px; font-size: 18px; }
.meta { color: var(--muted); font-size: 13px; line-height: 1.5; margin-bottom: 12px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }
.box { border: 1px solid var(--line); border-radius: 6px; padding: 9px; background: #fbfcfd; }
.box label { display: block; color: var(--muted); font-size: 11px; text-transform: uppercase; margin-bottom: 3px; }
textarea { width: 100%; min-height: 245px; resize: vertical; border: 1px solid var(--line); border-radius: 6px; padding: 10px; line-height: 1.45; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
button { border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); height: 36px; padding: 0 12px; cursor: pointer; white-space: nowrap; }
button:hover { border-color: var(--accent); color: var(--accent); }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.danger { background: var(--accent-2); color: #fff; border-color: var(--accent-2); }
button:disabled { opacity: .45; cursor: not-allowed; }
.sendPanel { margin-top: 14px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: #f8fafc; }
.sendPanel input { height: 36px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; width: 130px; }
pre { white-space: pre-wrap; background: #0b1f33; color: #d9eafd; border-radius: 6px; padding: 12px; max-height: 260px; overflow: auto; }
@media (max-width: 980px) {
  .toolbar, .stats, .main { grid-template-columns: 1fr; }
  .tableWrap { border-right: 0; max-height: 55vh; }
}
</style>
</head>
<body>
<div class="app">
  <header>
    <div>
      <h1>ForgeGrowth DM Review</h1>
      <div class="sub"><span class="liveDot"></span>Live dashboard <span class="liveMeta" id="liveMeta">loading...</span></div>
    </div>
    <button onclick="loadCampaign()">Refresh</button>
  </header>

  <section class="stats" id="stats"></section>

  <section class="toolbar">
    <input id="q" placeholder="Search contact, DM, business..." oninput="renderTable()">
    <select id="reviewFilter" onchange="renderTable()">
      <option value="">All review states</option>
      <option value="needs_review">Needs review</option>
      <option value="approved">Approved</option>
      <option value="rejected">Rejected</option>
    </select>
    <select id="statusFilter" onchange="renderTable()">
      <option value="">All send states</option>
      <option value="pending">Pending</option>
      <option value="sent">Sent</option>
      <option value="failed">Failed</option>
    </select>
    <select id="businessFilter" onchange="renderTable()"></select>
    <button onclick="selectVisible()">Select Visible</button>
    <button onclick="clearSelection()">Clear</button>
    <button onclick="bulkReview('approved')">Approve Selected</button>
    <button onclick="bulkReview('rejected')">Reject Selected</button>
    <span class="pill selectedCount" id="selectedCount">0 selected</span>
  </section>

  <div id="waPanel" style="display:none;padding:12px 18px;background:#fff;border-bottom:1px solid var(--line)">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <b>WhatsApp Connection</b>
      <span id="waPanelStatus" class="pill" style="background:#f1f5f9;color:var(--muted)">Unknown</span>
      <span id="waPanelUser" style="color:var(--muted);font-size:13px"></span>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap">
      <button class="primary" id="waPairBtn" onclick="waInitQr()">Init / Show QR</button>
      <button class="danger" id="waDisconnectBtn" onclick="waDisconnect()" style="display:none">Disconnect</button>
      <button id="waResetBtn" onclick="waResetSession()">Reset Session</button>
    </div>
    <div id="waPairCode" style="margin-top:10px;display:none">
      <div style="background:#fff8e5;border:1px solid #f5d37b;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px">On your phone, go to WhatsApp > <b>Linked Devices</b> > <b>Link a Device</b>, then scan this QR.</div>
        <img id="waQrImage" alt="WhatsApp QR code" style="width:280px;max-width:100%;background:#fff;border:2px dashed var(--accent);border-radius:8px;padding:8px;display:none">
        <div id="waPairCodeDisplay" style="font-size:14px;font-weight:700;font-family:monospace;color:var(--text);padding:14px 20px;background:#fff;border:2px dashed var(--accent);border-radius:8px;display:none"></div>
        <div id="waPairError" style="color:var(--bad);font-size:13px;margin-top:8px"></div>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">QR refreshes automatically if WhatsApp sends a new one.</div>
        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed #f5d37b">
          <div style="font-size:12px;color:var(--muted);margin-bottom:8px"><b>OR</b> — use pairing code instead (more reliable)</div>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
            <input id="waPhoneInput" placeholder="2349010926847" style="width:200px;height:36px;border:1px solid var(--line);border-radius:6px;padding:0 10px;font-size:14px;text-align:center">
            <button onclick="waPairWithCode()">Pair with Code</button>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:6px">Enter your WhatsApp number with country code (no + or spaces)</div>
        </div>
      </div>
    </div>
    <div id="waConnecting" style="margin-top:10px;display:none;padding:12px;background:#f1f5f9;border-radius:6px;text-align:center;color:var(--muted)">Connecting to WhatsApp Web... wait for QR or connected status.</div>
    <pre id="waOutput" style="margin-top:10px;max-height:100px;display:none"></pre>
  </div>

  <main class="main">
    <div class="tableWrap">
      <table>
        <thead>
          <tr>
            <th class="colCheck"></th>
            <th class="colId">ID</th>
            <th>Contact / Preview</th>
            <th class="colStatus">Review</th>
            <th class="colDate">Schedule</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>

    <aside class="detail" id="detail">
      <h2>Select a DM</h2>
      <p class="meta">Pick a row to inspect analysis and edit the message before approval.</p>
    </aside>
  </main>
</div>

<script>
let state = { schedule: [], summary: null, automation: null, selected: new Set(), activeId: null };

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {}));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadCampaign() {
  if (document.activeElement && document.activeElement.id === 'dmText') return;
  try {
    const data = await api('/api/campaign');
    state.schedule = data.schedule || [];
    state.summary = data.summary || null;
    state.automation = data.automation || null;
  } catch (e) {
    state.schedule = [];
    state.summary = null;
    state.automation = null;
  }
  state.lastLoadedAt = new Date();
  buildBusinessFilter();
  renderStats();
  renderTable();
  if (state.activeId) showDetail(state.activeId);
  updateLiveMeta();
}

async function refreshCampaignLive() {
  if (document.hidden) return;
  if (document.activeElement && document.activeElement.id === 'dmText') {
    updateLiveMeta('paused while editing');
    return;
  }
  try {
    const data = await api('/api/campaign');
    state.schedule = data.schedule || [];
    state.summary = data.summary || null;
    state.automation = data.automation || null;
  } catch (e) {
    state.schedule = [];
    state.summary = null;
    state.automation = null;
  }
  state.lastLoadedAt = new Date();
  buildBusinessFilter();
  renderStats();
  renderTable();
  if (state.activeId) showDetail(state.activeId);
  updateLiveMeta();
}

function updateLiveMeta(extra) {
  const el = document.getElementById('liveMeta');
  if (!el) return;
  const stamp = state.lastLoadedAt ? state.lastLoadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'never';
  el.textContent = extra || ('updated ' + stamp);
}

function buildBusinessFilter() {
  const el = document.getElementById('businessFilter');
  const current = el.value;
  const types = [...new Set(state.schedule.map(x => x.analysis?.businessType || 'business'))].sort();
  el.innerHTML = '<option value="">All business types</option>' + types.map(t => '<option value="'+escapeHtml(t)+'">'+escapeHtml(t)+'</option>').join('');
  el.value = types.includes(current) ? current : '';
}

function renderStats() {
  const s = state.summary || {};
  const stats = [
    ['Total', s.total || 0],
    ['Pending', s.counts?.pending || 0],
    ['Sent', s.counts?.sent || 0],
    ['Failed', s.counts?.failed || 0],
    ['Approved', s.review?.approved || 0],
    ['Needs Review', s.review?.needs_review || 0],
    ['Rejected', s.review?.rejected || 0]
  ];
  document.getElementById('stats').innerHTML = stats.map(([label, value]) => '<div class="stat"><b>'+value+'</b><span>'+label+'</span></div>').join('')
    + '<div class="stat"><b id="automationStatus">'+escapeHtml(state.automation?.status || 'stopped')+'</b><span>Automation</span><div class="row"><button onclick="startAutomation()">Start</button><button onclick="stopAutomation()">Stop</button></div></div>'
    + '<div class="stat"><b id="waStatus">Unknown</b><span>WhatsApp</span><div class="row"><button onclick="toggleWaPanel()">Manage</button><button onclick="checkWa()">Check</button></div></div>'
    + '<div class="stat"><b id="overdueCount">'+countOverdue()+'</b><span>Overdue pending</span><br><button onclick="rescheduleOverdue()">Reschedule</button></div>';
}

function countOverdue() {
  const now = Date.now();
  return state.schedule.filter(item => item.status === 'pending' && new Date(item.nextAttemptAt || item.sendAt).getTime() < now).length;
}

function filtered() {
  const q = document.getElementById('q').value.toLowerCase().trim();
  const review = document.getElementById('reviewFilter').value;
  const status = document.getElementById('statusFilter').value;
  const business = document.getElementById('businessFilter').value;
  return state.schedule.filter(item => {
    const hay = [item.id, item.contact?.name, item.contact?.phone, item.analysis?.businessType, item.analysis?.strategy, item.dm].join(' ').toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (review && item.reviewStatus !== review) return false;
    if (status && item.status !== status) return false;
    if (business && item.analysis?.businessType !== business) return false;
    return true;
  });
}

function renderTable() {
  const items = filtered();
  const rows = items.map(item => {
    const checked = state.selected.has(item.id) ? 'checked' : '';
    const active = state.activeId === item.id ? 'active' : '';
    return '<tr class="'+active+'" onclick="showDetail(\\''+item.id+'\\')">'
      + '<td class="colCheck"><input type="checkbox" '+checked+' onclick="toggleSelected(event, \\''+item.id+'\\')"></td>'
      + '<td class="colId"><b>'+escapeHtml(item.id)+'</b><br><span class="meta">'+escapeHtml(item.status)+'</span></td>'
      + '<td><b>'+escapeHtml(item.contact?.name || item.contact?.phone || '')+'</b><div class="preview">'+escapeHtml(item.dm || '')+'</div><div class="meta">'+escapeHtml(item.analysis?.businessType || '')+' · '+escapeHtml(item.analysis?.strategy || '')+'</div></td>'
      + '<td class="colStatus"><span class="pill '+escapeHtml(item.reviewStatus)+'">'+escapeHtml(item.reviewStatus)+'</span></td>'
      + '<td class="colDate">'+formatDate(item.sendAt)+'</td>'
      + '</tr>';
  }).join('');
  document.getElementById('rows').innerHTML = rows || '<tr><td colspan="5">No DMs match this filter.</td></tr>';
  updateSelectedCount();
}

function toggleSelected(event, id) {
  event.stopPropagation();
  if (event.target.checked) state.selected.add(id);
  else state.selected.delete(id);
  renderDetailActions();
}

function selectVisible() {
  for (const item of filtered()) state.selected.add(item.id);
  renderTable();
  renderDetailActions();
}

function clearSelection() {
  state.selected.clear();
  renderTable();
  renderDetailActions();
}

async function bulkReview(reviewStatus) {
  const ids = [...state.selected];
  if (!ids.length) return;
  await api('/api/messages/bulk-review', { method: 'POST', body: JSON.stringify({ ids, reviewStatus }) });
  await loadCampaign();
}

async function showDetail(id) {
  state.activeId = id;
  document.getElementById('detail').innerHTML = '<h2>Loading...</h2>';
  renderTable();
  try {
    const item = await api('/api/message/' + encodeURIComponent(id));
    document.getElementById('detail').innerHTML = detailHtml(item);
  } catch (e) {
    const item = state.schedule.find(x => x.id === id);
    if (item) document.getElementById('detail').innerHTML = detailHtml(item);
    else document.getElementById('detail').innerHTML = '<h2>Error loading message</h2><p class="meta">' + e.message + '</p>';
  }
}

function detailHtml(item) {
  return '<h2>'+escapeHtml(item.contact?.name || item.id)+'</h2>'
    + '<div class="meta">'+escapeHtml(item.id)+' · '+escapeHtml(item.contact?.jid || '')+'</div>'
    + '<div class="grid">'
    + box('Business', item.analysis?.businessType)
    + box('Strategy', item.analysis?.strategy)
    + box('Tone', item.analysis?.tone)
    + box('Relationship', item.analysis?.relationship)
    + box('Scheduled', formatDate(item.sendAt))
    + box('Review', item.reviewStatus)
    + '</div>'
    + '<div class="box"><label>Last Conversation Summary</label>'+escapeHtml(item.analysis?.lastConversationSummary || '')+'</div>'
    + '<h3>DM</h3>'
    + '<textarea id="dmText">'+escapeHtml(item.dm || '')+'</textarea>'
    + '<div class="actions" id="detailActions">'
    + '<button class="primary" onclick="saveDm(\\''+item.id+'\\')">Save DM</button>'
    + '<button onclick="setReview(\\''+item.id+'\\', \\'approved\\')">Approve</button>'
    + '<button onclick="setReview(\\''+item.id+'\\', \\'needs_review\\')">Needs Review</button>'
    + '<button onclick="setReview(\\''+item.id+'\\', \\'rejected\\')">Reject</button>'
    + '</div>'
    + '<div class="sendPanel">'
    + '<b>Two-message test</b><p class="meta">Select exactly 2 approved DMs. Dry-run first. Real send requires typing SEND 2.</p>'
    + '<div class="actions"><button onclick="dryRunSelected()">Dry Run Selected</button><input id="confirmSend" placeholder="SEND 2"><button class="danger" onclick="realSendSelected()">Real Send 2</button></div>'
    + '<pre id="sendOutput">No send action yet.</pre>'
    + '</div>';
}

function box(label, value) {
  return '<div class="box"><label>'+escapeHtml(label)+'</label>'+escapeHtml(value || '')+'</div>';
}

function renderDetailActions() {
  const output = document.getElementById('sendOutput');
  if (output) output.textContent = 'Selected: ' + [...state.selected].join(', ');
  updateSelectedCount();
}

function updateSelectedCount() {
  const el = document.getElementById('selectedCount');
  if (el) el.textContent = state.selected.size + ' selected';
}

async function saveDm(id) {
  const dm = document.getElementById('dmText').value;
  await api('/api/messages/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ dm }) });
  await loadCampaign();
  if (state.activeId) showDetail(state.activeId);
}

async function setReview(id, reviewStatus) {
  await api('/api/messages/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ reviewStatus }) });
  await loadCampaign();
  if (state.activeId) showDetail(state.activeId);
}

async function dryRunSelected() {
  const ids = [...state.selected];
  const out = document.getElementById('sendOutput');
  out.textContent = 'Running dry-run...';
  try {
    const result = await api('/api/send/dry-run', { method: 'POST', body: JSON.stringify({ ids }) });
    out.textContent = result.output || JSON.stringify(result, null, 2);
  } catch (e) {
    out.textContent = e.message;
  }
}

async function realSendSelected() {
  const ids = [...state.selected];
  const confirm = document.getElementById('confirmSend').value;
  const out = document.getElementById('sendOutput');
  out.textContent = 'Running real-send command...';
  try {
    const result = await api('/api/send/real', { method: 'POST', body: JSON.stringify({ ids, confirm }) });
    out.textContent = result.output || JSON.stringify(result, null, 2);
    await loadCampaign();
  } catch (e) {
    out.textContent = e.message;
  }
}

async function checkWa() {
  const el = document.getElementById('waStatus');
  el.textContent = 'Checking...';
  try {
    const status = await api('/api/wa/status');
    el.textContent = status.connected ? 'Connected' : 'Not connected';
    el.title = status.error || ('Checked at ' + status.checkedAt);
  } catch (e) {
    el.textContent = 'Error';
    el.title = e.message;
  }
}

async function checkWaLive() {
  if (document.hidden) return;
  const el = document.getElementById('waStatus');
  if (!el || el.textContent === 'Checking...') return;
  try {
    const status = await api('/api/wa/status');
    el.textContent = status.connected ? 'Connected' : 'Not connected';
    el.title = status.error || '';
    updateWaPanel(status);
  } catch (e) {
    el.textContent = 'Error';
    el.title = e.message;
  }
}

function toggleWaPanel() {
  const panel = document.getElementById('waPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') checkWa();
}

function updateWaPanel(status) {
  const el = document.getElementById('waPanelStatus');
  const user = document.getElementById('waPanelUser');
  const pairBtn = document.getElementById('waPairBtn');
  const discBtn = document.getElementById('waDisconnectBtn');
  const pairDiv = document.getElementById('waPairCode');
  const connecting = document.getElementById('waConnecting');
  if (!el) return;
  connecting.style.display = 'none';
  if (status.connected) {
    el.textContent = '✅ Connected';
    el.style.background = '#eefaf5'; el.style.color = 'var(--ok)';
    user.textContent = status.user || 'WhatsApp ready';
    pairBtn.textContent = 'Recheck / New QR';
    pairBtn.className = '';
    discBtn.style.display = '';
    if (pairDiv) pairDiv.style.display = 'none';
  } else if (status.pairingCode) {
    el.textContent = '🔑 Pairing Code Ready';
    el.style.background = '#eefaf5'; el.style.color = '#0f8b8d';
    user.textContent = 'Enter this code in WhatsApp > Linked Devices > Link a Device';
    pairBtn.textContent = 'Refresh QR';
    discBtn.style.display = '';
    pairDiv.style.display = 'block';
    const img = document.getElementById('waQrImage');
    const code = document.getElementById('waPairCodeDisplay');
    img.style.display = 'none';
    code.style.display = 'inline-block';
    code.textContent = status.pairingCode;
    document.getElementById('waPairError').textContent = '';
  } else if (status.qrDataUrl || status.qr) {
    el.textContent = 'QR Ready';
    el.style.background = '#fff8e5'; el.style.color = 'var(--warn)';
    user.textContent = 'Scan with WhatsApp Linked Devices';
    pairBtn.textContent = 'Refresh QR';
    discBtn.style.display = '';
    pairDiv.style.display = 'block';
    const img = document.getElementById('waQrImage');
    const code = document.getElementById('waPairCodeDisplay');
    if (status.qrDataUrl) {
      img.src = status.qrDataUrl;
      img.style.display = 'inline-block';
      code.style.display = 'none';
    } else {
      img.style.display = 'none';
      code.style.display = 'inline-block';
      code.textContent = status.qr || '';
    }
    document.getElementById('waPairError').textContent = '';
  } else if (status.error) {
    el.textContent = '❌ Error';
    el.style.background = '#fff0ee'; el.style.color = 'var(--bad)';
    user.textContent = status.error;
    pairBtn.textContent = 'Init / Show QR';
    pairBtn.className = 'primary';
    discBtn.style.display = 'none';
    if (pairDiv) pairDiv.style.display = 'none';
  } else {
    el.textContent = '○ Not connected';
    el.style.background = '#f1f5f9'; el.style.color = 'var(--muted)';
    user.textContent = '';
    pairBtn.textContent = status.status === 'initializing' ? 'Initializing...' : 'Init / Show QR';
    pairBtn.className = 'primary';
    discBtn.style.display = 'none';
    if (pairDiv) pairDiv.style.display = 'none';
  }
}

async function waPairWithCode() {
  const phone = document.getElementById('waPhoneInput').value.trim();
  if (!phone) { alert('Enter your WhatsApp phone number (country code + number, no + or spaces)'); return; }
  const out = document.getElementById('waOutput');
  const connecting = document.getElementById('waConnecting');
  const pairDiv = document.getElementById('waPairCode');
  out.style.display = 'none';
  connecting.style.display = 'block';
  document.getElementById('waPanelStatus').textContent = 'Requesting pairing code...';
  try {
    const result = await api('/api/wa/pair', { method: 'POST', body: JSON.stringify({ phone }) });
    connecting.style.display = 'none';
    updateWaPanel(result);
    if (result.pairingCode) {
      document.getElementById('waPairCodeDisplay').textContent = result.pairingCode;
      document.getElementById('waPairCodeDisplay').style.display = 'inline-block';
      document.getElementById('waQrImage').style.display = 'none';
      document.getElementById('waPairError').textContent = '';
      pairDiv.style.display = 'block';
      out.style.display = 'none';
    } else if (result.error) {
      out.style.display = 'block';
      out.textContent = 'Error: ' + result.error;
    } else {
      out.style.display = 'block';
      out.textContent = 'No pairing code received. Try QR instead.';
    }
  } catch (e) {
    connecting.style.display = 'none';
    out.style.display = 'block';
    out.textContent = 'Error: ' + e.message;
  }
}

async function waInitQr() {
  const out = document.getElementById('waOutput');
  const connecting = document.getElementById('waConnecting');
  const pairDiv = document.getElementById('waPairCode');
  pairDiv.style.display = 'none';
  out.style.display = 'none';

  connecting.style.display = 'block';
  document.getElementById('waPanelStatus').textContent = 'Connecting...';
  document.getElementById('waPanelUser').textContent = '';
  try {
    const result = await api('/api/wa/pair', { method: 'POST', body: JSON.stringify({}) });
    connecting.style.display = 'none';
    updateWaPanel(result);
    if (result.qrDataUrl || result.connected || result.pairingCode) {
      out.style.display = 'none';
    } else if (result.error) {
      out.style.display = 'block';
      out.textContent = 'Error: ' + result.error;
    }
  } catch (e) {
    connecting.style.display = 'none';
    out.style.display = 'block';
    out.textContent = 'Error: ' + e.message;
    updateWaPanel({ connected: false, pairingCode: null, error: e.message });
  }
}

async function waResetSession() {
  if (!confirm('Reset the saved WhatsApp Web session on this server? You will need to scan a fresh QR.')) return;
  const out = document.getElementById('waOutput');
  out.style.display = 'block';
  out.textContent = 'Resetting session...';
  try {
    const result = await api('/api/wa/reset', { method: 'POST' });
    out.textContent = 'Session reset. Click Init / Show QR.';
    document.getElementById('waPairCode').style.display = 'none';
    updateWaPanel(result);
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
}

async function waDisconnect() {
  const out = document.getElementById('waOutput');
  const connecting = document.getElementById('waConnecting');
  connecting.style.display = 'none';
  out.style.display = 'block';
  out.textContent = 'Disconnecting...';
  try {
    const result = await api('/api/wa/disconnect', { method: 'POST' });
    out.textContent = 'Disconnected';
    document.getElementById('waPairCode').style.display = 'none';
    updateWaPanel(result);
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
}

async function rescheduleOverdue() {
  const el = document.getElementById('overdueCount');
  el.textContent = '...';
  try {
    const result = await api('/api/reschedule-overdue', { method: 'POST', body: JSON.stringify({}) });
    console.log(result.output);
    await loadCampaign();
  } catch (e) {
    el.textContent = 'Error';
    el.title = e.message;
  }
}

async function startAutomation() {
  const el = document.getElementById('automationStatus');
  el.textContent = 'starting';
  try {
    const status = await api('/api/automation/start', { method: 'POST', body: JSON.stringify({}) });
    state.automation = status;
    renderStats();
  } catch (e) {
    el.textContent = 'error';
    el.title = e.message;
  }
}

async function stopAutomation() {
  const el = document.getElementById('automationStatus');
  el.textContent = 'stopping';
  try {
    const status = await api('/api/automation/stop', { method: 'POST', body: JSON.stringify({}) });
    state.automation = status;
    renderStats();
  } catch (e) {
    el.textContent = 'error';
    el.title = e.message;
  }
}

setInterval(async () => {
  try {
    const status = await api('/api/automation/status');
    state.automation = status;
    const el = document.getElementById('automationStatus');
    if (el) {
      el.textContent = status.status || 'stopped';
      el.title = [
        status.pid ? 'PID ' + status.pid : '',
        status.heartbeatAt ? 'Heartbeat ' + status.heartbeatAt : '',
        status.lastRunAt ? 'Last run ' + status.lastRunAt : '',
        status.lastError ? 'Error ' + status.lastError : ''
      ].filter(Boolean).join('\\n');
    }
  } catch (_) {}
}, 5000);

setInterval(refreshCampaignLive, 3000);
setInterval(checkWaLive, 5000);

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
}

loadCampaign();
setTimeout(checkWaLive, 500);
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, page());
    sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
    console.log(`ForgeGrowth DM dashboard running at http://localhost:${PORT}`);
});
