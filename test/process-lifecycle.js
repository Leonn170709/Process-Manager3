// node test/process-lifecycle.js — lifecycle edge cases in core/processManager, no daemon needed:
// duplicate starts, double restarts, renaming a running process, signal deaths, restart limits.
const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm3-life-'));
process.env.PM3_HOME = dir;
const pm = require('../core/processManager');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const script = (file, body) => { const p = path.join(dir, file); fs.writeFileSync(p, body); return p; };
const idle = script('idle.js', 'setInterval(() => {}, 1000);');
const dies = script('dies.js', 'process.exit(3);');
const children = file => { try { return execSync(`pgrep -f ${file}`, { encoding: 'utf8' }).trim().split('\n').length; } catch { return 0; } };

(async () => {
  // A second start under a running name is refused instead of orphaning the first child
  pm.startProcess({ script: idle, name: 'a' });
  await sleep(300);
  assert.ok(pm.startProcess({ script: idle, name: 'a' }).error, 'duplicate start must be refused');
  assert.strictEqual(children(idle), 1);

  // Two restarts in quick succession leave exactly one child
  const pid0 = pm.getProcessInfo('a').pid;
  pm.restartProcess('a');
  pm.restartProcess('a');
  await sleep(1500);
  const pid1 = pm.getProcessInfo('a').pid;
  assert.ok(pid1 && pid1 !== pid0 && !alive(pid0), 'old child replaced');
  assert.strictEqual(children(idle), 1, 'double restart must not leave a second child');

  // Renaming a running process carries its exit handling over, and SIGKILL (the OOM killer's
  // signal) is a crash that gets restarted, not a stop
  pm.updateProcess('a', { name: 'b' });
  process.kill(pm.getProcessInfo('b').pid, 'SIGKILL');
  await sleep(1700);
  const b = pm.getProcessInfo('b');
  assert.strictEqual(b.status, 'running', 'renamed process restarted after SIGKILL');
  assert.strictEqual(b.restartCount, 2, 'one manual restart above + one after the SIGKILL');
  assert.ok(fs.existsSync(path.join(dir, 'logs')), 'logs dir exists');

  // maxRestarts 0 means never restart
  pm.startProcess({ script: dies, name: 'c', maxRestarts: 0 });
  await sleep(1500);
  const c = pm.getProcessInfo('c');
  assert.strictEqual(c.maxRestarts, 0, '0 must not become the default');
  assert.strictEqual(c.status, 'crashed');
  assert.strictEqual(c.restartCount, 0);

  // A crash loop gives up after maxRestarts in a row and says it crashed
  pm.startProcess({ script: dies, name: 'd', maxRestarts: 2 });
  await sleep(5000);
  const d = pm.getProcessInfo('d');
  assert.strictEqual(d.restartCount, 2);
  assert.strictEqual(d.status, 'crashed');

  await pm.stopAll(2000);
  assert.strictEqual(children(idle), 0, 'stopAll leaves nothing behind');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('process-lifecycle: all checks passed');
  process.exit(0);
})().catch(err => {
  console.error(err);
  pm.stopAll(1000).finally(() => process.exit(1));
});
