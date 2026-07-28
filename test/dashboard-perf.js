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

// 4. An infinite animation never lets the compositor go idle: the page keeps
//    producing frames forever. Only short-lived, at-most-one-on-screen
//    indicators may have one, and never the steady `running` state, which has
//    one instance per managed process.
const infinite = [];
for (const m of code.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  if (/animation[^;}]*\binfinite\b/.test(m[2])) infinite.push(selectorOf(m[1]));
}
assert.ok(!infinite.some(s => s.includes('.status-running')),
  '.status-running must not animate — one per running process, forever');
assert.ok(infinite.length <= 4,
  `too many infinite animations (${infinite.length}): ${infinite.join(' | ')}`);

// 5. The background wash is painted once. Anything animated underneath the app
//    re-triggers every composited surface above it.
const bgRule = code.match(/#bg\s*\{([^}]*)\}/);
assert.ok(bgRule, '#bg background layer missing');
assert.ok(!/animation/.test(bgRule[1]), '#bg must not animate — it sits under the whole app');

console.log(`ok - dashboard perf checks pass (${infinite.length} transient animations, ` +
            `${bdBlocks.length} overlay-only backdrop-filter rules)`);
