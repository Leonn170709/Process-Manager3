# PM3 — Memory Inspector Plan

Implementation plan for a per-process memory inspector: answer **"what is actually
using the RAM, down to the object or variable"** for any Node process PM3 manages.

Written against the tree at `core/processManager.js`, `daemon/index.js`,
`dashboard/public/index.html` as they exist today. All identifiers quoted below
were verified against the current source.

---

## 0. START HERE — scope for this implementation round

### Build exactly this

| # | Section | What |
|---|---|---|
| 1 | **§2 Phase 0** | Per-process memory split + rolling history |
| 2 | **§2 Phase 0b** | Opt-in agent `agent/pm3-agent.js` + named-structure registry |
| 3 | **§7** | Separate CPU from memory in the UI; enlarge the memory modal |
| 4 | **§9** | `agent/README.md` documenting the importable API |

### Do NOT build

**§3 Phase 1** (heap snapshot capture), **§4 Phase 2**, **§5 Phase 3**, **§6 Phase 4**.
Stop and report when the four items above are done. Phase 1 is worth doing next, but
only once Phase 0 has shown whether the memory is even in the JS heap.

### Constraints — all four apply

1. **Do not poll CDP or IPC on the dashboard's 2s `memModalTimer`** (guard at
   `dashboard/public/index.html` ~line 4021). Drive the UI from the daemon's existing
   `stats:update` broadcast; poll in-process detail daemon-side every 10–15 s.
2. **Never render a derived `native` from missing inputs.** When in-process detail is
   unavailable (non-Node child, no agent, inspector refused), show RSS with an
   explicit "heap detail unavailable" note. A plausible wrong number is worse than a
   blank.
3. **The agent must be a safe no-op outside PM3** — full requirements in §2 under
   "The agent must be a safe no-op outside PM3". This is what makes it safe to leave
   in production code.
4. **Report `{name, count, bytes}` only — never contents.** No previews, no key
   samples, no "first N entries", however useful it seems. Tracked structures
   routinely hold tokens and user data.

If you implement the SIGUSR1/CDP fallback, note it is a **remote-code-execution
surface**: loopback bind only, read the real port from `/json/list` rather than
assuming 9229, serialise sessions with a mutex, close immediately after each read.

### Verification — observe these, don't assume them

- `test/memory-leak.js` (JS growth → `heapUsed` climbs) and a Buffer-allocating script
  (`external` climbs, `heapUsed` flat) are **visibly distinguishable in the UI**. That
  distinction is the entire point of the feature.
- A tracked Map growing over time shows a rising count.
- A process **without** the agent still renders correctly via the fallback.
- **An instrumented app run as plain `node app.js`, outside PM3 entirely,** behaves
  identically to the uninstrumented version and still exits cleanly.

### Reporting

State what you implemented, what you verified and **how — actual observed output, not
assertions that it works** — and anything in this plan you disagreed with or could not
do.

---

## 1. The constraint that shapes the whole design

**A V8 heap snapshot only sees the JavaScript heap.** Native allocations —
`sharp`/libvips, `canvas`/Cairo, and any other native addon — are invisible to it,
as is glibc allocator fragmentation.

This is not a footnote. A real example: a bot showing **~600 MB RSS** was measured
to have only ~112 MB of library JS baseline, and its largest suspected JS structure
(a 4,000-entry Discord member cache) weighed **2.6 MB**. A snapshot viewer pointed
at that process would have shown a healthy, unremarkable heap and explained almost
nothing.

So the tool must answer questions **in this order**:

1. **Is the memory in the JS heap or outside it?** ← Phase 0. Cheap. Often ends the investigation.
2. If JS heap → *which objects?* ← Phases 1–3.
3. If native → snapshots cannot help; report the split honestly and point elsewhere.

Building Phase 1 before Phase 0 risks shipping a viewer that looks impressive and
answers the wrong question.

### The numbers that matter

From `process.memoryUsage()` inside the target process:

| Field | Meaning |
|---|---|
| `rss` | Total resident set. What `pidusage` already reports. |
| `heapTotal` | V8 heap reserved |
| `heapUsed` | V8 heap live after last GC |
| `external` | Native memory bound to JS objects (Buffers, etc.) |
| `arrayBuffers` | Subset of `external` |

Derived, and the single most valuable number in the whole feature:

```
native ≈ rss - heapTotal - external
```

