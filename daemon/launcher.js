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

// Signal 0 does no killing - it only asks whether the pid is still there.
function _alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopDaemon(timeoutMs = 20000) {
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
  } catch {
    return { error: `Could not kill PID ${pid}. Retry with sudo` };
  }

  // The daemon now stops every managed process before it exits, so this is no longer
  // instant. Wait for the pid to actually go away - reporting "daemon stopped" off the
  // signal alone would put the CLI's success message ahead of the shutdown it describes.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    if (!_alive(pid)) return { ok: true };
  }

  // Wedged past its own 10 s self-timeout. Force it rather than hanging the CLI, and say
  // so - a SIGKILLed daemon cannot clean up, so this is the one path that can still leave
  // orphans behind.
  try { process.kill(pid, 'SIGKILL'); } catch {}
  return { ok: true, forced: true };
}

module.exports = { isDaemonRunning, startDaemon, stopDaemon };
