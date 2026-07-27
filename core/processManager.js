'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pidusage = require('pidusage');
const chokidar = require('chokidar');

const { STATUS, SEVERITY } = require('../config/constants');
const storage = require('../storage');
const issueTracker = require('../issues');
const memDetail = require('./memDetail');

// Absolute path to the agent entry point, handed to every child as PM3_AGENT.
// `npm i -g pm3` puts the CLI on PATH but does not make the package require-able - Node
// never searches the global node_modules root - so `require('pm3/agent')` fails and the
// app silently degrades to a no-op. An absolute path in the environment works for global
// installs, local installs and npm link alike, with no per-project setup.
const AGENT_PATH = require.resolve('../agent');

// Message discriminator shared with agent/pm3-agent.js.
const AGENT_KEY = '__pm3';

// In-memory process map: id -> { proc, config, stats, watcher }
const runtime = {};

// Previous /proc/<pid>/io snapshots for computing per-process network delta
const prevProcIO = {}; // { pid: { rchar, wchar, read_bytes, write_bytes, ts } }

// Event emitter for broadcasting to dashboard
let _emitter = null;
function setEmitter(emitter) { _emitter = emitter; }
function emit(event, data) { if (_emitter) _emitter.emit(event, data); }

// --- Helpers ---
function generateId() {
  const procs = storage.loadProcesses();
  const ids = Object.values(procs).map(p => p.id).filter(Number.isInteger);
  return ids.length ? Math.max(...ids) + 1 : 0;
}

const INTERPRETERS = {
  js:  () => ({ cmd: process.execPath, args: [] }),
  mjs: () => ({ cmd: process.execPath, args: [] }),
  cjs: () => ({ cmd: process.execPath, args: [] }),
  sh:  () => ({ cmd: 'bash',    args: [] }),
  py:  () => ({ cmd: 'python3', args: [] }),
  rb:  () => ({ cmd: 'ruby',    args: [] }),
  pl:  () => ({ cmd: 'perl',    args: [] }),
};

function resolveCwd(cwd, script) {
  if (cwd) return path.resolve(cwd);
  if (script && !script.startsWith('npm') && !script.startsWith('node')) {
    return path.dirname(path.resolve(script));
  }
  return process.cwd();
}

function parseCommand(script) {
  const parts = script.trim().split(/\s+/);
  if (parts.length > 1) return { cmd: parts[0], args: parts.slice(1) };
  // Use only the basename's extension so absolute paths without dots don't confuse the lookup
  const ext = path.extname(script).slice(1).toLowerCase();
  const interp = INTERPRETERS[ext];
  if (interp) {
    const { cmd, args } = interp();
    return { cmd, args: [...args, path.resolve(script)] };
  }
  // Treat as a direct executable (absolute path or command in PATH)
  return { cmd: parts[0], args: [] };
}

// Env overrides are validated, not merely coerced: spawn() throws on a name containing '='
// or a NUL byte, and it would throw at restart time - long after the bad record was saved and
// the dashboard said "Saved". Rejecting here keeps a process that starts today startable.
function _sanitizeEnv(raw) {
  if (raw == null) return { env: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'env must be an object' };
  const env = {};
  for (const [rawKey, rawVal] of Object.entries(raw)) {
    const key = String(rawKey);
    if (!key || /[=\0]/.test(key)) return { error: `Invalid environment variable name: "${key}"` };
    if (rawVal == null) continue;                      // an absent value means "not set"
    const val = String(rawVal);
    if (val.includes('\0')) return { error: `Value of ${key} contains a NUL byte` };
    env[key] = val;
  }
  return { env };
}