Large `native` → native addons / allocator fragmentation. Large `heapTotal - heapUsed`
→ V8 sitting on slack it will not return (fixed only by `--max-old-space-size` at
launch). Large `heapUsed` → a genuine JS retention problem; go to Phase 1.

`pidusage` cannot produce any of these — it only sees RSS from the OS. They must come
from inside the process. See Phase 0 for how, without modifying the target app.

---

## 2. Phase 0 — Memory split panel

**Ship this first. It is roughly an afternoon of work and may make Phases 1–3 unnecessary.**

### Getting in-process numbers

Two transports. **B is better wherever you control the app's source** — richer data,
no RCE port, no pauses. **A is the fallback** for processes you cannot or do not want
to modify. Implement both; prefer B when the agent is present and fall back to A
automatically when it is not.

**A. Inspector / CDP (zero instrumentation)**

1. `process.kill(pid, 'SIGUSR1')` — Node opens its inspector on `127.0.0.1:9229`.
2. `GET http://127.0.0.1:9229/json/list` → grab `webSocketDebuggerUrl`.
3. Connect, `Runtime.evaluate` with `expression: "JSON.stringify(process.memoryUsage())"`.
4. Disconnect immediately.

Works on any Node child PM3 spawned, no cooperation required.

Caveats to handle:
- Port collision when several managed processes are inspected. Node increments from
  9229 but does not guarantee; read the actual port from `/json/list`, and serialise
  inspector sessions with a mutex so only one is open at a time.
- **`SIGUSR1` opens a remote code execution surface.** Bind loopback only, never
  expose it, and close the session as soon as the read completes. Non-negotiable.
- Not all runtimes honour `SIGUSR1` (Bun, Deno, non-Node children). Detect and
  degrade to RSS-only rather than erroring.

**B. Opt-in agent — `agent/pm3-agent.js` (preferred where you own the app)**

One line in the target app:

```js
require('pm3/agent').attach({ name: 'kitbot' });
```

PM3 spawns children with `child_process.spawn`, so give them an IPC channel
(`stdio: ['pipe','pipe','pipe','ipc']`) and have the agent reply to a
`pm3:mem-request` message. Request/response, not a timer — idle processes stay
idle, and PM3 controls the cadence. Fall back to an HTTP POST to the daemon when no
IPC channel exists.

This beats CDP on every axis that matters:

| | CDP (A) | Agent (B) |
|---|---|---|
| Opens an RCE port | **yes** | no |
| Pauses the target | briefly | no |
| `process.memoryUsage()` | yes | yes |
| `v8.getHeapSpaceStatistics()` per-space | awkward | trivial |
| GC frequency / pause time | no | yes |
| Event-loop lag | no | yes |
| **Named application structures** | **no** | **yes** |

**The named-structure registry is the reason to build this.** A heap snapshot can tell
you "82 MB of strings"; only the app can tell you *which of its own variables* those
belong to. Let the app register the things it cares about:

```js
const pm3 = require('pm3/agent').attach({ name: 'kitbot' });
pm3.track('verifiedPlayers', () => verifiedPlayers);
pm3.track('distances',       () => distances);
pm3.track('chunkCache',      () => chunkCache);
```

The agent then reports, per registered name:

- **Entry count** — `.size` for Map/Set, `.length` for arrays, `Object.keys().length`
  for plain objects. Effectively free, safe to sample every cycle, and usually the
  most actionable signal on its own: a collection that grows monotonically is a leak,
  regardless of its byte size.
- **Deep size, on demand only** — `v8.serialize(value).length` as a byte proxy.
  Never sample this automatically: it allocates a buffer as large as the data it
  measures, so a "measure everything" button on a 200 MB structure briefly doubles
  it. Manual trigger, one structure at a time, and say so in the UI. It also throws
  on values containing functions or unsupported types — catch per-structure and
  report `n/a` rather than failing the whole report.

Getters (`() => x`) rather than direct references, so the registry never itself
keeps a dead structure alive — that would turn the diagnostic into a leak.

**Names are supplied, not discovered.** The registry ranks only what the app
registered; it cannot surface a variable nobody called `track()` on. That is the
tradeoff against heap snapshots, which see everything but cannot name any of it.
The two are complements: use the registry for structures you already suspect, and a
snapshot when the split panel says the JS heap is large but every registered
structure is small.

**Never report contents — counts and sizes only.** Application state is exactly where
secrets live: tokens, API keys, user identifiers. A dashboard that renders the
*contents* of a tracked structure turns a diagnostic into a credential leak. The
agent must expose `{ name, count, bytes? }` and nothing else. No key samples, no
"first 10 entries" preview, no type-inference dumps. If an implementer is tempted to
add a preview for usability, the answer is no.

