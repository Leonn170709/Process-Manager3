// Checks the memory-modal rendering rules that are easy to break:
//  - the stacked split chart really stacks (bands are cumulative, none escape the plot)
//  - "Processes by RAM" subtitles carry memory, never CPU
//  - a process with no in-process detail degrades to RSS + an explicit note, and never
//    shows a derived `native`
// Run: node test/mem-ui.js   (optionally against a live daemon: PM3_PORT=4926 node test/mem-ui.js)
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'public', 'index.html'), 'utf8');

// Pull one `function name(...) {...}` out of the page by brace matching.
function grab(name) {
  const i = html.indexOf(`function ${name}(`);
  assert(i > 0, `could not find function ${name}`);
  let depth = 0, started = false;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') { depth++; started = true; }
    else if (html[j] === '}') { depth--; if (started && depth === 0) return html.slice(i, j + 1); }
  }
  throw new Error(`unterminated ${name}`);
}

const chartSrc = html.slice(html.indexOf('// ── SVG sparkline chart'), html.indexOf('// ── Stats modal'));
const sandbox = {};
new Function('exports', chartSrc + '\nObject.assign(exports,{renderStackedChart,_chartSampleX,CHART_CW});')(sandbox);
const { renderStackedChart } = sandbox;

const ui = {};
new Function('exports', `
  const escapeHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const _mb = b => (b == null || !Number.isFinite(b)) ? null : Math.round(b / 1048576);
  function _mbTxt(b) { const v = _mb(b); return v == null ? '—' : v + ' MB'; }
  ${grab('memSubtitle')}
  ${grab('_memSplitDetailHtml')}
  Object.assign(exports, { memSubtitle, _memSplitDetailHtml });
`)(ui);

const MB = n => n * 1048576;

// --- 1. stacked chart: bands are cumulative and stay inside the plot band ------------
{
  const series = [
    { label: 'heapUsed', color: 'red',   values: [10, 20, 30, 40] },
    { label: 'external', color: 'green', values: [5, 5, 5, 5] },
    { label: 'native',   color: 'blue',  values: [20, 20, 20, 20] },
  ];
  const svg = renderStackedChart(series, 'test', 84);
  const H = 84, PAD_T = 6, PAD_B = 6;
  // Every y in every path — anchors and bezier control points alike.
  const ys = [...svg.matchAll(/d="([^"]+)"/g)
    .map(m => m[1])].flatMap(d => [...d.matchAll(/[ML]\s*(-?[\d.]+),(-?[\d.]+)|C\s*(-?[\d.]+),(-?[\d.]+)\s+(-?[\d.]+),(-?[\d.]+)\s+(-?[\d.]+),(-?[\d.]+)/g)]
      .flatMap(m => [m[2], m[4], m[6], m[8]].filter(v => v !== undefined).map(Number)));
  assert(Math.min(...ys) >= PAD_T - 0.01, `band escapes above the plot: ${Math.min(...ys)}`);
  assert(Math.max(...ys) <= H - PAD_B + 0.01, `band escapes below the baseline: ${Math.max(...ys)}`);

  // The stack peaks at the last sample (40+5+20 = 65 = the axis max) and must touch the top.
  assert(Math.abs(Math.min(...ys) - PAD_T) < 0.01, `full stack should reach the axis max, got ${Math.min(...ys)}`);

  // Bands must be cumulative: at each sample, heapUsed sits below heapUsed+external.
  const bandTopYs = [...svg.matchAll(/<path d="M([\d.]+),([\d.]+)[^"]*" fill="(\w+)"/g)].map(m => ({ y: +m[2], color: m[3] }));
  const first = c => bandTopYs.find(b => b.color === c).y;
  assert(first('red') > first('green') && first('green') > first('blue'),
    `bands are not stacked bottom-up: ${JSON.stringify(bandTopYs)}`);

  // Empty input must not throw or draw a bogus axis.
  assert(/No data yet/.test(renderStackedChart([{ label: 'a', color: 'red', values: [] }], 'e', 84)));
}

// --- 2. row subtitles are memory-only ------------------------------------------------
{
  const withDetail = {
    name: 'app', memory: 200, cpu: 93.5, status: 'running',
    memDetail: { heapUsed: MB(84), native: MB(310), rss: MB(400), heapTotal: MB(90), external: MB(6), arrayBuffers: MB(2), source: 'agent' },
  };
  const sub = ui.memSubtitle(withDetail);
  assert(/heap 84 MB/.test(sub) && /native 310 MB/.test(sub), sub);
  assert(!/CPU/i.test(sub) && !/93\.5/.test(sub), `CPU leaked into the memory modal: ${sub}`);

  // No detail → RSS + explicit note, and no invented native.
  const noDetail = { name: 'sh', memory: 12, cpu: 4, status: 'running', memDetail: { error: 'not a Node process' } };
  const sub2 = ui.memSubtitle(noDetail);
  assert(/12 MB RSS/.test(sub2), sub2);
  assert(/heap detail unavailable/.test(sub2), sub2);
  assert(!/native \d/.test(sub2), `derived native rendered from missing inputs: ${sub2}`);

  const detail2 = ui._memSplitDetailHtml(noDetail);
  assert(/heap detail unavailable/.test(detail2) && /not a Node process/.test(detail2), detail2);
  assert(!/native<\/div><div class="mem-split-val"[^>]*>\d/.test(detail2), 'native box rendered without inputs');
}

// --- 3. native is blanked, not zeroed, when the identity does not hold ---------------
{
  // Measured case: V8 reserved 186 MB of heap while RSS is 143 MB → rss-heapTotal-external < 0.
  const p = {
    name: 'leaky', memory: 143, status: 'running',
    memDetail: {
      rss: MB(143), heapTotal: MB(186), heapUsed: MB(120), external: MB(2), arrayBuffers: MB(1),
      native: null, nativeNote: 'V8 has reserved more heap than is resident — native not derivable', source: 'cdp',
    },
  };
  // The subtitle may name whichever of external/native dominates, but it must never
  // print a native figure when native could not be derived.
  const sub = ui.memSubtitle(p);
  assert(!/native \d/.test(sub), `derived native rendered from a broken identity: ${sub}`);
  const d = ui._memSplitDetailHtml(p);
  assert(/n\/a/.test(d) && /not derivable/.test(d), d);
  assert(!/native<\/div>\s*<div class="mem-split-val"[^>]*>0 MB/.test(d), 'null native rendered as 0 MB');
}

// --- 4. tracked structures report counts, never contents -----------------------------
{
  const p = {
    name: 'bot', memory: 90, status: 'running',
    memDetail: {
      rss: MB(90), heapTotal: MB(40), heapUsed: MB(30), external: MB(3), arrayBuffers: MB(1), native: MB(47),
      source: 'agent', tracked: [{ name: 'sessions', count: 35000 }, { name: 'queue', count: 70 }],
    },
  };
  const d = ui._memSplitDetailHtml(p);
  assert(/sessions/.test(d) && /35[.,  ]?000 entries/.test(d), d);   // locale-agnostic grouping
  assert(/never contents/.test(d), 'the counts-only guarantee should be stated in the UI');
}

console.log('ok - memory UI checks pass');
