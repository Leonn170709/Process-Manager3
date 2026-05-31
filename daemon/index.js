'use strict';

// Keep the daemon alive on unexpected errors — log them but never crash.
process.on('uncaughtException',  err  => console.error('[PM3] Uncaught exception:',  err));
process.on('unhandledRejection', reason => console.error('[PM3] Unhandled rejection:', reason));

const http = require('http');
const os = require('os');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');
const { EventEmitter } = require('events');
const si = require('systeminformation');
const fs = require('fs');

const { DAEMON_PORT, DASHBOARD_PORT, PATHS, STATUS } = require('../config/constants');
const storage = require('../storage');
const pm = require('../core/processManager');
const issueTracker = require('../issues');
const userConfig = require('../config/userConfig');

storage.ensureHome();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

// Network speed tracking
let _prevNetBytes = {};
let _netSpeed = { rxSec: 0, txSec: 0 };
async function _pollNetSpeed() {
  try {
    const ifaces = await si.networkStats();
    const now = Date.now();
    let rx = 0, tx = 0;
    for (const i of ifaces) {
      if (i.iface === 'lo') continue;
      const p = _prevNetBytes[i.iface];
      if (p) {
        const dt = (now - p.ts) / 1000;
        if (dt > 0 && dt < 15) {
          rx += Math.max(0, (i.rx_bytes - p.rx) / dt);
          tx += Math.max(0, (i.tx_bytes - p.tx) / dt);
        }
      }
      _prevNetBytes[i.iface] = { rx: i.rx_bytes, tx: i.tx_bytes, ts: now };
    }
    _netSpeed = { rxSec: Math.round(rx), txSec: Math.round(tx) };
  } catch {}
}

// Internal event bus
const emitter = new EventEmitter();
pm.setEmitter(emitter);

// Forward internal events to Socket.IO clients
emitter.on('process:update', data => io.emit('process:update', data));
emitter.on('process:delete', data => io.emit('process:delete', data));
emitter.on('stats:update', data => io.emit('stats:update', data));
emitter.on('issue:new', data => io.emit('issue:new', data));
// Batch log lines into a single Socket.IO event per 50 ms window to prevent
// flooding the WebSocket when a process outputs at high speed.
const _logBatch = [];
let _logTimer = null;
emitter.on('log', data => {
  _logBatch.push(data);
  if (!_logTimer) {
    _logTimer = setTimeout(() => {
      io.emit('log:batch', _logBatch.splice(0));
      _logTimer = null;
    }, 50);
  }
});

app.use(express.json());

// Resurrect processes on startup (configurable)
if (userConfig.get('autoResurrect') !== false) {
  pm.resurrect();
}

// --- API Routes ---

// List processes
app.get('/api/processes', (req, res) => {
  res.json(pm.getAllProcesses());
});

// Get single process
app.get('/api/processes/:name', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  res.json(pm.getProcessInfo(name));
});

// Start process
app.post('/api/processes/start', (req, res) => {
  const config = req.body;
  if (!config.script) return res.status(400).json({ error: 'script is required' });
  try {
    const proc = pm.startProcess(config);
    res.json(proc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop process
app.post('/api/processes/:name/stop', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  res.json(pm.stopProcess(name));
});

// Restart process
app.post('/api/processes/:name/restart', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  res.json(pm.restartProcess(name));
});

// Update process (rename, settings)
app.patch('/api/processes/:name', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  const result = pm.updateProcess(name, req.body);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Reset restart count
app.post('/api/processes/:name/reset-restarts', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  res.json(pm.resetRestartCount(name));
});

// Send to stdin
app.post('/api/processes/:name/stdin', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  const { data } = req.body;
  if (data === undefined || data === null) return res.status(400).json({ error: 'data is required' });
  const result = pm.sendStdin(name, String(data));
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Delete process
app.delete('/api/processes/:name', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  res.json(pm.deleteProcess(name));
});

// Get logs
app.get('/api/logs/:name', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  const lines = parseInt(req.query.lines || '200', 10);
  const out = storage.readLog(name, 'out', lines);
  const err = storage.readLog(name, 'err', lines);
  res.json({ name, out, err, combined: mergeAndSort(out, err) });
});

// Clear log files
app.delete('/api/logs/:name', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  storage.clearLog(name);
  res.json({ ok: true });
});

