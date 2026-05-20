'use strict';

const path = require('path');
const os = require('os');

function resolvePm3Home() {
  if (process.env.PM3_HOME) return process.env.PM3_HOME;
  // When invoked via sudo, resolve the original user's home so the process
  // list is identical whether pm3 is run as the user or with sudo.
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && typeof process.getuid === 'function' && process.getuid() === 0) {
    try {
      const { execSync } = require('child_process');
      const entry = execSync(`getent passwd ${sudoUser}`, {
        encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const home = entry.split(':')[5];
      if (home) return path.join(home, '.pm3');
    } catch {}
    // Fallback for standard Linux layouts
    return path.join('/home', sudoUser, '.pm3');
  }
  return path.join(os.homedir(), '.pm3');
}

const PM3_HOME = resolvePm3Home();
const DAEMON_PORT = parseInt(process.env.PM3_DAEMON_PORT || '4926', 10);
const DASHBOARD_PORT = parseInt(process.env.PM3_DASHBOARD_PORT || '4927', 10);
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

const PATHS = {
  home: PM3_HOME,
  processes: path.join(PM3_HOME, 'processes.json'),
  issues: path.join(PM3_HOME, 'issues.json'),
  logs: path.join(PM3_HOME, 'logs'),
  config: path.join(PM3_HOME, 'config.json'),
  prefs:  path.join(PM3_HOME, 'dashboard.json'),
  pid: path.join(PM3_HOME, 'daemon.pid'),
  sock: path.join(PM3_HOME, 'daemon.sock'),
};

const STATUS = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  CRASHED: 'crashed',
  RESTARTING: 'restarting',
  STARTING: 'starting',
};

const SEVERITY = {
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
};

module.exports = { PM3_HOME, DAEMON_PORT, DASHBOARD_PORT, DAEMON_BASE_URL, PATHS, STATUS, SEVERITY };
