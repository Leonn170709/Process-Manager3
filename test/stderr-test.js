// Stderr test: writes warnings and errors to stderr periodically
console.log('[stderr-test] Started');

let i = 0;
setInterval(() => {
  i++;
  if (i % 5 === 0) {
    process.stderr.write(`[stderr-test] Error: something went wrong at tick ${i}\n`);
  } else {
    console.log(`[stderr-test] tick ${i}`);
  }
}, 2000);