// --- Start process ---
function startProcess(config, savedConfig = {}) {
  const procs = storage.loadProcesses();

  // Build process record
  const id = config.id !== undefined ? config.id : generateId();
  const name = config.name || `pm3-${id}`;
  const { cmd, args } = parseCommand(config.script);
  const extraArgs = config.args || savedConfig.args || [];
  const cwd = resolveCwd(config.cwd || savedConfig.cwd, config.script);
  // Only the OVERRIDES are stored on the record; the daemon's own environment is merged in at
  // spawn time (see _spawnProcess) so a restart picks up the daemon's current env, and so
  // ~/.pm3/processes.json never grows a copy of every variable the daemon happened to have.
  const { env, error: envError } = _sanitizeEnv(config.env || savedConfig.env || {});
  if (envError) return { error: envError };
  const autorestart = config.autorestart !== undefined ? config.autorestart : true;
  const maxRestarts = config.maxRestarts || savedConfig.maxRestarts || 15;
  const memoryLimit = config.memoryLimit || savedConfig.memoryLimit || null;
  const watch = config.watch || savedConfig.watch || false;

  const procRecord = {
    id,
    name,
    script: config.script,
    cmd,
    args: [...args, ...extraArgs],
    cwd,
    env,
    autorestart,
    maxRestarts,
    memoryLimit,
    watch,
    status: STATUS.STARTING,
    pid: null,
    restartCount: savedConfig.restartCount || 0,
    startTime: new Date().toISOString(),
    exitCode: null,
    uptime: 0,
    cpu: 0,
    memory: 0,
  };

  procs[name] = procRecord;
  storage.saveProcesses(procs);

  _spawnProcess(procRecord);
  return procRecord;
}