**The agent must be a safe no-op outside PM3.** Apps get started directly all the
time — during development, from a shell, under a different supervisor. If
`require('pm3/agent').attach()` throws, or hangs waiting for a daemon, or leaves an
open handle that stops the process exiting, it has broken the host application in
exchange for a diagnostic. Requirements:

- No IPC channel and no reachable daemon → `attach()` returns a working object whose
  methods do nothing. No throw, no warning spam, at most one line at debug level.
- `track()` on a no-op instance is still callable and still cheap.
- Any timer or handle the agent creates is `unref()`'d, so it never keeps the event
  loop alive.
- Zero runtime dependencies. This module gets imported into other people's processes;
  it must not drag a tree in with it.
- Never install `process.on('uncaughtException')` or otherwise alter host error
  handling.

Also cheap and worth including: `perf_hooks.monitorEventLoopDelay()` for loop lag, a
`PerformanceObserver` on `'gc'` entries for collection frequency and pause time, and
`process.getActiveResourcesInfo()` for handle counts. Rising GC frequency with flat
`heapUsed` is a churn signature — exactly the pattern a periodic image-render job
produces, and one the split panel alone will not reveal.

**Hard ceiling, state it in the UI:** the agent still cannot see *inside* native
memory. It can report that `native` is 300 MB; it cannot attribute that to libvips
versus Cairo versus fragmentation. No JS-level tool can. Do not let the richer data
imply otherwise.

### Backend

- `core/processManager.js` — extend the existing `pidusage` loop (~line 411, which
  currently sets `procs[name].cpu` and `procs[name].memory`) to also carry a
  `memDetail` object per process, refreshed on a **slower** cadence than the CPU
  poll (every 10–15 s is plenty; the CDP round-trip is far more expensive than
  `pidusage`).
- `daemon/index.js` — add `GET /api/processes/:name/memory` returning the split, and
  include `memDetail` in the existing `stats:update` Socket.IO broadcast (line ~86)
  so the dashboard updates live without extra polling.
- Persist a rolling history (last ~1 h) so the modal can chart `heapUsed` vs `native`
  over time — a native leak and a JS leak look completely different on that chart,
  which is the whole point. Follow the existing `storage/index.js` JSON patterns;
  keep it in memory with periodic flush, do not write every sample.

### Acceptance

For a managed Node process, the dashboard shows rss / heapTotal / heapUsed / external
/ arrayBuffers / derived native, updating live, with a stacked chart over time. Verify
against `test/memory-leak.js` (JS growth → `heapUsed` climbs) and a native-allocation
script (Buffers → `external` climbs, `heapUsed` flat).

---

## 3. Phase 1 — Heap snapshot capture

**Value is high and complexity is low, because Chrome DevTools does the analysis.**

Reuse the Phase 0 CDP connection:

1. `HeapProfiler.enable`
2. `HeapProfiler.takeHeapSnapshot` with `reportProgress: true`
3. Snapshot arrives as many `HeapProfiler.addHeapSnapshotChunk` events — **stream them
   straight to disk**, never concatenate in the daemon's own memory. A 200 MB heap
   produces a file of comparable or larger size; buffering it would make PM3 itself
   the memory problem.
4. Write to `~/.pm3/snapshots/<process>-<ISO timestamp>.heapsnapshot`
5. `HeapProfiler.disable`, close the socket.

### Security — heap snapshots contain secrets in plaintext

**A `.heapsnapshot` includes the contents of every live string in the process.** That
means bot tokens, API keys, passwords, session cookies, database URLs and personal
user data, all readable with a text editor. A snapshot of a Discord bot hands over
its token to anyone holding the file.

Consequences the implementation must respect:

- Store under `~/.pm3/snapshots/` with mode `0600`, directory `0700`.
- Serve downloads only over loopback, behind whatever auth the dashboard already
  requires. Never expose the snapshot directory as static files.
- Put a plain-language warning next to the download button — *"contains tokens and
  user data in plaintext; treat as a credential"* — not buried in docs.
- Never auto-upload, auto-share, or include snapshots in any diagnostic bundle.
- Default retention should be short, and deletion genuinely unlinks the file.

This applies to snapshots only. The Phase 0b agent reports counts and sizes and
carries none of this risk — another reason to prefer it for routine use and keep
snapshots as the deliberate, occasional tool.

