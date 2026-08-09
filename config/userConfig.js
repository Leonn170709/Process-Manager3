'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');

// ── Schema ────────────────────────────────────────────────────
// Each entry defines the default value, display unit, and description.

const SCHEMA = {
  autoResurrect: {
    default: true,
    unit: '',
    desc: 'Automatically resurrect saved processes when daemon starts',
  },
  autoSave: {
    default: true,
    unit: '',
    desc: 'Auto-save process list after start, stop, restart, or delete',
  },
  defaultMaxRestarts: {
    default: 15,
    unit: '',
    desc: 'Default max restart attempts when starting a new process',
  },
  defaultMemoryLimit: {
    default: null,
    unit: 'MB',
    desc: 'Default memory limit for new processes (null = unlimited)',
  },
  logLines: {
    default: 100,
    unit: 'lines',
    desc: 'Default number of log lines shown by  pm3 logs',
  },
  monitorInterval: {
    default: 2000,
    unit: 'ms',
    desc: 'Refresh interval for  pm3 monit',
  },
  daemonPort: {
    default: 4926,
    unit: '',
    desc: 'Daemon / dashboard port  (requires daemon restart to apply)',
  },
  maxIssues: {
    default: 200,
    unit: 'issues',
    desc: 'Maximum number of stored issues (-1 = unlimited)',
  },
  discordToken: {
    default: '',
    unit: '',
    secret: true,
    desc: 'Discord bot token for the control panel (empty = disabled, needs daemon restart)',
  },
  discordChannel: {
    default: '',
    unit: '',
    desc: 'Discord channel ID the bot posts and accepts commands in (empty = disabled)',
  },
};

const DEFAULTS = Object.fromEntries(
  Object.entries(SCHEMA).map(([k, v]) => [k, v.default])
);

// ── I/O ───────────────────────────────────────────────────────

function ensureDir() {
  const dir = path.dirname(PATHS.config);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    if (!fs.existsSync(PATHS.config)) return { ...DEFAULTS };
    const data = JSON.parse(fs.readFileSync(PATHS.config, 'utf8'));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(cfg) {
  ensureDir();
  fs.writeFileSync(PATHS.config, JSON.stringify(cfg, null, 2), 'utf8');
}

// ── Public API ────────────────────────────────────────────────

function getAll() {
  return load();
}

function get(key) {
  return load()[key];
}

// Same as getAll(), with `secret` values replaced by a fixed placeholder. Used
// everywhere the config leaves the daemon (REST, dashboard, CLI listing) so a bot
// token is never echoed back over the network.
const MASK = '••••••••';
function getAllMasked() {
  const cfg = load();
  for (const [k, def] of Object.entries(SCHEMA)) if (def.secret && cfg[k]) cfg[k] = MASK;
  return cfg;
}

function set(key, rawValue) {
  if (!(key in SCHEMA)) {
    const valid = Object.keys(SCHEMA).join(', ');
    throw new Error(`Unknown key "${key}". Valid keys: ${valid}`);
  }

  const def = SCHEMA[key].default;
  let value;

  // A masked value coming back from the dashboard means "unchanged", not "set the
  // literal bullets as my token".
  if (SCHEMA[key].secret && rawValue === MASK) return { key, value: load()[key], prev: load()[key] };

  if (def === null || typeof def === 'number') {
    // Accepts a number or the literal string "null"
    if (rawValue === 'null') {
      value = null;
    } else {
      const n = Number(rawValue);
      if (isNaN(n)) throw new Error(`"${key}" expects a number, got: ${rawValue}`);
      if (n < -1) throw new Error(`"${key}" must be -1 (unlimited) or higher — values below -1 are not allowed`);
      value = n;
    }
  } else if (typeof def === 'boolean') {
    if (rawValue === 'true')  value = true;
    else if (rawValue === 'false') value = false;
    else throw new Error(`"${key}" expects true or false, got: ${rawValue}`);
  } else {
    value = rawValue;
  }

  const cfg = load();
  const prev = cfg[key];
  cfg[key] = value;
  persist(cfg);
  return { key, value, prev };
}

function reset() {
  persist({ ...DEFAULTS });
  return { ...DEFAULTS };
}

module.exports = { SCHEMA, DEFAULTS, PATHS, MASK, load, getAll, getAllMasked, get, set, reset };
