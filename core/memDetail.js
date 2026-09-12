'use strict';

// Per-process memory split (Phase 0).
//
// pidusage only sees RSS. rss / heapTotal / heapUsed / external / arrayBuffers have to
// come from inside the process. Two transports:
//
//   B (preferred) — the opt-in agent replies to a `pm3:mem-request` over the IPC channel.
//                   No port, no pause, and it can name the app's own structures.
//   A (fallback)  — SIGUSR1 opens the child's inspector; one Runtime.evaluate reads
//                   process.memoryUsage(). Node children only: SIGUSR1's default
//                   disposition is *terminate*, so sending it to a python/bash child
//                   would kill it.
//
// Polled on its own slow schedule (12 s), never on the dashboard's 2 s tick.

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../config/constants');
const storage = require('../storage');

const POLL_MS = 12000;
const HISTORY_MAX = 300;               // ~1 h at 12 s
const FLUSH_MS = 5 * 60 * 1000;
const HISTORY_FILE = path.join(PATHS.home, 'mem-history.json');

// Node >= 22 has a global WebSocket; ws is present as a socket.io dependency on older ones.
const WS = globalThis.WebSocket || (() => {
  try { return require('ws'); } catch { return null; }
})();

const state = {};      // name -> { agent, wsUrl, sigusr1Sent, pending, msgId }
const detail = {};     // name -> last sample (or { error })
const history = {};    // name -> [{ t, rss, heapTotal, heapUsed, external, arrayBuffers, native }]
let historyDirty = false;

try {
  const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  if (saved && typeof saved === 'object') Object.assign(history, saved);
} catch {}

function _st(name) {
  if (!state[name]) state[name] = {
    agent: false, wsUrl: null, sigusr1Sent: false, pending: new Map(), msgId: 0,
    // Last measured deep size per structure, { [name]: { bytes, ts } }. Deep size is a
    // manual, point-in-time reading; without keeping it, the next 12 s poll would wipe it
    // and there would be nothing left to sort by size on.
    bytes: {},
  };
  return state[name];
}

function forget(name) {
  delete state[name];
  delete detail[name];
  // history is kept: a crashed process's last hour is exactly what you want to look at
}

function rename(oldName, newName) {
  if (state[oldName])   { state[newName]   = state[oldName];   delete state[oldName]; }
  if (detail[oldName])  { detail[newName]  = detail[oldName];  delete detail[oldName]; }
  if (history[oldName]) { history[newName] = history[oldName]; delete history[oldName]; }
}

// --- Transport B: the agent -------------------------------------------------

// Called from the child's `message` handler in processManager.
function onAgentMessage(name, msg) {
  if (!msg || typeof msg !== 'object') return false;
  const kind = msg.__pm3;
  if (kind === 'hello') { _st(name).agent = true; return true; }
  if (kind === 'mem') {
    const st = _st(name);
    st.agent = true;
    const resolve = st.pending.get(msg.id);
    if (resolve) { st.pending.delete(msg.id); resolve(msg.data); }
    return true;
  }
  return false;
}

function _askAgent(name, child, deep, timeoutMs = 3000) {
  return new Promise(resolve => {
    const st = _st(name);
    const id = ++st.msgId;
    const timer = setTimeout(() => { st.pending.delete(id); resolve(null); }, timeoutMs);
    st.pending.set(id, data => { clearTimeout(timer); resolve(data); });
    try {
      child.send({ __pm3: 'mem-request', id, deep: deep || undefined });
    } catch {
      clearTimeout(timer); st.pending.delete(id); resolve(null);
    }
  });
}

// --- Transport A: SIGUSR1 + inspector ---------------------------------------

// Lines Node itself prints when the inspector opens/closes. PM3 provoked them, the app
// did not, so they are filtered out of the app's error log instead of being shown as
// output it never produced.
const INSPECTOR_NOISE = /^(Debugger (listening on|attached|ending on)|For help, see: https:\/\/nodejs\.org|Starting inspector on .* failed)/;
function isInspectorNoise(line) { return INSPECTOR_NOISE.test(line.trim()); }

