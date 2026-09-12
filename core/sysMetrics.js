'use strict';

// Linux fast paths for the figures the dashboard polls every 3 s. systeminformation gets them
// by spawning shells on every call (cat, lsblk, a loop over every hwmon sensor), two of them
// through execSync, which stalls the daemon's event loop. Here each is a few file reads.
// Other platforms keep using systeminformation.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const si = require('systeminformation');

const LINUX = process.platform === 'linux';

// --- CPU load ---
// Same formula as si.currentLoad, so the charts do not jump: busy = user+nice+system+irq+steal+
// guest, total = busy + idle; iowait and softirq count as neither.
let _prevCpu = null;
let _prevCpuTs = 0;
let _lastLoad = null;

async function currentLoad() {
  if (!LINUX) return si.currentLoad();
  if (_lastLoad && Date.now() - _prevCpuTs < 200) return _lastLoad;   // too short a window to mean anything
  const cores = [];
  for (const line of (await fsp.readFile('/proc/stat', 'utf8')).split('\n')) {
    if (!/^cpu\d/.test(line)) continue;
    const [user, nice, sys, idle, , irq, , steal = 0, guest = 0] = line.split(/\s+/).slice(1).map(Number);
    cores.push({ user, sys, idle, busy: user + nice + sys + irq + steal + guest });
  }
  const zero = { user: 0, sys: 0, idle: 0, busy: 0 };
  const d = cores.map((c, i) => {
    const p = (_prevCpu && _prevCpu[i]) || zero;
    return { user: c.user - p.user, sys: c.sys - p.sys, idle: c.idle - p.idle, busy: c.busy - p.busy };
  });
  const tot = d.reduce((a, c) => ({ user: a.user + c.user, sys: a.sys + c.sys, idle: a.idle + c.idle, busy: a.busy + c.busy }), zero);
  const pct = (x, c) => (c.busy + c.idle > 0 ? (x / (c.busy + c.idle)) * 100 : 0);
  _prevCpu = cores;
  _prevCpuTs = Date.now();
  _lastLoad = {
    currentLoad: pct(tot.busy, tot),
    currentLoadUser: pct(tot.user, tot),
    currentLoadSystem: pct(tot.sys, tot),
    currentLoadIdle: pct(tot.idle, tot),
    avgLoad: parseFloat(Math.max(...os.loadavg().map(x => x / (cores.length || 1))).toFixed(2)),
    cpus: d.map(c => ({ load: pct(c.busy, c), loadUser: pct(c.user, c), loadSystem: pct(c.sys, c) })),
  };
  return _lastLoad;
}

// --- CPU temperature ---
// Same sensor choice as si.cpuTemperature: AMD Tctl/Tdie or Intel "Package"/"Physical" is the
// main figure, "Core N" labels are per core. si's next fallback, `sensors`, reads these same
// files, so it is skipped and thermal_zone0 is the last resort as in si.
async function cpuTemperature() {
  if (!LINUX) return si.cpuTemperature();
  const readings = [];
  const base = '/sys/class/hwmon';
  for (const mon of (await fsp.readdir(base).catch(() => [])).sort()) {
    const dir = path.join(base, mon);
    const labels = (await fsp.readdir(dir).catch(() => [])).filter(f => /^temp\d+_label$/.test(f)).sort();
    for (const f of labels) {
      try {
        const [label, value] = await Promise.all([
          fsp.readFile(path.join(dir, f), 'utf8'),
          fsp.readFile(path.join(dir, f.replace('_label', '_input')), 'utf8'),
        ]);
        if (!Number.isNaN(parseInt(value, 10))) readings.push([label.trim().toLowerCase(), parseInt(value, 10)]);
      } catch {}
    }
  }
  // si only looks from the first Tdie reading onward when there is one
  const tdie = readings.findIndex(([l]) => l.includes('tdie'));
  const r = { main: null, cores: [], max: null };
  const c = v => Math.round(v / 100) / 10;
  for (const [l, v] of tdie === -1 ? readings : readings.slice(tdie)) {
    if (l === 'tctl') r.main = c(v);
    if (l.startsWith('core')) r.cores.push(c(v));
    else if (r.main === null && (l.includes('package') || l.includes('physical') || l === 'tccd1')) r.main = c(v);
  }
  if (r.cores.length) {
    if (r.main === null) r.main = Math.round(r.cores.reduce((a, b) => a + b, 0) / r.cores.length);
    r.max = Math.max(r.main, ...r.cores);
  }
  if (r.main !== null) {
    if (r.max === null) r.max = r.main;
    return r;
  }
  try {
    r.main = r.max = parseFloat(await fsp.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000;
  } catch {}
  return r;
}

// --- Network ---
// Byte counters for every interface from one read of /proc/net/dev, plus the default-route
// interface (lowest metric) from /proc/net/route - si.networkStats() only covers that one.
async function networkStats() {
  if (!LINUX) {
    const ifaces = await si.networkStats();
    return { ifaces, primary: ifaces[0] ? ifaces[0].iface : null };
  }
  const [dev, route] = await Promise.all([
    fsp.readFile('/proc/net/dev', 'utf8'),
    fsp.readFile('/proc/net/route', 'utf8').catch(() => ''),
  ]);
  const ifaces = [];
  for (const line of dev.split('\n').slice(2)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const f = line.slice(colon + 1).trim().split(/\s+/);
    ifaces.push({ iface: line.slice(0, colon).trim(), rx_bytes: +f[0], tx_bytes: +f[8] });
  }
  let primary = null, best = Infinity;
  for (const line of route.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === '00000000' && f[7] === '00000000' && +f[6] < best) { primary = f[0]; best = +f[6]; }
  }
  return { ifaces, primary };
}

// --- Disk I/O ---
// Whole physical disks only (they have a /sys/block/<dev>/device link). Partitions, dm/LVM/LUKS
// and loop devices sit on top of those and would count the same bytes twice. si counted mounted
// partitions instead, which misses an encrypted or LVM root entirely.
async function fsStats() {
  if (!LINUX) return si.fsStats();
  const disks = new Set((await fsp.readdir('/sys/block').catch(() => []))
    .filter(d => fs.existsSync(`/sys/block/${d}/device`)));
  let rx = 0, wx = 0;
  for (const line of (await fsp.readFile('/proc/diskstats', 'utf8')).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (disks.has(f[2])) { rx += +f[5] * 512; wx += +f[9] * 512; }   // sectors are always 512 B here
  }
  return { rx, wx };
}

module.exports = { currentLoad, cpuTemperature, networkStats, fsStats };