function _spawnProcess(procRecord) {
  const { name, cmd, args, cwd, env } = procRecord;
  memDetail.forget(name);   // new pid ⇒ new inspector URL, and the agent must say hello again

  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      // The record holds overrides only, so the daemon's environment is merged in here - a
      // child spawned with just the overrides would run without PATH, HOME or TZ. Overrides
      // win over inherited values, which is the whole point of setting one.
      // PM3_AGENT is added at spawn time rather than stored on the record, so a machine's
      // install path never gets baked into ~/.pm3/processes.json. PM3_NAME rides along so
      // an app can name itself in its own logs; it is never how PM3 identifies the sender.
      env: { ...process.env, ...env, PM3_AGENT: AGENT_PATH, PM3_NAME: name },
      // Each child leads its own process group, so stopping it can signal the whole group
      // and take down whatever the script spawned in turn - `npm start`'s node, a shell
      // wrapper's worker. Without this only the direct child is signalled and the
      // grandchildren survive as orphans still holding the port.
      detached: true,
      // 4th fd = IPC channel for the opt-in memory agent. A child that never listens on
      // it is unaffected (verified: a plain script still exits immediately), and the
      // agent unrefs the channel so it cannot hold a child open either.
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
  } catch (err) {
    _handleCrash(procRecord, null, `Spawn failed: ${err.message}`, SEVERITY.CRITICAL);
    return;
  }

  // Update record with PID
  const procs = storage.loadProcesses();
  if (procs[name]) {
    procs[name].pid = child.pid;
    procs[name].status = STATUS.RUNNING;
    procs[name].startTime = new Date().toISOString();
    storage.saveProcesses(procs);
  }

  runtime[name] = { proc: child, config: procRecord, watcher: null };
  emit('process:update', getProcessInfo(name));

  // Handle spawn errors (e.g. command not found) - without this handler
  // Node.js throws an uncaught exception and crashes the daemon.
  child.on('error', err => {
    const procs2 = storage.loadProcesses();
    if (procs2[name]) {
      procs2[name].pid = null;
      procs2[name].status = STATUS.CRASHED;
      storage.saveProcesses(procs2);
      emit('process:update', procs2[name]);
    }
    if (runtime[name]) {
      if (runtime[name].watcher)  runtime[name].watcher.close();
      if (runtime[name].memCheck) clearInterval(runtime[name].memCheck);
      delete runtime[name];
    }
    _handleCrash(procRecord, null, `Spawn error: ${err.message}`, SEVERITY.CRITICAL);
  });

  // Log stdout - split chunks so every output line gets its own timestamp
  child.stdout.on('data', data => {
    const ts = new Date().toISOString();
    data.toString().trimEnd().split('\n').forEach(rawLine => {
      if (!rawLine) return;
      const line = `[${ts}] ${rawLine}`;
      storage.appendLog(name, 'out', line);
      emit('log', { name, line, type: 'out' });
    });
  });

  // Agent IPC (ignored by children that don't use it). Control requests are handled
  // here rather than in memDetail because this closure is the only place that knows
  // which child sent the message - that is what lets an app stop itself without
  // naming itself, and what stops it from claiming to be a process it is not.
  child.on('message', msg => {
    if (msg && typeof msg === 'object' && msg[AGENT_KEY] === 'control') {
      _handleControl(name, child, msg);
      return;
    }
    memDetail.onAgentMessage(name, msg);
  });

  // Log stderr
  child.stderr.on('data', data => {
    const ts = new Date().toISOString();
    const text = data.toString();
    // SIGUSR1 makes Node print its real inspector URL here - that is how the CDP
    // fallback learns the port belonging to this specific pid.
    memDetail.noteStderr(name, text);
    text.trimEnd().split('\n').forEach(rawLine => {
      if (!rawLine) return;
      // Node's own "Debugger listening/attached/ending" chatter is provoked by PM3's
      // memory probe, not written by the app - keep it out of the app's error log.
      if (memDetail.isInspectorNoise(rawLine)) return;
      const line = `[${ts}] [ERR] ${rawLine}`;
      storage.appendLog(name, 'err', line);
      emit('log', { name, line, type: 'err' });
    });
    // Detect error patterns
    if (text.includes('Error:') || text.includes('Exception') || text.includes('FATAL')) {
      _captureIssue(name, text, SEVERITY.ERROR);
    }
  });

  // Handle exit
  child.on('exit', (code, signal) => {
    // If a new child has been spawned under this name, ignore this exit event
    if (runtime[name] && runtime[name].proc !== child) {
      return;
    }

    const procs2 = storage.loadProcesses();
    if (!procs2[name]) return;

    procs2[name].pid = null;
    procs2[name].exitCode = code;
    procs2[name].cpu = 0;
    procs2[name].memory = 0;
    procs2[name].memDetail = null;
    procs2[name].connections = 0;
    procs2[name].netRx = 0;
    procs2[name].netTx = 0;

    const isCrash = code !== 0 && code !== null;
    const wasKilled = signal === 'SIGTERM' || signal === 'SIGKILL';

    if (wasKilled || procs2[name].status === STATUS.STOPPED) {
      procs2[name].status = STATUS.STOPPED;
      storage.saveProcesses(procs2);
      delete runtime[name];
      emit('process:update', procs2[name]);
      return;
    }

    if (isCrash) {
      procs2[name].status = STATUS.CRASHED;
      storage.saveProcesses(procs2);
      _handleCrash(procs2[name], code, `Process exited with code ${code}`, SEVERITY.ERROR);
    }

    const maxR = procs2[name].maxRestarts;
    const underLimit = maxR === -1          // -1 = unlimited
      ? true
      : procs2[name].restartCount < maxR;   // 0 = never, N = up to N times
    const shouldRestart = procs2[name].autorestart && underLimit && !wasKilled;

    if (shouldRestart) {
      procs2[name].status = STATUS.RESTARTING;
      procs2[name].restartCount++;
      storage.saveProcesses(procs2);
      emit('process:update', procs2[name]);
      setTimeout(() => {
        const latest = storage.loadProcesses();
        if (latest[name] && latest[name].status === STATUS.RESTARTING) {
          _spawnProcess(latest[name]);
        }
      }, 1000);
    } else {
      procs2[name].status = STATUS.STOPPED;
      storage.saveProcesses(procs2);
      delete runtime[name];
      emit('process:update', procs2[name]);
    }
  });

  // File watcher (if --watch)
  if (procRecord.watch) {
    const watcher = chokidar.watch(cwd, {
      ignored: /node_modules|\.git/,
      persistent: true,
      ignoreInitial: true,
    });
    watcher.on('change', () => {
      storage.appendLog(name, 'out', `[${new Date().toISOString()}] [PM3] File change detected, restarting...`);
      restartProcess(name);
    });
    runtime[name].watcher = watcher;
  }

  // Memory monitor (-1 and null both mean no limit)
  if (procRecord.memoryLimit && procRecord.memoryLimit > 0) {
    runtime[name].memCheck = setInterval(() => {
      if (!runtime[name] || !runtime[name].proc) return;
      const pid = runtime[name].proc.pid;
      if (!pid) return;
      pidusage(pid, (err, stats) => {
        if (err || !stats) return;
        const mb = stats.memory / 1024 / 1024;
        if (mb > procRecord.memoryLimit) {
          storage.appendLog(name, 'err', `[${new Date().toISOString()}] [PM3] Memory limit exceeded (${mb.toFixed(1)}MB > ${procRecord.memoryLimit}MB), restarting...`);
          restartProcess(name);
        }
      });
    }, 5000);
  }
}

