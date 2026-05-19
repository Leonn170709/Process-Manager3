'use strict';

const http = require('http');
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

// Internal event bus
const emitter = new EventEmitter();
pm.setEmitter(emitter);

// Forward internal events to Socket.IO clients
emitter.on('process:update', data => io.emit('process:update', data));
emitter.on('process:delete', data => io.emit('process:delete', data));
emitter.on('stats:update', data => io.emit('stats:update', data));
emitter.on('issue:new', data => io.emit('issue:new', data));
emitter.on('log', data => io.emit('log', data));

app.use(express.json());

// Resurrect processes on startup
pm.resurrect();

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
    const [cpu, mem, disk, load, uptime] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.currentLoad(),
      Promise.resolve(si.time().uptime),
    ]);
    res.json({
      cpu: parseFloat(cpu.currentLoad.toFixed(1)),
      memory: {
        total: mem.total,
        used: mem.active,
        available: mem.available,
        percent: parseFloat(((mem.active / mem.total) * 100).toFixed(1)),
      },
      disk: disk.map(d => ({
        fs: d.fs,
        size: d.size,
        used: d.used,
        mount: d.mount,
        percent: d.use,
      })),
      loadAverage: load.avgLoad,
      uptime: si.time().uptime,
      processCount: Object.values(pm.getAllProcesses()).filter(p => p.status === STATUS.RUNNING).length,
    });
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

// --- Socket.IO ---
io.on('connection', socket => {
  // Send current state on connect
  socket.emit('init', {
    processes: pm.getAllProcesses(),
    issues: issueTracker.getIssues(),
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
    io.emit('system:update', {
      cpu: parseFloat(cpu.currentLoad.toFixed(1)),
      memory: {
        total: mem.total,
        used: mem.active,
        available: mem.available,
        percent: parseFloat(((mem.active / mem.total) * 100).toFixed(1)),
      },
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

server.listen(DAEMON_PORT, '127.0.0.1', () => {
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