### UI

A **Take heap snapshot** button in the memory modal, a list of existing snapshots with
size and age, a download link, and a delete action. Retention: cap count and/or total
bytes (default ~5 per process), prune oldest — these files are large and will fill a
disk unattended.

### Warn the user in the UI, at the moment they click

- The target process **pauses** for the duration — roughly 1–3 s for a 200 MB heap,
  longer for bigger ones. For a latency-sensitive process (a game bot, a live service)
  this is a visible stall.
- Taking a snapshot **forces a full GC** first. RSS may legitimately drop afterwards;
  that is not a bug and is itself a useful signal.
- **Never put this on a timer.** Manual trigger only.

### Acceptance

Downloaded file opens in Chrome DevTools → Memory → Load, and shows a sane object
graph. At that point the feature is already fully useful even with zero parsing in PM3.

---

## 4. Phase 2 — In-dashboard summary

Parse the `.heapsnapshot` and render DevTools' "Summary" view inline, so common cases
never require leaving the browser.

Format: JSON with `snapshot.meta` describing the field layout, plus flat `nodes` and
`edges` integer arrays and a `strings` table. Read `meta.node_fields` /
`meta.node_types` and decode by offset — **do not hardcode field positions**, the
layout varies by V8 version.

Deliverable: group nodes by constructor name, sum `self_size`, count instances. Render
a sortable top-N table:

```
string      82.4 MB   412,033 objects
Array       40.1 MB    88,204
Object      31.7 MB   201,455
Map          12.3 MB     3,201
```

This is a straightforward group-by — no graph algorithms — and already identifies
most runaway structures.

Parse in a **worker thread or child process**, not the daemon's main thread. These
files are hundreds of MB and `JSON.parse` on one will block the event loop for
seconds, freezing every dashboard socket. Stream-parse if practical.

---

## 5. Phase 3 — Retained size and "which variable" (optional)

Only worth building if Phase 0 shows the JS heap is genuinely where the memory is.

Self size ≠ retained size. To say *"`distances` is holding 40 MB"* you need the
**dominator tree** over the snapshot graph (Lengauer–Tarjan), then walk named edges
from the global object and module scopes to attribute retained bytes to identifiers.

This is the genuinely hard part — a correct, fast dominator implementation over
millions of nodes is a real project. Strongly prefer an existing snapshot-parsing
library over writing it fresh. If none fits, Phase 2 plus a DevTools download covers
the great majority of real investigations; stop there without embarrassment.

---

## 6. Phase 4 — Allocation sampling (optional, often better)

CDP `HeapProfiler.startSampling` / `stopSampling` gives a low-overhead continuous
profile of **which code allocates most**, rather than what is alive right now.

For churn-driven RSS — e.g. a job that renders a large image every few minutes and
discards it — this is far more informative than any snapshot, because the garbage is
gone by the time a snapshot runs. Sampling is cheap enough to leave on. Render as a
flame graph or a top-N-by-allocation-site table.

---

## 7. UI — separate CPU from memory

### The bug to fix

`openMemModal()` (`dashboard/public/index.html`, ~line 2928) builds a body via
`_buildMemModal()` (~2942) whose **"Processes by RAM"** rows render CPU as the row
subtitle:

```js
<div class="rp-sub">${p.cpu}% CPU</div>
```

CPU has no business in the memory view, and that subtitle line is exactly the space
the memory breakdown should occupy.

### Required changes

1. **Strip all CPU from the memory modal.** Replace each `rp-sub` CPU subtitle with
   the process's memory split — at minimum `heap / native`, e.g. `heap 84 MB · native 310 MB`.
   Fall back to `— MB RSS` when in-process detail is unavailable (non-Node child,
   inspector refused).
2. **Keep the two modals strictly disjoint.** `cpu-modal` (~line 1064, opened by
   `openCpuModal()` at ~2598) owns load average and per-core data. `mem-modal`
   (~line 1075) owns everything in this document. Neither shows the other's metric.
   The System-tab cards at lines ~811 and ~819 already open separate modals — keep it
   that way and do not merge them.
3. **Enlarge the memory modal.** `.res-modal` is `width:900px` (line ~359), too narrow
   for the split chart plus the per-process table plus snapshot controls. Add a
   dedicated wider class (~`1200px`, `max-height:90vh`) for `mem-modal` only; leave
   `.res-modal` alone so the drive/interface/runtime modals are unaffected.
