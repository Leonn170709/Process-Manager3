'use strict';

// PM3 memory agent — opt-in, zero dependencies.
//
// One line in the host app:
//   const pm3 = require('pm3/agent').attach({ name: 'my-app' });
//   pm3.track('cache', () => cache);
//
// Reports { name, count, bytes? } per tracked structure and process.memoryUsage().
// It NEVER reports contents — tracked structures routinely hold tokens and user data.
//
// Outside PM3 (no IPC channel) attach() returns a fully working object whose methods
// are harmless: nothing is sent, no handle is created, the process exits normally.

const v8 = require('v8');

const KEY = '__pm3';

let attached = null;

// Entry count only — never the values themselves.
function _count(v) {
  if (v == null) return null;
  if (typeof v.size === 'number') return v.size;           // Map, Set
  if (typeof v.length === 'number') return v.length;       // Array, string, Buffer
  if (typeof v === 'object') return Object.keys(v).length; // plain object
  return null;
}

function attach(opts) {
  if (attached) return attached;
  opts = opts || {};

  const registry = new Map();
  const live = !!(process.send && process.channel);

  let loopDelay = null, gcCount = 0, gcMs = 0;
  if (live) {
    // Both of these are documented as not keeping the event loop alive; verified.
    try {
      const ph = require('perf_hooks');
      loopDelay = ph.monitorEventLoopDelay({ resolution: 20 });
      loopDelay.enable();
      const obs = new ph.PerformanceObserver(list => {
        for (const e of list.getEntries()) { gcCount++; gcMs += e.duration; }
      });
      obs.observe({ entryTypes: ['gc'] });
    } catch { loopDelay = null; }
  }

  function report(deepName) {
    const mem = process.memoryUsage();
    const tracked = [];
    for (const [name, getter] of registry) {
      let count = null;
      try { count = _count(getter()); } catch { count = null; }
      const row = { name, count };
      if (deepName === name) {
        // Allocates a buffer as large as the structure. On demand only, one at a time.
        try { row.bytes = v8.serialize(getter()).length; } catch { row.bytes = null; }
      }
      tracked.push(row);
    }
    let lagMs = null;
    if (loopDelay) { lagMs = loopDelay.mean / 1e6; loopDelay.reset(); }
    let handles = null;
    try { handles = process.getActiveResourcesInfo().length; } catch {}
    return {
      ts: Date.now(),
      name: opts.name || null,
      mem, tracked, handles,
      loopLagMs: Number.isFinite(lagMs) ? Math.round(lagMs * 100) / 100 : null,
      gc: { count: gcCount, totalMs: Math.round(gcMs) },
    };
  }

  const api = {
    enabled: live,
    // Register a GETTER, not a value: track('c', c) pins the object forever.
    track(name, getter) {
      if (typeof getter === 'function') registry.set(String(name), getter);
      return api;
    },
    untrack(name) { registry.delete(String(name)); return api; },
    report,                    // usable standalone too, for a health endpoint
    detach() {
      registry.clear();
      if (onMessage) process.removeListener('message', onMessage);
      attached = null;
    },
  };

  let onMessage = null;
  if (live) {
    onMessage = m => {
      if (!m || m[KEY] !== 'mem-request') return;   // ignore the host app's own IPC
      try { process.send({ [KEY]: 'mem', id: m.id, data: report(m.deep) }); } catch {}
    };
    process.on('message', onMessage);
    // A message listener refs the IPC channel and would stop the host app from ever
    // exiting. unref keeps delivery working while the app is alive but never holds it open.
    try { process.channel.unref(); } catch {}
    try { process.send({ [KEY]: 'hello', name: opts.name || null, pid: process.pid }); } catch {}
  }

  attached = api;
  return api;
}

module.exports = { attach };

// ponytail: no HTTP-push fallback. PM3 spawns every child with an IPC channel, so a
// process PM3 manages always has one; a process it does not manage is not on the
// dashboard to report to. Add HTTP when something outside PM3 needs to report in.
