'use strict';

// Keep the daemon alive on unexpected errors — log them but never crash.
process.on('uncaughtException',  err  => console.error('[PM3] Uncaught exception:',  err));
process.on('unhandledRejection', reason => console.error('[PM3] Unhandled rejection:', reason));

const http = require('http');
const os = require('os');
const dns = require('dns');
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
const _daemonStartTs = Date.now();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

// Disk I/O throughput tracking (delta-based, mirrors _pollNetSpeed pattern)
let _prevFsRx = 0, _prevFsWx = 0, _prevFsTs = 0;
let _diskSpeed = { readSec: 0, writeSec: 0 };
async function _pollDiskSpeed() {
  try {
    const s = await si.fsStats();
    const now = Date.now();
    if (_prevFsTs) {
      const dt = (now - _prevFsTs) / 1000;
      if (dt > 0 && dt < 15) {
        _diskSpeed = {
          readSec:  Math.round(Math.max(0, (s.rx - _prevFsRx) / dt)),
          writeSec: Math.round(Math.max(0, (s.wx - _prevFsWx) / dt)),
        };
      }
    }
    _prevFsRx = s.rx; _prevFsWx = s.wx; _prevFsTs = now;
  } catch {}
}

// Network speed tracking (total + per-interface)
let _prevNetBytes = {};
let _netSpeed = { rxSec: 0, txSec: 0 };
let _ifaceSpeed = {};
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
          const irx = Math.max(0, (i.rx_bytes - p.rx) / dt);
          const itx = Math.max(0, (i.tx_bytes - p.tx) / dt);
          rx += irx; tx += itx;
          _ifaceSpeed[i.iface] = { rxSec: Math.round(irx), txSec: Math.round(itx) };
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
    const [cpu, mem, disk, cpuStatic, temp, freq] = await Promise.all([
      si.currentLoad(), si.mem(), si.fsSize(), _getCpuStatic(), _getCpuTemp(), _getCpuFreq(),
    ]);
    await _pollNetSpeed();
    const tempData = temp && temp.main != null ? {
      main: temp.main, cores: temp.cores || [], max: temp.max ?? null,
    } : null;
    const freqData = freq ? {
      avg: freq.avg ?? null, min: freq.min ?? null, max: freq.max ?? null, cores: freq.cores || [],
    } : null;
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
      physicalCores: cpuStatic?.physicalCores ?? null,
      cpuInfo: cpuStatic ? {
        manufacturer: cpuStatic.manufacturer || null,
        brand: cpuStatic.brand || null,
        speed: cpuStatic.speed || null,
        speedMax: cpuStatic.speedMax || null,
        socket: cpuStatic.socket || null,
        cache: cpuStatic.cache || null,
        cores: cpuStatic.cores || null,
        physicalCores: cpuStatic.physicalCores || null,
      } : null,
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
        active: mem.active || 0,
        free: mem.free || 0,
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
      temp: tempData,
      freq: freqData,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detailed network info (interfaces, DNS, gateway) — cached 5 s