// The child prints `Debugger listening on ws://127.0.0.1:<port>/<uuid>` to stderr after
// SIGUSR1. Reading it there gives the real port for *this* pid — no scanning, no guessing
// which of several inspectors on 9229+ belongs to which process.
function noteStderr(name, text) {
  const m = text.match(/ws:\/\/127\.0\.0\.1:\d+\/[0-9a-fA-F-]+/);
  if (m) _st(name).wsUrl = m[0];
  // Measured: a second process's SIGUSR1 does NOT fall forward to 9230 — it just fails.
  // Hence close-after-read below, so the port is free for the next process.
  if (/Starting inspector on .* failed/.test(text)) _st(name).portBusy = true;
}

// Only one inspector session open at a time.
let _chain = Promise.resolve();
function _serial(fn) {
  const run = () => fn();
  _chain = _chain.then(run, run);
  return _chain;
}

function _isNodeChild(cfg) {
  const cmd = (cfg && cfg.cmd) || '';
  return cmd === process.execPath || /(^|\/)node(js)?$/.test(cmd);
}

function _cdpEvaluate(wsUrl, expression, timeoutMs = 4000) {
  return new Promise(resolve => {
    if (!WS) return resolve(null);
    let ws, done = false;
    const finish = v => {
      if (done) return;
      done = true;
      // Drop the session the moment the read completes; the caller then closes the
      // inspector itself, so the port is only listening for the duration of one read.
      try { ws.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { ws = new WS(wsUrl); } catch { clearTimeout(timer); return resolve(null); }
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({
          id: 1, method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }));
      } catch { clearTimeout(timer); finish(null); }
    };
    ws.onmessage = ev => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        finish(msg?.result?.result?.value ?? null);
      } catch { finish(null); }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
  });
}

// Closing from inside is the only way to shut the port again — CDP has no command for it.
// `require` is not defined in the inspector's evaluation context and `process.mainModule`
// is undefined for an ESM entry point, so prefer process.getBuiltinModule (Node >= 22.3),
// which works in both CJS and ESM. The rest is the fallback chain for older Node.
const CLOSE_EXPR = `(function(){try{(
  typeof process.getBuiltinModule==="function" ? process.getBuiltinModule("inspector")
: typeof require==="function"                  ? require("inspector")
: process.mainModule.require("inspector")
).close()}catch(e){}})()`;

function _waitForUrl(st, ms) {
  return new Promise(resolve => {
    const deadline = Date.now() + ms;
    (function check() {
      if (st.wsUrl || st.portBusy || Date.now() > deadline) return resolve(st.wsUrl);
      setTimeout(check, 100);
    })();
  });
}

async function _askCdp(name, child, cfg) {
  const st = _st(name);
  if (!_isNodeChild(cfg)) return { error: 'not a Node process' };
  if (!WS) return { error: 'no WebSocket client available' };

  // One turn at a time: only one process can hold the inspector port, and each turn
  // opens it, reads, and closes it again — so the RCE surface exists for ~100 ms per
  // read rather than for the life of the process.
  return _serial(async () => {
    st.wsUrl = null; st.portBusy = false;
    try { process.kill(child.pid, 'SIGUSR1'); } catch { return { error: 'inspector unavailable' }; }

    const url = await _waitForUrl(st, 2000);
    if (!url) return { error: st.portBusy ? 'inspector port busy' : 'inspector unavailable' };

    const raw = await _cdpEvaluate(url, 'JSON.stringify(process.memoryUsage())');
    await _cdpEvaluate(url, CLOSE_EXPR, 1000);   // free the port for the next process
    st.wsUrl = null;

    if (!raw) return { error: 'inspector unavailable' };
    try { return { mem: JSON.parse(raw) }; } catch { return { error: 'inspector unavailable' }; }
  });
}

// --- Polling ----------------------------------------------------------------

