# `pm3/agent` — in-process memory reporting

A tiny, zero-dependency module you add to your own app so PM3 can show **what its memory
is actually made of**: JS heap vs native, plus entry counts for structures you name.

It is a **no-op when the app is not running under PM3**, so it is safe to leave in
production code and safe to run the app standalone.

## Quick start — use `PM3_AGENT`

PM3 sets `PM3_AGENT` in every child's environment to the absolute path of this module.
Load it from there:

```js
const pm3 = process.env.PM3_AGENT
  ? require(process.env.PM3_AGENT).attach({ name: 'my-app' })
  : null;

pm3?.track('cache', () => cache);
```

That is the whole integration. No port is opened, no timer is started, nothing is sent
unless PM3 asks. Run the same file with plain `node app.js` and `pm3` is simply `null` —
the app behaves exactly as if the lines were not there.

### Why not `require('pm3/agent')`?

Because it breaks on the most common install. `npm install -g pm3` puts the **CLI** on your
`PATH`, but Node never searches the global `node_modules` root when resolving a
`require()`, so `require('pm3/agent')` throws `MODULE_NOT_FOUND` — and if you wrapped it in
a `try/catch`, your app would silently report nothing while looking perfectly healthy.

`PM3_AGENT` carries the resolved absolute path, so it works identically for a global
install, a local `node_modules` install, and `npm link`, with no per-project setup and no
hardcoded paths.

If `pm3` **is** a local dependency of your app and you want the module even when running
standalone, this variant also works — `PM3_AGENT` still wins when present:

```js
const pm3 = require(process.env.PM3_AGENT || 'pm3/agent').attach({ name: 'my-app' });
```

Only use that form when you are sure the bare specifier resolves; otherwise it throws
outside PM3.

---

## API

### `attach(options?) → agent`