app.get('/api/system/network', async (req, res) => {
  try {
    if (_netDetailCache && Date.now() - _netDetailTs < 5000) return res.json(_netDetailCache);
    const [ifaces, gw, stats] = await Promise.all([
      si.networkInterfaces(), si.networkGatewayDefault(), si.networkStats(),
    ]);
    const dnsServers = dns.getServers(); // synchronous Node.js built-in
    const ifaceArr = Array.isArray(ifaces) ? ifaces : (ifaces ? [ifaces] : []);
    _netDetailCache = {
      hostname: os.hostname(),
      gateway: gw || null,
      dns: dnsServers || [],
      ifaces: ifaceArr.filter(i => i && !i.internal).map(i => ({
        iface: i.iface || '',
        ip4: i.ip4 || null,
        ip4subnet: i.ip4subnet || null,
        ip6: i.ip6 || null,
        mac: i.mac || null,
        type: i.type || null,
        speed: i.speed || null,
        mtu: i.mtu || null,
        duplex: i.duplex || null,
        operstate: i.operstate || null,
        dhcp: i.dhcp ?? null,
      })),
      stats: (stats || []).filter(s => s.iface !== 'lo').map(s => ({
        iface: s.iface,
        rxBytes: s.rx_bytes || 0,
        txBytes: s.tx_bytes || 0,
        rxErrors: s.rx_errors || 0,
        txErrors: s.tx_errors || 0,
        rxDropped: s.rx_dropped || 0,
        txDropped: s.tx_dropped || 0,
      })),
      rxSec: _netSpeed.rxSec,
      txSec: _netSpeed.txSec,
      ifaceSpeed: _ifaceSpeed,
    };
    _netDetailTs = Date.now();
    res.json(_netDetailCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Memory layout (DDR type, speed, slots) — returns cached hardware info
app.get('/api/system/mem-layout', async (req, res) => {
  try {
    const layout = await _getMemLayout();
    res.json(layout || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process stats summary — cached 5 s (si.processes() scans /proc, can be slow)
let _procStatsCache = null;
let _procStatsTs = 0;
async function _getProcStats() {
  if (_procStatsCache && Date.now() - _procStatsTs < 5000) return _procStatsCache;
  try {
    const p = await si.processes();
    _procStatsCache = { all: p.all||0, running: p.running||0, sleeping: p.sleeping||0, stopped: p.stopped||0, blocked: p.blocked||0 };
    _procStatsTs = Date.now();
  } catch { /* keep previous cache */ }
  return _procStatsCache;
}

// Runtime overview — PM3 stats, system process counts, uptime
app.get('/api/system/runtime', async (req, res) => {
  try {
    const procStats = await _getProcStats();
    const pm3Procs = Object.values(pm.getAllProcesses());
    const allIssues = issueTracker.getIssues();
    const running = pm3Procs.filter(p => p.status === STATUS.RUNNING);
    const longestRunning = running.length
      ? running.reduce((a, b) => (a.uptime||0) > (b.uptime||0) ? a : b)
      : null;
    const avgUptime = running.length
      ? Math.round(running.reduce((s,p) => s+(p.uptime||0), 0) / running.length)
      : 0;
    res.json({
      system: procStats || { all:0, running:0, sleeping:0, stopped:0, blocked:0 },
      pm3: {
        total:        pm3Procs.length,
        running:      running.length,
        stopped:      pm3Procs.filter(p=>p.status==='stopped').length,
        crashed:      pm3Procs.filter(p=>p.status==='crashed').length,
        restarting:   pm3Procs.filter(p=>p.status==='restarting').length,
        totalRestarts:pm3Procs.reduce((s,p)=>s+(p.restartCount||0),0),
        totalIssues:  allIssues.length,
        longestRunning: longestRunning ? { name:longestRunning.name, uptime:longestRunning.uptime } : null,
        avgUptime,
      },
      uptime: {
        system:      Math.round(os.uptime()),
        daemon:      Math.round((Date.now() - _daemonStartTs) / 1000),
        daemonStart: _daemonStartTs,
        bootTime:    Math.round(Date.now() / 1000 - os.uptime()),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Storage detail — filesystems + physical drives + I/O rates (cached 4 s)
let _storageCache = null;
let _storageTs = 0;
const _FS_SKIP_TYPES = new Set(['tmpfs','devtmpfs','efivarfs','squashfs','overlay','proc','sysfs','cgroup2','pstore','securityfs','devpts','fusectl','binfmt_misc','ramfs','autofs','hugetlbfs','mqueue','debugfs','tracefs','configfs']);
app.get('/api/system/storage', async (req, res) => {
  try {
    if (_storageCache && Date.now() - _storageTs < 4000) {
      _storageCache.readSec = _diskSpeed.readSec;
      _storageCache.writeSec = _diskSpeed.writeSec;
      return res.json(_storageCache);
    }
    const [sizes, layout] = await Promise.all([si.fsSize(), si.diskLayout()]);
    const fsList = sizes.filter(f =>
      f.size > 10 * 1024 * 1024 &&
      !_FS_SKIP_TYPES.has(f.type) &&
      !f.mount.startsWith('/sys') &&
      !f.mount.startsWith('/proc') &&
      !f.mount.startsWith('/dev')
    ).map(f => ({
      fs: f.fs, type: f.type||null, size: f.size, used: f.used,
      available: f.available ?? Math.max(0, f.size - f.used),
      use: f.use||0, mount: f.mount, rw: f.rw,
    }));
    _storageCache = {
      fs: fsList,
      disks: layout.map(d => ({
        name: d.name, type: d.type, vendor: d.vendor||null, size: d.size,
        interfaceType: d.interfaceType||null, smartStatus: d.smartStatus||null,
        temperature: d.temperature||null, powerOnHours: d.powerOnHours||null,
        serialNum: d.serialNum||null, firmwareRevision: d.firmwareRevision||null,
      })),
      readSec: _diskSpeed.readSec,
      writeSec: _diskSpeed.writeSec,
    };
    _storageTs = Date.now();
    res.json(_storageCache);
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
    _sysProcCache = data.list.map(p => {
      const exe  = p.path ? `${p.path}/${p.command || p.name}` : (p.command || p.name);
      const full = p.params ? `${exe} ${p.params}` : exe;
      return {
        pid:       p.pid,
        parentPid: p.parentPid,
        name:      p.name,
        command:   full,
        user:      p.user || '—',
        cpu:       parseFloat((p.cpu   || 0).toFixed(1)),
        mem:       parseFloat((p.mem   || 0).toFixed(2)),
        memRss:    Math.round((p.memRss || 0) / 1024),
        state:     p.state || '—',
        nice:      p.nice  ?? 0,
        started:   p.started || '',
        priority:  p.priority ?? 0,
      };
    });
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

// CPU static info (physical cores, model, cache, etc.) — fetched once and cached
let _cpuStaticInfo = null;
async function _getCpuStatic() {
  if (!_cpuStaticInfo) _cpuStaticInfo = await si.cpu();
  return _cpuStaticInfo;
}
_getCpuStatic().catch(() => {});

// CPU temperature — polled and cached (unsupported on some platforms)
let _cpuTempCache = null;
let _cpuTempTs = 0;
async function _getCpuTemp() {
  if (Date.now() - _cpuTempTs < 2500) return _cpuTempCache;
  try { _cpuTempCache = await si.cpuTemperature(); } catch { _cpuTempCache = null; }
  _cpuTempTs = Date.now();
  return _cpuTempCache;
}
_getCpuTemp().catch(() => {});

// CPU current clock speed — polled and cached
let _cpuFreqCache = null;
let _cpuFreqTs = 0;
async function _getCpuFreq() {
  if (Date.now() - _cpuFreqTs < 2500) return _cpuFreqCache;
  try { _cpuFreqCache = await si.cpuCurrentSpeed(); } catch { _cpuFreqCache = null; }
  _cpuFreqTs = Date.now();
  return _cpuFreqCache;
}

// Memory layout (DDR type, speed, slots) — fetched once at startup (hardware doesn't change)
let _memLayoutCache = null;
async function _getMemLayout() {
  if (_memLayoutCache) return _memLayoutCache;
  try { _memLayoutCache = await si.memLayout(); } catch { _memLayoutCache = []; }
  return _memLayoutCache;
}
_getMemLayout().catch(() => {});

// Network detail cache (interfaces, DNS, gateway) — cached 8 s
let _netDetailCache = null;
let _netDetailTs = 0;

// --- Stats polling ---
setInterval(() => {
  pm.updateStats();
}, 2000);

// --- System metrics broadcast ---
setInterval(async () => {
  try {
    const [cpu, mem, cpuStatic, temp, freq] = await Promise.all([
      si.currentLoad(), si.mem(), _getCpuStatic(), _getCpuTemp(), _getCpuFreq(),
    ]);
    await Promise.all([_pollNetSpeed(), _pollDiskSpeed()]);
    const tempData = temp && temp.main != null ? {
      main: temp.main, cores: temp.cores || [], max: temp.max ?? null,
    } : null;
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
      physicalCores: cpuStatic?.physicalCores ?? null,
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
        active: mem.active || 0,
        free: mem.free || 0,
      },
      network: _netSpeed,
      ifaceSpeed: _ifaceSpeed,
      diskSpeed: _diskSpeed,
      temp: tempData,
      freq: freq ? { avg: freq.avg ?? null, min: freq.min ?? null, max: freq.max ?? null, cores: freq.cores || [] } : null,
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
