// node test/sys-metrics.js — checks core/sysMetrics' Linux readers against systeminformation,
// which they replace on the dashboard's 3 s tick. Skipped on other platforms.
const assert = require('assert');
const os = require('os');
const si = require('systeminformation');
const sys = require('../core/sysMetrics');

if (process.platform !== 'linux') {
  console.log('sys-metrics: skipped (not linux)');
  process.exit(0);
}

(async () => {
  await sys.currentLoad();
  await new Promise(r => setTimeout(r, 500));
  const load = await sys.currentLoad();
  assert.strictEqual(load.cpus.length, os.cpus().length, 'one entry per core');
  for (const v of [load.currentLoad, load.currentLoadUser, load.currentLoadSystem, load.currentLoadIdle, ...load.cpus.map(c => c.load)]) {
    assert.ok(v >= 0 && v <= 100.0001, `load out of range: ${v}`);
  }
  assert.ok(Math.abs(load.currentLoad + load.currentLoadIdle - 100) < 0.01, 'busy + idle must be 100%');
  assert.strictEqual(await sys.currentLoad(), load, 'a second call within 200 ms reuses the sample');

  const [siTemp, temp] = await Promise.all([si.cpuTemperature(), sys.cpuTemperature()]);
  if (siTemp.main != null) {
    assert.ok(Math.abs(temp.main - siTemp.main) < 3, `temp main ${temp.main} vs si ${siTemp.main}`);
    assert.strictEqual(temp.cores.length, siTemp.cores.length, 'same per-core sensors');
  }

  const [siNet] = await si.networkStats();
  const net = await sys.networkStats();
  if (siNet && siNet.iface) {
    assert.strictEqual(net.primary, siNet.iface, 'default interface');
    const mine = net.ifaces.find(i => i.iface === net.primary);
    assert.ok(mine.rx_bytes >= siNet.rx_bytes && mine.rx_bytes - siNet.rx_bytes < 50e6, `rx ${mine.rx_bytes} vs si ${siNet.rx_bytes}`);
  }

  // si sums mounted partitions, which live on the physical disks counted here
  const siDisk = await si.fsStats();
  const disk = await sys.fsStats();
  assert.ok(Number.isFinite(disk.rx) && Number.isFinite(disk.wx), 'disk counters');
  if (siDisk) assert.ok(disk.rx >= siDisk.rx && disk.wx >= siDisk.wx, `disk ${disk.rx}/${disk.wx} vs si ${siDisk.rx}/${siDisk.wx}`);

  console.log(`sys-metrics: all checks passed (cpu ${load.currentLoad.toFixed(1)}%, temp ${temp.main}°C, iface ${net.primary})`);
})().catch(err => { console.error(err); process.exit(1); });