Wires the agent up and returns the agent object. Calling it twice returns the same
instance (the second call's options are ignored).

| Parameter | Type | Meaning |
|---|---|---|
| `options.name` | `string` (optional) | A label echoed back in the report. Purely cosmetic; PM3 identifies processes by its own process name. |

**Returns** an object with `track`, `untrack`, `report`, `detach` and `enabled`.

**Failure mode:** none — `attach()` does not throw. With no IPC channel (i.e. not started
by PM3) it returns an agent with `enabled === false` whose `track()` calls are recorded
but never reported anywhere.

```js
const pm3 = require(process.env.PM3_AGENT).attach({ name: 'kitbot' });
console.log(pm3.enabled);   // true under PM3, false when run directly
```

### `agent.track(name, getter) → agent`

Registers a structure to report an entry count for. Returns the agent, so calls chain.

| Parameter | Type | Meaning |
|---|---|---|
| `name` | `string` | Label shown in the dashboard. Coerced with `String()`. |
| `getter` | `function` | Called on each report; must return the structure. |

**Failure mode:** a `getter` that is not a function is **silently ignored** — nothing is
registered. A getter that throws is caught per structure and reported as count `—`; it
never breaks the rest of the report.

```js
const sessions = new Map();
pm3.track('sessions', () => sessions).track('queue', () => queue);
```

### `agent.untrack(name) → agent`

Removes a registration. Unknown names are ignored.

### `agent.report(deepName?) → object`

Builds a report immediately and returns it. PM3 calls this for you; call it yourself only
if you want the same numbers for your own health endpoint. Works even when `enabled` is
`false`.

| Parameter | Type | Meaning |
|---|---|---|
| `deepName` | `string` (optional) | Also compute `bytes` for this one tracked structure via `v8.serialize`. See the warning below. |

```js
app.get('/health', (req, res) => res.json(pm3.report()));
```

**Failure mode:** never throws. `v8.serialize` failures (functions, unsupported types) set
that structure's `bytes` to `null` rather than failing the report. A getter that throws
gives that structure `count: null` and leaves the rest of the report intact.

In a standalone run (`enabled === false`) the `mem` and `tracked` numbers are still real,
but `loopLagMs` is `null` and the `gc` counters stay at zero — that instrumentation is only
started when PM3 is actually listening, so a standalone app pays nothing for it.

### `agent.detach()`

Clears the registry and removes the IPC listener. Rarely needed — the agent holds nothing
open.

### `agent.enabled`

`true` when the agent is talking to PM3, `false` when the app was started outside it.

---

## Three rules you can get wrong

### 1. Register a getter, not the value

```js
pm3.track('cache', () => cache);   // ✅ correct — reads the current value each time
pm3.track('cache', cache);         // ❌ WRONG — ignored, and pins the object forever
```

The second form is ignored (it is not a function), which is the safe outcome: a stored
reference would keep the structure alive forever and turn a diagnostic into a leak. If you
reassign the variable (`cache = new Map()`), only the getter form follows it.

### 2. Deep size is manual, never on an interval

`bytes` comes from `v8.serialize(value).length`, which **allocates a buffer as large as the
data it measures**. Measuring a 200 MB structure briefly doubles its memory. PM3 exposes it
as a per-structure "Measure size" button, one structure at a time. Do not call
`report('name')` on a timer.

Entry **counts** are effectively free and are sampled on every report.

### 3. Contents are never reported, by design

The agent reports `{ name, count, bytes? }` and nothing else. No key samples, no "first 10
entries" preview, no type dumps. Tracked structures are exactly where secrets live —
session tokens, API keys, user identifiers — and a dashboard that rendered their contents
would be a credential leak, not a diagnostic. This is not configurable.

---

## What gets reported

`process.memoryUsage()` fields, as reported by the agent:

| Field | Meaning |
|---|---|
| `rss` | Resident set size — total physical memory the OS has given the process. |
| `heapTotal` | V8 heap **reserved**. Address space, not necessarily resident. |
| `heapUsed` | V8 heap live after the last GC. Rising steadily = a JS retention problem. |
| `external` | Native memory bound to JS objects — Buffers, typed arrays, some addons. |
| `arrayBuffers` | The `ArrayBuffer`/`Buffer` portion of `external`. |

Plus:

| Field | Meaning |
|---|---|
| `loopLagMs` | Mean event-loop delay since the previous report (`perf_hooks.monitorEventLoopDelay`). Rising lag = the loop is blocked. |
| `gc.count` / `gc.totalMs` | GCs observed and total pause time since the process started. Rising GC count with flat `heapUsed` is a **churn** signature: lots of short-lived garbage. |
| `handles` | Active handles/requests (`process.getActiveResourcesInfo()`). A steadily rising count is a handle leak. |
| `tracked[]` | Per registered structure: `{ name, count, bytes? }`. `bytes` only when explicitly measured. |
| `name`, `ts` | The label passed to `attach()`, and when the report was taken. |

**`native` is derived by PM3, not by the agent**, and comes in three tiers:

| Shown as | Meaning |
|---|---|
| `42 MB` | Exact: `rss - heapTotal - external`, valid because the reserved heap fits inside RSS. |
| `≤ 42 MB` | Upper bound: `heapTotal` exceeded RSS (V8 reserved more heap than is resident), so PM3 subtracts `heapUsed` instead. The true figure is lower. A `≤` is never decoration — do not read it as a measurement. |
| `n/a` | `external` alone exceeds RSS. No subtraction is meaningful, but the conclusion is: the memory is in **buffers/ArrayBuffers, not native addons**. |

A large `native` points at native addons or allocator fragmentation.

---

## What this cannot tell you

**It cannot see inside native memory.** If `sharp`/libvips, `canvas`/Cairo, `sqlite3` or any
other native addon is holding 300 MB, the agent can tell you that ~300 MB is native — and
nothing more. It cannot attribute those bytes to a library, a call site, or an object. No
JS-level tool can; a V8 heap snapshot cannot either.

So a report showing a small, healthy JS heap does **not** mean there is no memory problem.
It means the problem is not in the JS heap, and that heap snapshots would waste your time.

**It cannot find what you did not name.** The registry ranks only structures you called
`track()` on. It cannot surface a variable nobody registered. Use it for structures you
already suspect; use a heap snapshot when the split says the JS heap is large but every
registered structure is small.

---

## Without the agent

PM3 falls back to the Node inspector for any managed Node process: it sends `SIGUSR1`,
reads `process.memoryUsage()` over CDP, and closes the inspector again. That yields the
same five `memoryUsage` fields but **no** tracked structures, loop lag, or GC stats, and it
attaches a debugger to your process for a moment on each poll. Non-Node processes get RSS
only, labelled "heap detail unavailable".

The agent is preferred wherever you own the app's source: no debug port, no pause, richer
data.
