'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { PATHS, DAEMON_BASE_URL } = require('../config/constants');
const storage = require('../storage');

storage.ensureHome();

async function isDaemonRunning() {
  try {
    await axios.get(`${DAEMON_BASE_URL}/api/ping`, { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

async function startDaemon() {
  if (await isDaemonRunning()) return { already: true };

  const daemonScript = path.join(__dirname, 'index.js');
  const out = fs.openSync(path.join(PATHS.home, 'daemon.log'), 'a');
  const err = fs.openSync(path.join(PATHS.home, 'daemon-error.log'), 'a');

  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();

  // Wait for daemon to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await isDaemonRunning()) return { started: true, pid: child.pid };
  }
  return { error: 'Daemon did not start in time' };
}

async function stopDaemon() {
  let pid = null;

  if (fs.existsSync(PATHS.pid)) {
    const parsed = parseInt(fs.readFileSync(PATHS.pid, 'utf8'), 10);
    if (!Number.isNaN(parsed)) pid = parsed;
  }

  // Fallback: daemon may be running even when PID file is missing/stale.
  if (!pid) {
    try {
      const res = await axios.get(`${DAEMON_BASE_URL}/api/ping`, { timeout: 1000 });
      if (res && res.data && Number.isInteger(res.data.pid)) pid = res.data.pid;
    } catch {}
  }

  if (!pid) return { error: 'Daemon PID file not found' };

  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true };
  } catch {
    return { error: `Could not kill PID ${pid}. Retry with sudo` };
  }
}

module.exports = { isDaemonRunning, startDaemon, stopDaemon };
