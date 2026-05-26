const wa = require('./wa_client.js');

async function main() {
    const startedAt = Date.now();
    let connected = false;
    let error = null;

    try {
        connected = await wa.init();
    } catch (e) {
        error = e.message;
    } finally {
        try {
            await wa.shutdown();
        } catch (_) {}
    }

    console.log(JSON.stringify({
        connected,
        status: connected ? 'connected' : 'not_connected',
        checkedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error
    }));
}

main().catch(async (error) => {
    try {
        await wa.shutdown();
    } catch (_) {}
    console.log(JSON.stringify({
        connected: false,
        status: 'error',
        checkedAt: new Date().toISOString(),
        error: error.message
    }));
    process.exit(1);
});
