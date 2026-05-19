'use strict';

const path = require('path');
const os = require('os');

const PM3_HOME = process.env.PM3_HOME || path.join(os.homedir(), '.pm3');
const DAEMON_PORT = parseInt(process.env.PM3_DAEMON_PORT || '4926', 10);
const DASHBOARD_PORT = parseInt(process.env.PM3_DASHBOARD_PORT || '4927', 10);
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

const PATHS = {
  home: PM3_HOME,
  processes: path.join(PM3_HOME, 'processes.json'),
  issues: path.join(PM3_HOME, 'issues.json'),
  logs: path.join(PM3_HOME, 'logs'),
  config: path.join(PM3_HOME, 'config.json'),
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
