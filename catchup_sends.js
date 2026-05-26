/**
 * Deprecated safety shim.
 *
 * The previous version of this file sent every missed campaign message before
 * "now", which is not safe for the current permission-based workflow.
 *
 * Use dm_sender.js instead. It defaults to dry-run and requires explicit caps.
 */

console.log('catchup_sends.js is disabled for safety.');
console.log('Use: node dm_sender.js --list');
console.log('For a capped real run: node dm_sender.js --send --real-send-approved --max 2 --ids fgd-0001,fgd-0002 --ignore-time');
process.exit(0);