4. **Layout inside the enlarged memory modal**, top to bottom:
   - Stacked history chart: `heapUsed` / `external` / `native`, 3-min window, matching
     the existing `mm-mem-*` chart conventions
   - Split summary row: rss · heapTotal · heapUsed · external · arrayBuffers · native
   - System memory layout (existing `mm-layout-section`, unchanged)
   - **Processes by RAM** — memory-only subtitles per point 1
   - Expanding a process row reveals its own split, plus snapshot controls and
     snapshot list for that process
5. **Respect the existing refresh pattern.** `memModalTimer` ticks `_tickMemModal()`
   every 2 s (see the guard at ~line 4021). The Phase 0 CDP read is far too expensive
   for a 2 s cadence — drive the chart from the daemon's `stats:update` broadcast and
   let the daemon poll in-process detail on its own slower schedule.
6. **Degrade honestly.** When in-process detail is unavailable, show RSS with an
   explicit "heap detail unavailable — not a Node process, or inspector unavailable"
   note. Never render a derived `native` figure from missing inputs; a plausible wrong
   number is worse than a blank.

---

## 8. Build order

| Phase | Deliverable | Effort | Value |
|---|---|---|---|
| 0 | Memory split panel + history | Low | **Highest — do first** |
| 0b | Opt-in agent + named-structure registry | Low–Medium | **Highest for apps you own** |
| 7 | CPU/memory UI separation + enlarge | Low | High (asked for) |
| 1 | Snapshot capture + download | Medium | High |
| 2 | In-dashboard summary table | Medium | Medium |
| 4 | Allocation sampling | Medium | Medium–High for churn |
| 3 | Dominator tree / retained size | **High** | Situational |

Phases 0 and 7 together already answer *"is it JS or native, and which process"* for
every managed process. That is the majority of the practical value.

---

## 9. Required deliverable — `agent/README.md`

Anything in `agent/pm3-agent.js` that an application can import is **public API**, and
it will be pasted into other people's processes. It must ship with its own
documentation, written for someone who has never read this plan and only wants to
instrument their app.

Write `agent/README.md` covering:

**Every exported function**, and only what actually exists when the work is done — no
aspirational entries. For each: signature, parameter types, return value, a runnable
example, and its failure mode.

**A quick-start** that is genuinely copy-pasteable:

```js
const pm3 = require('pm3/agent').attach({ name: 'my-app' });
pm3.track('cache', () => cache);
```

**The rules a caller can get wrong**, stated where they will be read rather than
buried:

- Register **getters**, not values. `track('cache', cache)` pins the object forever;
  `track('cache', () => cache)` does not. Show both, mark one wrong.
- Deep size (`v8.serialize`) allocates a buffer as large as the structure it measures.
  Manual trigger only; never on an interval.
- Counts and sizes are reported — **contents never are**, by design. Say why: tracked
  structures routinely hold tokens and user data.
- The module is a no-op outside PM3, so it is safe to leave in production code and
  safe to run the app standalone.

**A "what this cannot tell you" section.** Native memory from addons like `sharp`,
`canvas` or `sqlite3` is invisible to it — the agent can report that `native` is large
but never what is inside it. Readers will otherwise assume a clean report means no
memory problem.

**A table of every reported field** (`rss`, `heapTotal`, `heapUsed`, `external`,
`arrayBuffers`, derived `native`, loop lag, GC stats, per-structure counts) with a
one-line meaning for each, so the dashboard's numbers can be interpreted without
guessing.

Keep it in `agent/README.md` next to the code, and link it from the main `README.md`.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Snapshots contain tokens/user data in plaintext** | `0600` files in a `0700` dir; loopback + authed download only; explicit warning at the download button; short retention; never auto-share |
| **Tracked-structure contents leak secrets** | Agent reports `{name, count, bytes}` only — no previews, no key samples, ever |
| `SIGUSR1` opens an RCE port | Loopback bind only; close immediately after use; never expose; document clearly |
| Snapshot pauses the target process | Manual trigger only, never scheduled; warn in the UI at click time |
| Snapshot files fill the disk | Retention cap per process; prune oldest; show sizes in the UI |
| Parsing a huge snapshot freezes the daemon | Parse in a worker thread or child process; stream if practical |
| Inspector port collisions | Read the real port from `/json/list`; serialise sessions with a mutex |
| Non-Node children | Feature-detect; degrade to RSS-only with an explicit UI note |
| Snapshot ≠ RSS, confusing users | Always show the Phase 0 split alongside; state plainly that snapshots exclude native memory |
