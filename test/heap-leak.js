// JS heap leak: grows heapUsed, leaves external flat.
// The counterpart to memory-leak.js, which allocates Buffers and so grows `external`
// while heapUsed stays flat. Side by side in the memory modal the two look nothing alike.
// Use with: pm3 start test/heap-leak.js
console.log('[heap-leak] Started — growing JS objects');

const retained = [];

setInterval(() => {
  // ~2 MB/s of real JS objects (strings + objects live on the V8 heap, not in `external`)
  for (let i = 0; i < 20000; i++) {
    retained.push({ id: i, at: Date.now(), pad: 'x'.repeat(64) });
  }
  const m = process.memoryUsage();
  console.log(`[heap-leak] heapUsed ${Math.round(m.heapUsed/1048576)} MB · external ${Math.round(m.external/1048576)} MB · objects ${retained.length}`);
}, 1000);