// --- Control requests from a managed child (agent.stop / agent.restart) ---
//
// This grants no privilege a managed process did not already have: every child runs as
// the same user as the daemon and can already reach the daemon's HTTP API on localhost.
// What it adds is a way to do it without hardcoding a port, a name, or a pid.
function _handleControl(senderName, child, msg) {
  const reply = res => {
    try { child.send({ [AGENT_KEY]: 'control-ack', id: msg.id, ...res }); } catch {}
  };

  // No target means the sender itself - the one name the child never has to be trusted for.
  const target = msg.target ? resolveProcess(msg.target) : senderName;
  if (!target) return reply({ ok: false, error: `Process "${msg.target}" not found` });

  const procs = storage.loadProcesses();
  if (!procs[target]) return reply({ ok: false, error: `Process "${target}" not found` });

  const ts = new Date().toISOString();
  const via = target === senderName ? 'itself' : `"${senderName}"`;

  if (msg.action === 'stop') {
    // A plain stop already stays stopped: stopProcess marks the record STOPPED, which
    // both the exit handler and resurrect() honour. Persisting autorestart:false is a
    // separate, opt-in decision because it outlives the emergency - it would still be
    // off the next time somebody starts the process by hand.
    if (msg.disableAutorestart) updateProcess(target, { autorestart: false });
    storage.appendLog(target, 'out', `[${ts}] [PM3] Stop requested by ${via}`);
    // Ack before the SIGTERM so a self-stop has a chance to observe the result. It
    // usually loses that race, which is why the agent treats a timeout as failure
    // rather than assuming success.
    reply({ ok: true, action: 'stop', name: target });
    stopProcess(target);
    return;
  }

  if (msg.action === 'restart') {
    storage.appendLog(target, 'out', `[${ts}] [PM3] Restart requested by ${via}`);
    reply({ ok: true, action: 'restart', name: target });
    restartProcess(target);
    return;
  }

  reply({ ok: false, error: `Unknown control action "${msg.action}"` });
}

function _handleCrash(procRecord, exitCode, message, severity) {
  const name = procRecord.name;
  const logs = storage.readLog(name, 'err', 50);
  issueTracker.createIssue({
    processName: name,
    processId: procRecord.id,
    message,
    stack: logs,
    exitCode,
    reason: message,
    severity,
    logs,
  });
  emit('issue:new', issueTracker.getIssues()[0]);
}

function _captureIssue(name, errorText, severity) {
  const procs = storage.loadProcesses();
  const proc = procs[name];
  if (!proc) return;
  issueTracker.createIssue({
    processName: name,
    processId: proc.id,
    message: errorText.split('\n')[0].trim(),
    stack: errorText,
    exitCode: null,
    reason: 'Runtime error detected in stderr',
    severity,
    logs: errorText,
  });
  emit('issue:new', issueTracker.getIssues()[0]);
}

// Signal a child and everything it spawned. Children are started detached, so each is a
// process group leader and a negative pid reaches the whole group. Falls back to the bare
// child if the group is already gone (it is reaped as soon as the leader exits).
function _killTree(child, signal) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, signal); return; } catch {}
  try { child.kill(signal); } catch {}
}

// --- Stop process ---
function stopProcess(name) {
  const procs = storage.loadProcesses();
  if (!procs[name]) return { error: `Process "${name}" not found` };

  procs[name].status = STATUS.STOPPED;
  procs[name].cpu = 0;
  procs[name].memory = 0;
  procs[name].memDetail = null;
  procs[name].connections = 0;
  procs[name].netRx = 0;
  procs[name].netTx = 0;
  storage.saveProcesses(procs);

  if (runtime[name]) {
    if (runtime[name].watcher) runtime[name].watcher.close();
    if (runtime[name].memCheck) clearInterval(runtime[name].memCheck);
    _killTree(runtime[name].proc, 'SIGTERM');
    delete runtime[name];
  }

  emit('process:update', procs[name]);
  return procs[name];
}

