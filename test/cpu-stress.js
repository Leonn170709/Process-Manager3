// CPU stress test: does work every second, reports usage
console.log('[cpu-stress] Started');

function burn(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {} // busy loop
}

setInterval(() => {
  burn(200); // burn 200ms of CPU
  console.log(`[cpu-stress] Burned 200ms CPU at ${new Date().toLocaleTimeString()}`);
}, 1000);