function _sample(name, source, r) {
  const m = r.mem;
  const ext = m.external || 0;
  // native memory, in three tiers of confidence.
  //
  // `rss - heapTotal - external` is exact only when the whole reserved heap is resident.
  // heapTotal is *reserved* address space, so on a heap-heavy process it exceeds RSS and
  // the subtraction goes negative (measured: 7/19 samples on a JS-leak process).
  // Substituting heapUsed — the part of the heap that is definitely live — subtracts less
  // and yields a conservative UPPER BOUND, which covered every such sample (0/19 negative).
  //
  // When `external` alone exceeds RSS neither works, because external counts Buffer bytes
  // that need not be resident. That is not a failure to answer: it means the memory is in
  // buffers, not in native addons, which is exactly what Phase 0 is asked to determine.
  const exact = m.rss - m.heapTotal - ext;
  const upper = m.rss - m.heapUsed - ext;
  let native, nativeBound, nativeNote;
  if (exact >= 0) {
    native = exact; nativeBound = 'exact'; nativeNote = null;
  } else if (upper >= 0) {
    native = upper; nativeBound = 'upper';
    nativeNote = 'upper bound — V8 has reserved more heap than is resident, so the true figure is lower';
  } else {
    native = null; nativeBound = null;
    nativeNote = 'external alone exceeds RSS — this memory is in buffers/ArrayBuffers, not in native addons';
  }
  // Carry previously measured deep sizes forward, tagged with when they were taken —
  // a size from five minutes ago is still useful, but it must not pose as live data.
  // A structure the serializer refuses is remembered the same way: the reason is a property
  // of what it holds, so it stays true until the app changes, and the UI should keep saying
  // so rather than showing an empty cell one poll later.
  const seen = _st(name).bytes;
  const tracked = r.tracked ? r.tracked.map(t => {
    if (t.bytes != null) { seen[t.name] = { bytes: t.bytes, ts: Date.now() }; return t; }
    if (t.bytesError) { seen[t.name] = { error: t.bytesError, ts: Date.now() }; return t; }
    const prev = seen[t.name];
    if (!prev) return t;
    return prev.error ? { ...t, bytesError: prev.error } : { ...t, bytes: prev.bytes, bytesAt: prev.ts };
  }) : null;

  const d = {
    source, ts: r.ts || Date.now(),
    rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed,
    external: m.external || 0, arrayBuffers: m.arrayBuffers || 0,
    native, nativeBound, nativeNote,
    tracked,
    loopLagMs: r.loopLagMs ?? null,
    gc: r.gc || null,
    handles: r.handles ?? null,
  };
  detail[name] = d;
  const h = history[name] || (history[name] = []);
  h.push({ t: d.ts, rss: d.rss, heapTotal: d.heapTotal, heapUsed: d.heapUsed, external: d.external, arrayBuffers: d.arrayBuffers, native });
  if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
  historyDirty = true;
  return d;
}

async function pollOne(name, runtimeEntry) {
  const child = runtimeEntry && runtimeEntry.proc;
  if (!child || !child.pid || child.exitCode !== null) return null;
  const st = _st(name);

  if (st.agent) {
    const data = await _askAgent(name, child);
    if (data && data.mem) return _sample(name, 'agent', data);
    st.agent = false;   // agent went away (app restarted without it) — fall back
  }

  const res = await _askCdp(name, child, runtimeEntry.config);
  if (res.mem) return _sample(name, 'cdp', res);
  detail[name] = { source: null, error: res.error, ts: Date.now() };
  return null;
}

function pollAll(runtime) {
  return Promise.all(Object.entries(runtime).map(([name, r]) =>
    pollOne(name, r).catch(() => null)));
}

async function deepSize(name, runtimeEntry, structure) {
  const st = _st(name);
  if (!st.agent) return { error: 'deep size needs the pm3 agent' };
  const data = await _askAgent(name, runtimeEntry.proc, structure, 30000);
  if (!data) return { error: 'no reply from agent' };
  _sample(name, 'agent', data);
  const row = (data.tracked || []).find(t => t.name === structure);
  return row || { error: 'structure not tracked' };
}

// Deleted for good, unlike crashed: no process is left to look at this history under.
function drop(name) {
  forget(name);
  if (history[name]) { delete history[name]; historyDirty = true; }
}

// Keep it in memory, flush occasionally — a sample every 12 s is not worth a write each time.
// The daemon also calls this on shutdown so a restart does not lose the last few minutes.
function flush() {
  if (!historyDirty) return;
  historyDirty = false;
  try { storage.writeFileAtomic(HISTORY_FILE, JSON.stringify(history)); } catch {}
}
setInterval(flush, FLUSH_MS).unref();

module.exports = {
  POLL_MS,
  pollAll, pollOne, deepSize, flush,
  onAgentMessage, noteStderr, isInspectorNoise, forget, rename, drop,
  get: name => detail[name] || null,
  getHistory: name => history[name] || [],
  all: () => detail,
};