// --- Stop every managed process, and wait for them to actually be gone ---
//
// Children are spawned with detached:false, which only means "same process group" - it
// does NOT make the OS kill them when the daemon exits. Without this they survive as
// orphans re-parented to init, still holding their ports, which is why a web server kept
// serving after `pm3 kill`. Their records also still said `running`, so the next daemon
// start resurrected them and produced a second copy fighting the first for the port.
//
// Resolves once every child has exited (or been SIGKILLed), so the caller can exit knowing
// nothing outlived it.
function stopAll(timeoutMs = 5000) {
  const entries = Object.entries(runtime).map(([name, r]) => [name, r && r.proc]);
  if (!entries.length) return Promise.resolve(0);

  // Mark what was running so the next daemon start brings back exactly this set. Written
  // before the signals go out, because after them these processes are indistinguishable
  // from ones somebody stopped by hand - and those must stay stopped.
  const procs = storage.loadProcesses();
  for (const [name] of entries) if (procs[name]) procs[name].resurrect = true;
  storage.saveProcesses(procs);

  // Listeners must be attached before the signals go out, or a child that dies
  // immediately would exit before anything is watching for it.
  const waits = entries.map(([, child]) => new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      _killTree(child, 'SIGKILL');
      resolve();                       // SIGKILL cannot be refused; don't wait on it
    }, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    child.once('exit', done);
    child.once('error', done);
  }));

  for (const [name] of entries) stopProcess(name);

  return Promise.all(waits).then(() => entries.length);
}

// --- Restart process ---
function restartProcess(name) {
  const procs = storage.loadProcesses();
  if (!procs[name]) return { error: `Process "${name}" not found` };

  // Capture the old child before stopping, so we can wait for its exit
  const oldRuntime = runtime[name];
  const oldChild   = oldRuntime ? oldRuntime.proc : null;
  const wasActive  = oldChild && oldChild.exitCode === null && oldChild.signalCode === null;

  // Tear down monitors / watchers and send SIGTERM
  stopProcess(name);

  function _doSpawn() {
    const latest = storage.loadProcesses();
    if (!latest[name]) return;
    latest[name].restartCount = (latest[name].restartCount || 0) + 1;
    latest[name].status = STATUS.RESTARTING;
    storage.saveProcesses(latest);
    emit('process:update', latest[name]);
    _spawnProcess(latest[name]);
  }

  if (wasActive) {
    // Wait for the old child to fully exit before spawning the replacement.
    // A 5-second watchdog sends SIGKILL if SIGTERM was ignored, then spawns.
    let spawned = false;
    const watchdog = setTimeout(() => {
      if (spawned) return;
      _killTree(oldChild, 'SIGKILL');
    }, 5000);

    const onExitOrError = () => {
      if (spawned) return;
      spawned = true;
      clearTimeout(watchdog);
      _doSpawn();
    };

    oldChild.once('exit',  onExitOrError);
    oldChild.once('error', onExitOrError);
  } else {
    // Process was already stopped/crashed - spawn immediately
    _doSpawn();
  }

  return procs[name];
}

// --- Delete process ---
function deleteProcess(name) {
  stopProcess(name);
  const procs = storage.loadProcesses();
  const record = procs[name];
  delete procs[name];
  storage.saveProcesses(procs);
  emit('process:delete', { name });
  return record;
}

// --- Get info ---
function getProcessInfo(name) {
  const procs = storage.loadProcesses();
  return procs[name] || null;
}

function getAllProcesses() {
  return storage.loadProcesses();
}

