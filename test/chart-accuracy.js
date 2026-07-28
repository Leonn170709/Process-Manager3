// Extracts the pure chart-geometry functions out of index.html and checks the accuracy
// properties the fix is supposed to guarantee.
const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync(require('path').join(__dirname, '..', 'dashboard', 'public', 'index.html'), 'utf8');
const start = html.indexOf('// ── SVG sparkline chart');
const end   = html.indexOf('// ── Stats modal');
assert(start > 0 && end > start, 'could not locate chart section');
const src = html.slice(start, end);
const sandbox = {};
new Function('exports', src + '\nObject.assign(exports,{renderChart,_smoothPath,_chartSampleX,_chartNum,CHART_W,CHART_CW,CHART_DATA_FRAC,CHART_PAD_R});')(sandbox);
const { renderChart, _smoothPath, _chartSampleX, _chartNum, CHART_W, CHART_CW, CHART_DATA_FRAC, CHART_PAD_R } = sandbox;

// --- 1. bezier must not overshoot the plot band (was drawing >100% CPU) ---
function pathYRange(d) {
  const nums = s => s.trim().split(/[\s,]+/).map(Number);
  const segs = d.split(/(?=[MC])/);
  let cur = null, lo = Infinity, hi = -Infinity;
  const see = y => { lo = Math.min(lo, y); hi = Math.max(hi, y); };
  for (const s of segs) {
    const v = nums(s.slice(1));
    if (s[0] === 'M') { cur = { x: v[0], y: v[1] }; see(cur.y); }
    else if (s[0] === 'C') {
      const [c1x, c1y, c2x, c2y, px, py] = v;
      for (let t = 0; t <= 1.0001; t += 0.05) {   // sample the actual curve
        const u = 1 - t;
        see(u*u*u*cur.y + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*py);
      }
      cur = { x: px, y: py };
    }
  }
  return { lo, hi };
}

const H = 84, PAD_T = 6, PAD_B = 6;
// a nasty spike train: exactly the shape that made the old code overshoot
const spikes = [0, 0, 100, 0, 0, 100, 100, 0, 3, 97, 0];
const pts = spikes.map((v, i) => ({
  x: _chartSampleX(i, spikes.length),
  y: H - PAD_B - (v/100) * (H - PAD_T - PAD_B),
}));
const { lo, hi } = pathYRange(_smoothPath(pts));
assert(lo >= PAD_T - 1e-6, `curve rose above max: y=${lo.toFixed(2)} < ${PAD_T}`);
assert(hi <= H - PAD_B + 1e-6, `curve dipped below baseline: y=${hi.toFixed(2)} > ${H-PAD_B}`);

// --- 2. crosshair maths must land on the drawn sample ---
// Screen model: hover area of width AW, svg inset by `inset` px on each side.
const AW = 700, inset = 9;
const svgW = AW - 2*inset;
const box = { left: inset, width: svgW * CHART_DATA_FRAC };
const n = 90;
for (const i of [0, 1, 44, 88, 89]) {
  // where renderChart actually draws sample i, in screen px
  const drawn = inset + (_chartSampleX(i, n) / CHART_W) * svgW;
  // where the crosshair puts the bar for that sample
  const bar = box.left + box.width * (i / (n-1));
  assert(Math.abs(drawn - bar) < 0.01, `sample ${i}: drawn ${drawn.toFixed(2)} vs bar ${bar.toFixed(2)}`);
  // and pointing at the drawn pixel must resolve back to sample i
  const pct = Math.max(0, Math.min(1, (drawn - box.left) / box.width));
  assert.strictEqual(Math.min(Math.round(pct * (n-1)), n-1), i, `round-trip failed for sample ${i}`);
}
// the old buggy mapping, for the record
const oldBar = AW * 1.0, newBar = box.left + box.width;
assert(oldBar - newBar > 40, 'expected the old right-edge error to be >40px');

// --- 3. small values must not all label as "0" ---
assert.strictEqual(_chartNum(0.4, ' KB/s'), '0.40');
assert.strictEqual(_chartNum(0, ' KB/s'), '0');
assert.strictEqual(_chartNum(1.25, ' KB/s'), '1.3');
assert.strictEqual(_chartNum(1234.6, ' KB/s'), '1235');
assert.strictEqual(_chartNum(7.77, '%'), '7.8');
assert.strictEqual(_chartNum(93.4, '%'), '93');

// --- 4. values above the axis max are clamped, never drawn off-chart ---
const overflow = renderChart([50, 250, 50], 'red', 't', '%');   // % axis is fixed at 100
const ys = [...overflow.matchAll(/[MC]([\d.]+),([\d.]+)/g)].map(m => +m[2]);
assert(Math.min(...ys) >= PAD_T - 1e-6, `>100% value escaped the plot band: ${Math.min(...ys)}`);

// --- 5. y-axis labels are HTML, never <text> in the stretched SVG ---
// The SVG is preserveAspectRatio="none", so x is scaled non-uniformly: any <text> inside
// it gets smeared horizontally, and the distortion grows the further the container width
// is from CHART_W. Labels must therefore live outside the SVG, in the CSS pixel grid.
const svg = renderChart([1, 2, 3], 'red', 't2', '%');
assert(!/<text/.test(svg), 'y-axis labels are drawn inside the stretched SVG and will smear');
assert(/<div class="chart-c">/.test(svg), 'chart is missing its positioning container');

const labels = [...svg.matchAll(/<span style="top:([\d.]+)px">([^<]*)<\/span>/g)];
assert.strictEqual(labels.length, 4, `expected 4 gridline labels, got ${labels.length}`);
// Every label must sit on a gridline, i.e. inside the plot band.
assert(labels.every(m => +m[1] >= PAD_T - 1e-6 && +m[1] <= H - PAD_B + 1e-6),
  'a y-axis label is positioned outside the plot band');
// The unit belongs on the top label only — four copies of " KB/s" overflow the gutter.
const kb = [...renderChart([1, 2, 3], 'red', 't3', ' KB/s')
  .matchAll(/<span style="top:[\d.]+px">([^<]*)<\/span>/g)].map(m => m[1]);
assert.strictEqual(kb.filter(t => t.includes('KB/s')).length, 1,
  `unit should appear on exactly one label, got: ${kb.join(' | ')}`);

// Short charts drop the labels entirely rather than clip them — the gutter stays reserved
// either way, so the shared crosshair geometry is unaffected.
const mini = renderChart([1, 2, 3], 'red', 't4', ' KB/s', 56);
assert(!/chart-yl/.test(mini), 'mini charts must not render y-axis labels');
assert(/viewBox="0 0 660 56"/.test(mini), 'mini chart lost the shared 660-unit geometry');

console.log('ok - all chart accuracy checks pass');
