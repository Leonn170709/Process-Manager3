'use strict';
// node test/discord-panel.js  — asserts the Discord panel's pure formatting and the
// secret-masking round-trip. No network, no bot token needed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point PM3_HOME at a throwaway dir before anything reads constants.js.
process.env.PM3_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pm3-dtest-'));

const { fmtUptime, fmtBytes, procLine, tailLogs, buildPanel, procPanel } = require('../discord')._internal;
const userConfig = require('../config/userConfig');
const storage = require('../storage');

// ── formatting ────────────────────────────────────────────────
assert.strictEqual(fmtUptime(0), '0s');
assert.strictEqual(fmtUptime(42), '42s');
assert.strictEqual(fmtUptime(3600), '1h 0m');
assert.strictEqual(fmtUptime(90061), '1d 1h');
assert.strictEqual(fmtBytes(500 * 1024 ** 2), '500MB');
assert.strictEqual(fmtBytes(2.5 * 1024 ** 3), '2.5GB');

const line = procLine({ name: 'api', status: 'running', cpu: 3.14159, memory: 88, uptime: 120, restartCount: 2 });
assert.ok(line.includes('`api`') && line.includes('3.1%') && line.includes('88MB') && line.includes('↻2'), line);
// A never-restarted process must not carry a restart marker.
assert.ok(!procLine({ name: 'x', status: 'stopped', restartCount: 0 }).includes('↻'));

// ── log tail fits Discord's 2000-char message cap ─────────────
storage.ensureHome();
assert.strictEqual(tailLogs('nosuchproc'), '_No log output._');
for (let i = 0; i < 500; i++) storage.appendLog('big', 'out', 'x'.repeat(120));
const tail = tailLogs('big');
assert.ok(tail.length < 2000, `log tail is ${tail.length} chars, Discord caps at 2000`);
assert.ok(tail.startsWith('```') && tail.endsWith('```'));

// ── secrets never leave the daemon ────────────────────────────
userConfig.set('discordToken', 'super.secret.token');
assert.strictEqual(userConfig.get('discordToken'), 'super.secret.token');
assert.strictEqual(userConfig.getAllMasked().discordToken, userConfig.MASK);
// Submitting the mask back is "unchanged", not "set my token to bullets".
userConfig.set('discordToken', userConfig.MASK);
assert.strictEqual(userConfig.get('discordToken'), 'super.secret.token');
// A non-secret string key is untouched by masking.
userConfig.set('discordChannel', '123456789012345678');
assert.strictEqual(userConfig.getAllMasked().discordChannel, '123456789012345678');
// Clearing it really clears it.
userConfig.set('discordToken', '');
assert.strictEqual(userConfig.getAllMasked().discordToken, '');

// ── the builders produce payloads Discord will accept ─────────
// 40 processes exercises the 25-option select cap; the long name exercises the
// 100-char label/value cap. Both throw at build time if violated.
const procs = {};
for (let i = 0; i < 40; i++) {
  procs[`proc-${i}`] = {
    name: i === 0 ? 'n'.repeat(150) : `proc-${i}`,
    status: ['running', 'stopped', 'crashed', 'starting', 'restarting'][i % 5],
    id: i,
    cpu: i, memory: i * 10, uptime: i * 60, restartCount: i, pid: 1000 + i,
    maxRestarts: -1, memoryLimit: null, exitCode: i % 5 === 2 ? 1 : null,
    script: '/srv/' + 's'.repeat(400) + '.js',
  };
}
storage.saveProcesses(procs);

const d = require('discord.js');
const panel = buildPanel(d);
const json = panel.embeds[0].toJSON();
assert.ok(json.description.length <= 4096, `embed description is ${json.description.length}, cap is 4096`);
assert.strictEqual(panel.components[0].toJSON().components[0].options.length, 25);
assert.ok(panel.components[0].toJSON().components[0].options.every(o => o.value.length <= 100 && o.label.length <= 100));
// Buttons row is always present, even with no processes.
storage.saveProcesses({});
assert.strictEqual(buildPanel(d).components.length, 1);

procPanel(d, procs['proc-0']).embeds[0].toJSON();   // long script must not blow the field cap

fs.rmSync(process.env.PM3_HOME, { recursive: true, force: true });
console.log('discord-panel: all checks passed');
