// Crash test: runs fine, then throws an error after 15s
// Use this to test PM3's auto-restart and issue tracking
console.log('[crash-test] Started — will crash in 15 seconds');

let t = 15;
const countdown = setInterval(() => {
  console.log(`[crash-test] Crashing in ${t}s...`);
  t--;
  if (t <= 0) {
    clearInterval(countdown);
    console.error('[crash-test] ERROR: Simulated crash!');
    throw new Error('Simulated crash for PM3 testing');
  }
}, 1000);
