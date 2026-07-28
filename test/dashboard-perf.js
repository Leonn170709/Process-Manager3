#!/usr/bin/env node
// Guards the dashboard's idle-cost invariants. The dashboard once held a desktop
// GPU at ~50% while merely sitting open; these are the four properties that
// brought it to zero, each of which is one careless CSS line away from coming
// back. Run after touching dashboard/public/index.html.
//
//   node test/dashboard-perf.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '../dashboard/public/index.html'), 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
// Comments explain these rules at length and would match every pattern below.
// Dropping the `@media (...) {` preludes flattens the at-rules so every block
// below is matched against its real selector; the now-unbalanced closing brace
// is trimmed off the next selector by `selectorOf`.
const code = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
const selectorOf = s => s.trim().replace(/^[}\s]+/, '').replace(/\s+/g, ' ');

// 1. No `filter: blur()` anywhere. A blurred layer is re-rasterised whenever it
//    is transformed, and the original three animated blobs were the single
//    largest cost on the page.
const blurFilters = code.match(/(^|[^-\w])filter\s*:\s*[^;}]*blur\(/g) || [];
assert.strictEqual(blurFilters.length, 0,
  `filter:blur() found (${blurFilters.length}) — use a soft gradient, not a blurred layer`);

// 2. Exactly one rule may declare backdrop-filter, and it must be the modal
//    overlay, which is display:none until a modal opens and so costs nothing at
//    rest. Every other surface fakes glass with a translucent tint.
const bdBlocks = [];
for (const m of code.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const [, sel, body] = m;
  if (/(^|[^-])backdrop-filter\s*:/.test(body) && !/backdrop-filter\s*:\s*none/.test(body)) {
    bdBlocks.push(selectorOf(sel));
  }
}
assert.ok(bdBlocks.every(s => s.includes('.modal-overlay')),
  `backdrop-filter on non-overlay surfaces: ${bdBlocks.filter(s => !s.includes('.modal-overlay')).join(' | ')}`);

// 3. The overlay must actually be display:none when closed — that is what makes
//    its blur free, and it is the reason no JS-side "only render when open"
//    machinery is needed.
const overlayRule = code.match(/\.modal-overlay\s*\{([^}]*)\}/);
assert.ok(overlayRule && /display\s*:\s*none/.test(overlayRule[1]),
  '.modal-overlay must be display:none when closed');

// 4. An infinite animation never lets the compositor go idle. Measured, the cost
//    is per frame *produced* — not per element, not per pixel — so the only lever
//    is making fewer frames differ: every infinite animation must be stepped, so
//    the compositor can skip the frames in between. Smooth costs 15% GPU where
//    stepped costs 3%. Layer promotion does not help; do not swap steps() for
//    will-change and assume it is equivalent.
const infinite = [];
for (const m of code.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const decl = (m[2].match(/animation[^;}]*\binfinite\b[^;}]*/) || [])[0];
  if (decl) infinite.push({ sel: selectorOf(m[1]), decl });
}
const smooth = infinite.filter(a => !/\bsteps\(/.test(a.decl));
assert.strictEqual(smooth.length, 0,
  `infinite animation without steps() — costs ~5x the GPU: ${smooth.map(a => a.sel).join(' | ')}`);
assert.ok(infinite.length <= 6,
  `too many infinite animations (${infinite.length}): ${infinite.map(a => a.sel).join(' | ')}`);

// 5. The background wash is painted once. Anything animated underneath the app
//    re-triggers every composited surface above it.
const bgRule = code.match(/#bg\s*\{([^}]*)\}/);
assert.ok(bgRule, '#bg background layer missing');
assert.ok(!/animation/.test(bgRule[1]), '#bg must not animate — it sits under the whole app');

// 6. A hidden dashboard must cost the daemon nothing. The client has to *disconnect*
//    its socket rather than just ignore events, because the socket count is the only
//    signal the daemon has that anyone is watching — ignoring events client-side
//    would leave the daemon polling and broadcasting at full rate into the void.
//    Measured: daemon CPU 1.90% watched, 0.42% hidden, 0.40% with no client at all.
const js = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
assert.ok(/function _pauseLive\s*\(\)\s*\{[^}]*socket\.disconnect\(\)/.test(js),
  '_pauseLive must disconnect the socket, not merely stop rendering');
assert.ok(/function _resumeLive\s*\(\)\s*\{[^}]*socket\.connect\(\)/.test(js),
  '_resumeLive must reconnect the socket');
assert.ok(/visibilitychange[\s\S]{0,400}_pauseLive\(\)/.test(js),
  'visibilitychange must call _pauseLive when the page is hidden');
assert.ok(/_resumeLive\(\)/.test(js) && /loadInitialData\(\)/.test(js),
  'returning to the page must re-sync state that was missed while disconnected');

const daemon = fs.readFileSync(path.join(__dirname, '../daemon/index.js'), 'utf8');
assert.ok(/const _watched = \(\) => io\.engine\.clientsCount > 0/.test(daemon),
  'daemon lost its notion of whether anyone is watching');
// Each of the three dashboard-feeding loops must consult it.
const gated = (daemon.match(/!_watched\(\)/g) || []).length;
assert.ok(gated >= 3,
  `expected all 3 dashboard polling loops to check _watched(), found ${gated}`);

console.log(`ok - dashboard perf checks pass (${infinite.length} transient animations, ` +
            `${bdBlocks.length} overlay-only backdrop-filter rules, ${gated} watcher-gated loops)`);
