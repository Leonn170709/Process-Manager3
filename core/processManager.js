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

// In-memory process map: id -> { proc, config, stats, watcher }
const runtime = {};

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

// --- Start process ---
function startProcess(config, savedConfig = {}) {
  const procs = storage.loadProcesses();

  // Build process record
  const id = config.id !== undefined ? config.id : generateId();
  const name = config.name || `pm3-${id}`;
  const { cmd, args } = parseCommand(config.script);
  const extraArgs = config.args || savedConfig.args || [];
  const cwd = resolveCwd(config.cwd || savedConfig.cwd, config.script);
  const env = Object.assign({}, process.env, config.env || savedConfig.env || {});
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
    env: config.env || savedConfig.env || {},
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

  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      env,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
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

  // Handle spawn errors (e.g. command not found) — without this handler
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

  // Log stdout
  child.stdout.on('data', data => {
    const line = `[${new Date().toISOString()}] ${data.toString().trimEnd()}`;
    storage.appendLog(name, 'out', line);
    emit('log', { name, line, type: 'out' });
  });

  // Log stderr
  child.stderr.on('data', data => {
    const line = `[${new Date().toISOString()}] [ERR] ${data.toString().trimEnd()}`;
    storage.appendLog(name, 'err', line);
    emit('log', { name, line, type: 'err' });

    // Detect error patterns
    const text = data.toString();
    if (text.includes('Error:') || text.includes('Exception') || text.includes('FATAL')) {
      _captureIssue(name, text, SEVERITY.ERROR);
    }
  });

  // Handle exit
  child.on('exit', (code, signal) => {
    const procs2 = storage.loadProcesses();
    if (!procs2[name]) return;

    procs2[name].pid = null;
    procs2[name].exitCode = code;
    procs2[name].cpu = 0;
    procs2[name].memory = 0;

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

    const shouldRestart =
      procs2[name].autorestart &&
      procs2[name].restartCount < procs2[name].maxRestarts &&
      !wasKilled;

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

  // Memory monitor
  if (procRecord.memoryLimit) {
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

// --- Stop process ---
function stopProcess(name) {
  const procs = storage.loadProcesses();
  if (!procs[name]) return { error: `Process "${name}" not found` };

  procs[name].status = STATUS.STOPPED;
  storage.saveProcesses(procs);

  if (runtime[name]) {
    if (runtime[name].watcher) runtime[name].watcher.close();
    if (runtime[name].memCheck) clearInterval(runtime[name].memCheck);
    try { runtime[name].proc.kill('SIGTERM'); } catch {}
    delete runtime[name];
  }

  emit('process:update', procs[name]);
  return procs[name];
}

// --- Restart process ---
function restartProcess(name) {
  const procs = storage.loadProcesses();
  if (!procs[name]) return { error: `Process "${name}" not found` };

  stopProcess(name);
  setTimeout(() => {
    const latest = storage.loadProcesses();
    if (latest[name]) {
      latest[name].status = STATUS.RESTARTING;
      storage.saveProcesses(latest);
      _spawnProcess(latest[name]);
    }
  }, 500);

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
        changed = true;
      }
    }

    if (changed) {
      storage.saveProcesses(procs);
      emit('stats:update', procs);
    }
  } catch {}
}

// --- Resurrect saved processes ---
function resurrect() {
  const procs = storage.loadProcesses();
  let count = 0;
  for (const [name, proc] of Object.entries(procs)) {
    if (proc.status === STATUS.RUNNING || proc.status === STATUS.STARTING) {
      _spawnProcess(proc);
      count++;
    }
  }
  return count;
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

  // Rename
  const newName = (updates.name || '').trim();
  if (newName && newName !== name) {
    if (procs[newName]) return { error: `Name "${newName}" is already taken` };
    procs[newName] = { ...procs[name], name: newName };
    delete procs[name];
    if (runtime[name]) { runtime[newName] = runtime[name]; delete runtime[name]; }
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

module.exports = {
  setEmitter,
  startProcess,
  stopProcess,
  restartProcess,
  deleteProcess,
  getProcessInfo,
  getAllProcesses,
  updateStats,
  resurrect,
  resolveProcess,
  updateProcess,
  sendStdin,
};