// Get log file stream (tail)
app.get('/api/logs/:name/stream', (req, res) => {
  const name = pm.resolveProcess(req.params.name);
  if (!name) return res.status(404).json({ error: 'Process not found' });
  const logPath = storage.getLogPath(name, 'out');
  if (!fs.existsSync(logPath)) return res.json({ lines: [] });
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n').filter(Boolean).slice(-200);
  res.json({ lines });
});

// Issues
app.get('/api/issues', (req, res) => {
  res.json(issueTracker.getIssues());
});

app.delete('/api/issues/:id', (req, res) => {
  issueTracker.deleteIssue(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/issues', (req, res) => {
  issueTracker.clearIssues();
  res.json({ ok: true });
});

app.post('/api/issues/:id/resolve', (req, res) => {
  issueTracker.resolveIssue(req.params.id);
  res.json({ ok: true });
});

// Config
app.get('/api/config', (req, res) => {
  res.json({ config: userConfig.getAll(), schema: userConfig.SCHEMA });
});

app.post('/api/config', (req, res) => {
  const { key, value } = req.body;
  try {
    const result = userConfig.set(key, String(value));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/config/reset', (req, res) => {
  const defaults = userConfig.reset();
  res.json({ ok: true, config: defaults });
});

// System metrics
app.get('/api/system', async (req, res) => {
  try {
    const [cpu, mem, disk] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
    ]);
    await _pollNetSpeed();
    res.json({
      cpu: parseFloat(cpu.currentLoad.toFixed(1)),
      cpuUser: parseFloat((cpu.currentLoadUser || 0).toFixed(1)),
      cpuSystem: parseFloat((cpu.currentLoadSystem || 0).toFixed(1)),
      cpuIdle: parseFloat((cpu.currentLoadIdle || 0).toFixed(1)),
      cpus: (cpu.cpus || []).map(c => ({
        load: parseFloat((c.load || 0).toFixed(1)),
        user: parseFloat((c.loadUser || 0).toFixed(1)),
        system: parseFloat((c.loadSystem || 0).toFixed(1)),
      })),
      loadavg: os.loadavg(),
      memory: {
        total: mem.total,
        used: mem.active,
        available: mem.available,
        percent: parseFloat(((mem.active / mem.total) * 100).toFixed(1)),
        buffers: mem.buffers || 0,
        cached: mem.cached || 0,
        swapTotal: mem.swaptotal || 0,
        swapUsed: mem.swapused || 0,
        swapFree: mem.swapfree || 0,
      },
      disk: disk.map(d => ({
        fs: d.fs,
        size: d.size,
        used: d.used,
        mount: d.mount,
        percent: d.use,
      })),
      loadAverage: cpu.avgLoad,
      uptime: si.time().uptime,
      network: _netSpeed,
      processCount: Object.values(pm.getAllProcesses()).filter(p => p.status === STATUS.RUNNING).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// System-wide process list (cached 2 s to avoid hammering /proc)
let _sysProcCache = null;
let _sysProcTs = 0;
app.get('/api/system/processes', async (req, res) => {
  try {
    if (_sysProcCache && Date.now() - _sysProcTs < 2000) return res.json(_sysProcCache);
    const data = await si.processes();
    _sysProcCache = data.list.map(p => ({
      pid:       p.pid,
      parentPid: p.parentPid,
      name:      p.name,
      command:   p.command || p.name,
      user:      p.user || '—',
      cpu:       parseFloat((p.cpu   || 0).toFixed(1)),
      mem:       parseFloat((p.mem   || 0).toFixed(2)),
      memRss:    Math.round((p.memRss || 0) / 1024),
      state:     p.state || '—',
      nice:      p.nice  ?? 0,
      started:   p.started || '',
      priority:  p.priority ?? 0,
    }));
    _sysProcTs = Date.now();
    res.json(_sysProcCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save (mark all running processes for resurrect)
app.post('/api/save', (req, res) => {
  const procs = pm.getAllProcesses();
  storage.saveProcesses(procs);
  res.json({ ok: true, saved: Object.keys(procs).length });
});

// Daemon health
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, pid: process.pid, version: '1.0.0' });
});

// Dashboard preferences
app.get('/api/prefs', (req, res) => {
  res.json(storage.loadPrefs());
});

app.put('/api/prefs', (req, res) => {
  const prefs = req.body;
  storage.savePrefs(prefs);
  io.emit('prefs:update', prefs);
  res.json({ ok: true });
});

// --- Socket.IO ---
io.on('connection', socket => {
  // Send current state on connect
  socket.emit('init', {
    processes: pm.getAllProcesses(),
    issues: issueTracker.getIssues(),
    prefs: storage.loadPrefs(),
  });
});

// --- Stats polling ---
setInterval(() => {
  pm.updateStats();
}, 2000);

// --- System metrics broadcast ---
setInterval(async () => {
  try {
    const [cpu, mem] = await Promise.all([si.currentLoad(), si.mem()]);
    await _pollNetSpeed();
    io.emit('system:update', {
      cpu: parseFloat(cpu.currentLoad.toFixed(1)),
      cpuUser: parseFloat((cpu.currentLoadUser || 0).toFixed(1)),
      cpuSystem: parseFloat((cpu.currentLoadSystem || 0).toFixed(1)),
      cpuIdle: parseFloat((cpu.currentLoadIdle || 0).toFixed(1)),
      cpus: (cpu.cpus || []).map(c => ({
        load: parseFloat((c.load || 0).toFixed(1)),
        user: parseFloat((c.loadUser || 0).toFixed(1)),
        system: parseFloat((c.loadSystem || 0).toFixed(1)),
      })),
      loadavg: os.loadavg(),
      memory: {
        total: mem.total,
        used: mem.active,
        available: mem.available,
        percent: parseFloat(((mem.active / mem.total) * 100).toFixed(1)),
        buffers: mem.buffers || 0,
        cached: mem.cached || 0,
        swapTotal: mem.swaptotal || 0,
        swapUsed: mem.swapused || 0,
        swapFree: mem.swapfree || 0,
      },
      network: _netSpeed,
    });
  } catch {}
}, 3000);

// --- Dashboard static serve ---
const dashboardPath = require('path').join(__dirname, '../dashboard/public');
app.use('/dashboard', express.static(dashboardPath));
app.get('/dashboard', (req, res) => {
  res.sendFile(require('path').join(dashboardPath, 'index.html'));
});
app.get('/', (req, res) => res.redirect('/dashboard'));

server.listen(DAEMON_PORT, '0.0.0.0', () => {
  console.log(`PM3 Daemon running on port ${DAEMON_PORT}`);
  console.log(`PM3 Dashboard: http://localhost:${DAEMON_PORT}/dashboard`);
});

// --- Helpers ---
function mergeAndSort(out, err) {
  const lines = [...out.split('\n'), ...err.split('\n')]
    .filter(Boolean)
    .sort();
  return lines.join('\n');
}

// Write PID file
fs.writeFileSync(PATHS.pid, String(process.pid), 'utf8');

// Graceful shutdown
process.on('SIGTERM', () => {
  try { fs.unlinkSync(PATHS.pid); } catch {}
  process.exit(0);
});
process.on('SIGINT', () => {
  try { fs.unlinkSync(PATHS.pid); } catch {}
  process.exit(0);
});
