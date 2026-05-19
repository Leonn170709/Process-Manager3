// Simple test: logs "hi" every 5 seconds
let count = 0;
console.log('[hello] Started');

setInterval(() => {
  count++;
  console.log(`[hello] hi — tick #${count} at ${new Date().toLocaleTimeString()}`);
}, 5000);
