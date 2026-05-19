// Memory leak test: slowly allocates RAM
// Use with: pm3 start test/memory-leak.js --memory-limit 100
console.log('[mem-leak] Started — slowly allocating memory');

const chunks = [];

setInterval(() => {
  // Allocate ~5MB per second
  chunks.push(Buffer.alloc(5 * 1024 * 1024));
  const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(`[mem-leak] Heap used: ${mb} MB (chunks: ${chunks.length})`);
}, 1000);
