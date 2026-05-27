const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'automation_state.json');
const LOG_FILE = path.join(ROOT, 'automation_runner.log');
const INTERVAL_MS = Number(process.env.RUNNER_INTERVAL_MS || 300_000);

let stopping = false;

function readJson(filePath, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
}

function appendLog(line) {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
}

function statePatch(patch) {
    const current = readJson(STATE_FILE, {});
    const next = {
        ...current,
        ...patch,
        pid: process.pid,
        updatedAt: new Date().toISOString()
    };
    writeJsonAtomic(STATE_FILE, next);
    return next;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function runSenderOnce() {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [
            'dm_sender.js',
            '--send',
            '--real-send-approved',
            '--max',
            '5'
        ], {
            cwd: ROOT,
            env: process.env
        });

        let output = '';
        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { output += chunk.toString(); });
        child.on('close', code => resolve({ code, output }));
    });
}

async function loop() {
    appendLog(`runner started pid=${process.pid}`);
    statePatch({
        status: 'running',
        startedAt: new Date().toISOString(),
        stopRequested: false,
        lastError: null
    });

    while (!stopping) {
        const state = readJson(STATE_FILE, {});
        if (state.stopRequested) break;

        statePatch({ status: 'running', heartbeatAt: new Date().toISOString() });

        try {
            appendLog('sender cycle starting');
            const result = await runSenderOnce();
            appendLog(`sender cycle finished code=${result.code}`);
            statePatch({
                status: 'running',
                lastRunAt: new Date().toISOString(),
                lastExitCode: result.code,
                lastOutput: result.output.slice(-5000),
                lastError: result.code === 0 ? null : `dm_sender exited with ${result.code}`
            });
        } catch (error) {
            appendLog(`runner error: ${error.message}`);
            statePatch({
                status: 'running',
                lastRunAt: new Date().toISOString(),
                lastError: error.message
            });
        }

        const until = Date.now() + INTERVAL_MS;
        while (!stopping && Date.now() < until) {
            const latest = readJson(STATE_FILE, {});
            if (latest.stopRequested) {
                stopping = true;
                break;
            }
            statePatch({ heartbeatAt: new Date().toISOString() });
            await sleep(Math.min(5000, Math.max(0, until - Date.now())));
        }
    }

    statePatch({
        status: 'stopped',
        stoppedAt: new Date().toISOString(),
        stopRequested: false
    });
    appendLog(`runner stopped pid=${process.pid}`);
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

loop().catch(error => {
    appendLog(`fatal: ${error.message}`);
    statePatch({
        status: 'error',
        stoppedAt: new Date().toISOString(),
        lastError: error.message
    });
    process.exit(1);
});
