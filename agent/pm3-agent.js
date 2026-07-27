'use strict';

// PM3 agent - opt-in, zero dependencies.
//
// One line in the host app:
//   const pm3 = require('pm3/agent').attach({ name: 'my-app' });
//   pm3.track('cache', () => cache);
//   await pm3.stop();            // ask PM3 to stop this process, for good
//
// Reports { name, count, bytes? } per tracked structure and process.memoryUsage().
// It NEVER reports contents - tracked structures routinely hold tokens and user data.
//
// Outside PM3 (no IPC channel) attach() returns a fully working object whose methods
// are harmless: nothing is sent, no handle is created, the process exits normally.
// The one exception is stop()/restart(), which cannot silently pretend to have worked:
// they resolve to { ok: false } so the caller can tell the difference and react.

const v8 = require('v8');

const KEY = '__pm3';

let attached = null;

// Entry count only - never the values themselves.
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
        // Structured clone refuses functions, so anything holding one as an own property
        // cannot be sized at all - a Map of pending Timeouts (each keeps its callback) or
        // a class instance referencing a logger. That is not a failure to report as a bare
        // null: keep the reason so the dashboard can say which structure and why.
        try { row.bytes = v8.serialize(getter()).length; }
        catch (err) {
          row.bytes = null;
          row.bytesError = String(err && err.message || err).split('\n')[0].slice(0, 120);
        }
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

  // Control requests (stop/restart) waiting on the daemon's ack, by request id.
  const pending = new Map();
  let msgId = 0;

  // Ask PM3 to act on a process. A null target means "the process making the call":
  // the daemon already knows which child sent the message, so the app never has to
  // name itself and cannot mistakenly act on a process it is not.
  function control(action, target, extra) {
    if (!live) {
      return Promise.resolve({ ok: false, error: 'not running under PM3' });
    }
    return new Promise(resolve => {
      const id = ++msgId;
      // If this fires we are demonstrably still alive well after asking to be stopped,
      // so the request did not take effect - that is a failure, not a slow success.
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'no response from the PM3 daemon' });
      }, 5000);
      pending.set(id, res => { clearTimeout(timer); resolve(res); });
      try {
        process.send({ [KEY]: 'control', id, action, target: target || null, ...extra });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, error: String(err && err.message || err).split('\n')[0] });
      }
    });
  }

  // stop(opts) and stop(name, opts) are both valid - stopping yourself is the common
  // case, so the name is what gets omitted.
  function _args(target, options) {
    if (target && typeof target === 'object') return { target: null, options: target };
    return { target: target || null, options: options || {} };
  }

  const api = {
    enabled: live,
    // The name PM3 knows this process by, or null outside PM3. Handy for log lines
    // and confirmation messages; PM3 does not need you to pass it back.
    name: process.env.PM3_NAME || null,
    // Register a GETTER, not a value: track('c', c) pins the object forever.
    track(name, getter) {
      if (typeof getter === 'function') registry.set(String(name), getter);
      return api;
    },
    untrack(name) { registry.delete(String(name)); return api; },
    report,                    // usable standalone too, for a health endpoint
    // Stop a process and leave it stopped. PM3 does not restart a process it was told
    // to stop, and does not resurrect one on daemon start, so this survives on its own;
    // { disableAutorestart: true } additionally clears the saved autorestart flag for
    // the paranoid case, and that change outlives the stop.
    stop(target, options) {
      const a = _args(target, options);
      return control('stop', a.target, { disableAutorestart: !!a.options.disableAutorestart });
    },
    restart(target) {
      return control('restart', _args(target).target, {});
    },
    detach() {
      registry.clear();
      for (const resolve of pending.values()) resolve({ ok: false, error: 'agent detached' });
      pending.clear();
      if (onMessage) process.removeListener('message', onMessage);
      attached = null;
    },
  };

  let onMessage = null;
  if (live) {
    onMessage = m => {
      if (!m || typeof m !== 'object') return;      // ignore the host app's own IPC
      if (m[KEY] === 'mem-request') {
        try { process.send({ [KEY]: 'mem', id: m.id, data: report(m.deep) }); } catch {}
        return;
      }
      if (m[KEY] === 'control-ack') {
        const resolve = pending.get(m.id);
        // A stop ack usually loses the race with its own SIGTERM. That is fine: the
        // process is gone, so nothing is left to resolve. Only a survivor gets here.
        if (resolve) { pending.delete(m.id); resolve({ ok: !!m.ok, error: m.error, action: m.action, name: m.name }); }
      }
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