// --- Periodic stats update ---
async function updateStats() {
  const procs = storage.loadProcesses();
  const pids = Object.values(runtime)
    .filter(r => r.proc && r.proc.pid)
    .map(r => r.proc.pid);

  if (!pids.length) return;

  try {
    const stats = await pidusage(pids);
    let changed = false;

    for (const [name, r] of Object.entries(runtime)) {
      if (!r.proc || !r.proc.pid) continue;
      const s = stats[r.proc.pid];
      if (!s) continue;
      if (procs[name]) {
        procs[name].cpu = parseFloat(s.cpu.toFixed(1));
        procs[name].memory = Math.round(s.memory / 1024 / 1024);
        procs[name].uptime = s.elapsed ? Math.floor(s.elapsed / 1000) : 0;
        // Refreshed on memDetail's own 12 s schedule, carried on every 2 s broadcast
        // so the dashboard never has to poll for it.
        procs[name].memDetail = memDetail.get(name);
        changed = true;
      }
    }

    // Per-process metrics from /proc/<pid>/ (Linux only)
    if (process.platform === 'linux') {
      // Build set of TCP/UDP socket inodes once for the whole update cycle.
      // Unix-domain sockets (used internally by Node.js) are excluded because
      // they don't appear in these tables - so internal libuv sockets don't inflate the count.
      const tcpInodes = new Set();
      for (const f of ['/proc/net/tcp', '/proc/net/tcp6', '/proc/net/udp', '/proc/net/udp6']) {
        try {
          fs.readFileSync(f, 'utf8').split('\n').slice(1).forEach(line => {
            const inode = line.trim().split(/\s+/)[9];
            if (inode && inode !== '0') tcpInodes.add(inode);
          });
        } catch {}
      }

      for (const [name, r] of Object.entries(runtime)) {
        if (!r.proc?.pid || !procs[name]) continue;
        const pid = r.proc.pid;

        // Count only real TCP/UDP sockets by cross-referencing fd symlinks with tcpInodes
        try {
          const fds = fs.readdirSync(`/proc/${pid}/fd`);
          let sockets = 0;
          for (const fd of fds) {
            try {
              const m = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
              if (m && tcpInodes.has(m[1])) sockets++;
            } catch {}
          }
          procs[name].connections = sockets;
          changed = true;
        } catch {}

        // Network I/O via /proc/<pid>/io:
        // rchar/wchar = total read/write syscall bytes (disk + network + pipes)
        // read_bytes/write_bytes = actual disk bytes only
        // => (rchar - read_bytes) ≈ network+pipe RX  |  (wchar - write_bytes) ≈ network+pipe TX
        try {
          const io = {};
          fs.readFileSync(`/proc/${pid}/io`, 'utf8').split('\n').forEach(line => {
            const [k, v] = line.split(': ');
            if (k && v !== undefined) io[k.trim()] = parseInt(v.trim()) || 0;
          });
          const now = Date.now();
          const prev = prevProcIO[pid];
          if (prev) {
            const dt = (now - prev.ts) / 1000;
            if (dt >= 0.5) {
              const rxDelta = Math.max(0, (io.rchar - prev.rchar) - (io.read_bytes - prev.read_bytes));
              const txDelta = Math.max(0, (io.wchar - prev.wchar) - (io.write_bytes - prev.write_bytes));
              procs[name].netRx = Math.round(rxDelta / dt);
              procs[name].netTx = Math.round(txDelta / dt);
              changed = true;
            }
          }
          prevProcIO[pid] = { rchar: io.rchar, wchar: io.wchar, read_bytes: io.read_bytes, write_bytes: io.write_bytes, ts: Date.now() };
        } catch {}
      }
    }

    if (changed) {
      storage.saveProcesses(procs);
      emit('stats:update', procs);
    }
  } catch {}
}

// --- Resurrect saved processes ---
// Two ways a process earns a restart on daemon start:
//   RUNNING/STARTING - the daemon died without cleaning up (crash, SIGKILL, power loss).
//   resurrect flag   - `pm3 kill` took it down on purpose and owes it a comeback.
// A process stopped by hand has neither, and stays down.
function resurrect() {
  const procs = storage.loadProcesses();
  const toStart = [];
  for (const proc of Object.values(procs)) {
    if (proc.status === STATUS.RUNNING || proc.status === STATUS.STARTING || proc.resurrect) {
      delete proc.resurrect;        // one-shot: a later hand-stop must not be undone
      toStart.push(proc);
    }
  }
  // Persist the cleared flags BEFORE spawning: _spawnProcess writes each record itself,
  // and saving this older snapshot afterwards would wipe the pids it just recorded.
  if (toStart.length) storage.saveProcesses(procs);
  for (const proc of toStart) _spawnProcess(proc);
  return toStart.length;
}

