'use strict';

const { v4: uuidv4 } = require('uuid');
const storage = require('../storage');
const { SEVERITY } = require('../config/constants');

function createIssue({ processName, processId, message, stack, exitCode, reason, severity, logs }) {
  const issues = storage.loadIssues();
  const issue = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    processName: processName || 'unknown',
    processId: processId || null,
    message: message || 'Unknown error',
    stack: stack || '',
    exitCode: exitCode !== undefined ? exitCode : null,
    reason: reason || '',
    severity: severity || SEVERITY.ERROR,
    logs: logs || '',
    resolved: false,
  };
  issues.unshift(issue); // newest first
  storage.saveIssues(issues);
  return issue;
}

function getIssues() {
  return storage.loadIssues();
}

function deleteIssue(id) {
  const issues = storage.loadIssues().filter(i => i.id !== id);
  storage.saveIssues(issues);
}

function clearIssues() {
  storage.saveIssues([]);
}

function resolveIssue(id) {
  const issues = storage.loadIssues();
  const idx = issues.findIndex(i => i.id === id);
  if (idx !== -1) {
    issues[idx].resolved = true;
    storage.saveIssues(issues);
  }
}

module.exports = { createIssue, getIssues, deleteIssue, clearIssues, resolveIssue };
