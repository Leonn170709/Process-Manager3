'use strict';
// network-test.js — generates real HTTP traffic so network graphs show activity
// Start with: pm3 start test/network-test.js --name network-test
const http = require('http');

const PORT = 7778;
let reqCount = 0;
let bytesSent = 0;

// Local server that echoes back variable-size payloads
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const size = parseInt(req.headers['x-payload-size'] || '512');
    const payload = Buffer.alloc(Math.min(size, 65536), 'x');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
    res.end(payload);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[network-test] HTTP server on port ${PORT}`);
  console.log('[network-test] Sending requests every 300ms — watch Network graphs in PM3 Dashboard');
  schedule();
});

function schedule() {
  // Vary request rate and payload size over time for an interesting graph shape
  let tick = 0;
  setInterval(() => {
    tick++;
    // Burst every 5 seconds
    const burst = tick % 25 < 3;
    const count = burst ? 15 : Math.floor(Math.random() * 5) + 1;
    const payloadSize = burst ? 32768 : Math.floor(Math.random() * 4096) + 256;

    for (let i = 0; i < count; i++) {
      const postBody = Buffer.alloc(Math.floor(payloadSize / 4), 'y');
      const req = http.request({
        hostname: '127.0.0.1',
        port: PORT,
        path: '/',
        method: 'POST',
        headers: { 'x-payload-size': payloadSize, 'Content-Length': postBody.length },
      }, res => {
        let rx = 0;
        res.on('data', chunk => { rx += chunk.length; });
        res.on('end', () => {
          reqCount++;
          bytesSent += rx + postBody.length;
          if (reqCount % 50 === 0) {
            const kb = (bytesSent / 1024).toFixed(1);
            console.log(`[network-test] ${reqCount} requests · ${kb} KB total · ${new Date().toLocaleTimeString()}`);
          }
        });
      });
      req.on('error', () => {});
      req.end(postBody);
    }
  }, 300);
}

process.on('SIGTERM', () => { server.close(); process.exit(0); });