// --- Resolve by name or id ---
function resolveProcess(nameOrId) {
  const procs = storage.loadProcesses();
  if (procs[nameOrId]) return nameOrId;
  const found = Object.values(procs).find(p => String(p.id) === String(nameOrId));
  return found ? found.name : null;
}

// --- Update process settings (name, maxRestarts, memoryLimit, autorestart) ---
function updateProcess(name, updates) {
  const procs = storage.loadProcesses();
  if (!procs[name]) return { error: `Process "${name}" not found` };

  // Simple field updates (take effect on next restart)
  for (const key of ['maxRestarts', 'memoryLimit', 'autorestart']) {
    if (updates[key] !== undefined) procs[name][key] = updates[key];
  }

  // Env is replaced wholesale rather than merged: the editor shows the complete set of
  // overrides, so a key the user deleted must actually disappear. A running process keeps the
  // environment it was spawned with - Linux gives no way to change it - so this lands on the
  // next restart, which is what the dashboard tells the user.
  if (updates.env !== undefined) {
    const { env, error } = _sanitizeEnv(updates.env);
    if (error) return { error };
    procs[name].env = env;
  }

  // Rename
  const newName = (updates.name || '').trim();
  if (newName && newName !== name) {
    if (procs[newName]) return { error: `Name "${newName}" is already taken` };
    procs[newName] = { ...procs[name], name: newName };
    delete procs[name];
    if (runtime[name]) { runtime[newName] = runtime[name]; delete runtime[name]; }
    memDetail.rename(name, newName);
    // Best-effort log file rename
    try {
      const oldOut = storage.getLogPath(name, 'out');
      const oldErr = storage.getLogPath(name, 'err');
      if (fs.existsSync(oldOut)) fs.renameSync(oldOut, storage.getLogPath(newName, 'out'));
      if (fs.existsSync(oldErr)) fs.renameSync(oldErr, storage.getLogPath(newName, 'err'));
    } catch {}
    storage.saveProcesses(procs);
    emit('process:delete', { name });
    emit('process:update', procs[newName]);
    return procs[newName];
  }

  storage.saveProcesses(procs);
  emit('process:update', procs[name]);
  return procs[name];
}

// --- Send data to process stdin ---
function sendStdin(name, data) {
  const r = runtime[name];
  if (!r || !r.proc) return { error: `Process "${name}" is not running` };
  const stdin = r.proc.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) return { error: 'stdin is closed' };
  try {
    stdin.write(data + '\n');
    storage.appendLog(name, 'out', `[${new Date().toISOString()}] [STDIN] ${data}`);
    emit('log', { name, line: `[${new Date().toISOString()}] [STDIN] ${data}`, type: 'stdin' });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

function resetRestartCount(name) {
  const procs = storage.loadProcesses();
  if (!procs[name]) return { error: `Process "${name}" not found` };
  procs[name].restartCount = 0;
  storage.saveProcesses(procs);
  emit('process:update', procs[name]);
  return procs[name];
}

module.exports = {
  setEmitter,
  startProcess,
  stopProcess,
  stopAll,
  restartProcess,
  deleteProcess,
  getProcessInfo,
  getAllProcesses,
  updateStats,
  pollMemDetail: () => memDetail.pollAll(runtime),
  getMemDetail: name => ({ detail: memDetail.get(name), history: memDetail.getHistory(name) }),
  deepSizeStructure: (name, structure) =>
    runtime[name] ? memDetail.deepSize(name, runtime[name], structure)
                  : Promise.resolve({ error: `Process "${name}" is not running` }),
  memPollInterval: memDetail.POLL_MS,
  resurrect,
  resolveProcess,
  updateProcess,
  sendStdin,
  resetRestartCount,
};