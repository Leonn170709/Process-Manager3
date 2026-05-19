'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../config/constants');

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB per log file
const _appendCount = {};

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

function writeJSON(filePath, data) {
  ensureHome();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// --- Processes ---
function loadProcesses() {
  return readJSON(PATHS.processes, {});
}

function saveProcesses(procs) {
  writeJSON(PATHS.processes, procs);
}

// --- Issues ---
function loadIssues() {
  return readJSON(PATHS.issues, []);
}

function saveIssues(issues) {
  writeJSON(PATHS.issues, issues);
}

// --- Log files ---
function getLogPath(name, type = 'out') {
  ensureDir(PATHS.logs);
  return path.join(PATHS.logs, `${name}-${type}.log`);
}

function appendLog(name, type, line) {
  const logPath = getLogPath(name, type);
  fs.appendFileSync(logPath, line + '\n', 'utf8');

  // Check size every 100 appends; trim to last half when over limit
  const key = `${name}:${type}`;
  _appendCount[key] = (_appendCount[key] || 0) + 1;
  if (_appendCount[key] % 100 === 0) {
    try {
      if (fs.statSync(logPath).size > MAX_LOG_SIZE) {
        const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(logPath, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', 'utf8');
      }
    } catch {}
  }
}

function readLog(name, type = 'out', lines = 200) {
  const logPath = getLogPath(name, type);
  if (!fs.existsSync(logPath)) return '';
  const content = fs.readFileSync(logPath, 'utf8');
  const allLines = content.split('\n');
  return allLines.slice(Math.max(0, allLines.length - lines)).join('\n');
}

function clearLog(name) {
  ['out', 'err'].forEach(t => {
    const p = getLogPath(name, t);
    if (fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
  });
}

module.exports = {
  ensureHome,
  loadProcesses,
  saveProcesses,
  loadIssues,
  saveIssues,
  getLogPath,
  appendLog,
  readLog,
  clearLog,
};
