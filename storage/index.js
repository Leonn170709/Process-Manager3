'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../config/constants');

const MAX_LOG_SIZE = 5 * 1024 * 1024;  // 5 MB per log file
const TRIM_CHECK_BYTES = 256 * 1024;   // stat a log only after this much was appended to it
const _sinceCheck = {};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureHome() {
  ensureDir(PATHS.home);
  ensureDir(PATHS.logs);
}

function readJSON(filePath, defaultVal = {}) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultVal;
  }
}

// Write-then-rename: a crash mid-write leaves the old file intact instead of a truncated one,
// which readJSON would parse as {} - and the next save would then persist the empty list.
function writeFileAtomic(filePath, text) {
  ensureHome();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeJSON(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

// --- Processes ---
// The daemon is the only process that reads or writes this file (CLI and Discord go through it),
// so the parsed list lives in RAM and disk is only touched when the persisted part changes.
let _procs = null;
let _procsJSON = null;   // what is on disk now, to skip identical rewrites

// Refreshed every stats tick and meaningless after a daemon restart, so never written.
const VOLATILE = { cpu: 0, memory: 0, uptime: 0, memDetail: null, connections: 0, netRx: 0, netTx: 0 };

function loadProcesses() {
  if (!_procs) _procs = readJSON(PATHS.processes, {});
  return _procs;
}

function saveProcesses(procs) {
  _procs = procs;
  const disk = {};
  for (const [name, p] of Object.entries(procs)) disk[name] = { ...p, ...VOLATILE };
  const json = JSON.stringify(disk, null, 2);
  if (json === _procsJSON) return;
  writeFileAtomic(PATHS.processes, json);
  _procsJSON = json;
}

// --- Issues ---
// RAM-first like processes. An app printing errors in a loop creates an issue per stderr chunk,
// so writes are coalesced to at most one a second; the daemon calls flushIssues() on shutdown.
let _issues = null;
let _issuesTimer = null;

function loadIssues() {
  if (!_issues) {
    // Older versions stored `logs`, a second copy of `stack`; dropping it here means the first
    // save after an update rewrites issues.json at about half the size.
    const saved = readJSON(PATHS.issues, []);
    _issues = Array.isArray(saved) ? saved.map(({ logs, ...issue }) => issue) : [];
  }
  return _issues;
}

function saveIssues(issues) {
  _issues = issues;
  if (!_issuesTimer) _issuesTimer = setTimeout(flushIssues, 1000);
}

function flushIssues() {
  if (!_issuesTimer) return;   // nothing pending
  clearTimeout(_issuesTimer);
  _issuesTimer = null;
  writeJSON(PATHS.issues, _issues);
}

// --- Log files ---
// No mkdir here: this runs for every chunk of output. ensureHome() creates the directory at
// daemon start, and appendLog recreates it if it is deleted while the daemon runs.
function getLogPath(name, type = 'out') {
  return path.join(PATHS.logs, `${name}-${type}.log`);
}

// `text` may be several lines: callers hand over a whole stdout chunk as one append.
function appendLog(name, type, text) {
  const logPath = getLogPath(name, type);
  try {
    fs.appendFileSync(logPath, text + '\n', 'utf8');
  } catch {
    ensureDir(PATHS.logs);
    fs.appendFileSync(logPath, text + '\n', 'utf8');
  }

  // Trim to the newer half once over the limit, checked by volume written rather than per call
  _sinceCheck[logPath] = (_sinceCheck[logPath] || 0) + text.length;
  if (_sinceCheck[logPath] < TRIM_CHECK_BYTES) return;
  _sinceCheck[logPath] = 0;
  try {
    if (fs.statSync(logPath).size > MAX_LOG_SIZE) {
      const buf = fs.readFileSync(logPath);
      fs.writeFileSync(logPath, buf.subarray(buf.indexOf(10, buf.length >> 1) + 1));
    }
  } catch {}
}

// Reads backwards from the end only as far as `lines` needs: logs run up to 5 MB and every
// caller wants the tail. Chunks are joined before decoding so no UTF-8 character is split.
function readLog(name, type = 'out', lines = 200) {
  let fd;
  try { fd = fs.openSync(getLogPath(name, type), 'r'); } catch { return ''; }
  try {
    const chunks = [];
    let pos = fs.fstatSync(fd).size, newlines = 0;
    while (pos > 0 && newlines < lines) {
      const len = Math.min(64 * 1024, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, pos);
      for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) newlines++;
      chunks.unshift(buf);
    }
    const all = Buffer.concat(chunks).toString('utf8').split('\n');
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function clearLog(name) {
  ['out', 'err'].forEach(t => {
    const p = getLogPath(name, t);
    if (fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
  });
}

// --- Dashboard prefs ---
function loadPrefs() {
  return readJSON(PATHS.prefs, {});
}

function savePrefs(prefs) {
  writeJSON(PATHS.prefs, prefs);
}

module.exports = {
  ensureHome,
  writeFileAtomic,
  loadProcesses,
  saveProcesses,
  loadIssues,
  saveIssues,
  flushIssues,
  loadPrefs,
  savePrefs,
  getLogPath,
  appendLog,
  readLog,
  clearLog,
};
