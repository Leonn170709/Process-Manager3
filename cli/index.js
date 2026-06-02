#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const axios = require('axios');

const { DAEMON_BASE_URL, PATHS } = require('../config/constants');
const { startDaemon, isDaemonRunning } = require('../daemon/launcher');
const cfg = require('../config/userConfig');

const VERSION = '1.0.0';

// ── ANSI-aware string utils ───────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function vlen(s)          { return String(s).replace(ANSI_RE, '').length; }
function padR(s, n)       { return s + ' '.repeat(Math.max(0, n - vlen(s))); }   // left-align
function padL(s, n)       { return ' '.repeat(Math.max(0, n - vlen(s))) + s; }   // right-align
function trunc(s, n)      { return vlen(s) > n ? s.slice(0, n - 1) + '…' : s; }

// ── Terminal geometry ─────────────────────────────────────────

function termW() { return Math.min(process.stdout.columns || 80, 110); }

// ── Progress bar ──────────────────────────────────────────────

function bar(pct, width = 20) {
  const p   = Math.max(0, Math.min(100, pct || 0));
  const f   = Math.round((p / 100) * width);
  const col = p > 85 ? chalk.red : p > 60 ? chalk.yellow : chalk.cyan;
  return col('█'.repeat(f)) + chalk.dim('░'.repeat(width - f));
}

// ── Box drawing ───────────────────────────────────────────────

function boxTop(title, hint, w) {
  // ┌─ title ────────────────────── hint ─┐
  const t = title ? chalk.bold(` ${title} `) : '';
  const h = hint  ? chalk.dim(` ${hint} ─`)  : '─';
  const fill = Math.max(2, w - 2 - vlen(t) - vlen(h));
  return chalk.dim('┌─') + t + chalk.dim('─'.repeat(fill)) + h + chalk.dim('┐');
}

function boxDiv(w) {
  return chalk.dim('├' + '─'.repeat(w - 2) + '┤');
}

function boxBot(w) {
  return chalk.dim('└' + '─'.repeat(w - 2) + '┘');
}

function boxRow(content, w) {
  const inner = w - 4;  // 2 for │, 2 for spaces
  const pad   = Math.max(0, inner - vlen(content));
  return chalk.dim('│') + ' ' + content + ' '.repeat(pad) + ' ' + chalk.dim('│');
}

function boxBlank(w) { return boxRow('', w); }

// ── Status ────────────────────────────────────────────────────

const S = {
  running:    { dot: chalk.green('●'),  col: chalk.green  },
  stopped:    { dot: chalk.gray('■'),   col: chalk.gray   },
  crashed:    { dot: chalk.red('✕'),    col: chalk.red    },
  restarting: { dot: chalk.yellow('↻'), col: chalk.yellow },
  starting:   { dot: chalk.cyan('◌'),   col: chalk.cyan   },
};

function sDot(s)   { return (S[s] || { dot: chalk.white('?') }).dot; }
function sLabel(s) { const st = S[s]; return st ? st.col(s) : chalk.white(s); }
function sFull(s)  { return sDot(s) + ' ' + sLabel(s); }

// ── Formatters ────────────────────────────────────────────────

function fmtUp(sec) {
  if (!sec) return chalk.dim('—');
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtMem(mb) {
  if (!mb) return chalk.dim('—');
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
}

function fmtCpu(cpu) { return cpu != null ? cpu + '%'      : chalk.dim('—'); }
function fmtPid(pid) { return pid          ? chalk.dim(pid): chalk.dim('—'); }
function fmtN(n)     { return n  != null   ? String(n)     : chalk.dim('—'); }

// ── Print helpers ─────────────────────────────────────────────

function ok(msg)   { console.log(`  ${chalk.green('✓')}  ${msg}`); }
function fail(msg) { console.error(`  ${chalk.red('✕')}  ${msg}`); }
function warn(msg) { console.log(`  ${chalk.yellow('⚠')}  ${msg}`); }
function hint(msg) { console.log(`  ${chalk.dim(msg)}`); }
function nl()      { console.log(); }

// ── Daemon / API ──────────────────────────────────────────────

program.name('pm3').description('PM3 Process Manager').version(VERSION);

async function ensureDaemon() {
  const running = await isDaemonRunning();
  if (!running) {
    process.stdout.write(`  ${chalk.dim('Starting PM3 daemon...')} `);
    const result = await startDaemon();
    if (result.error) {
      process.stdout.write(chalk.red('failed') + '\n');
      fail(result.error); process.exit(1);
    }
    process.stdout.write(chalk.green('ready') + '\n\n');
  }
}

async function api(method, path, data) {
  try {
    const res = await axios({ method, url: `${DAEMON_BASE_URL}${path}`, data, timeout: 5000 });
    return res.data;
  } catch (err) {
    if (err.response) return err.response.data;
    fail(`Daemon not reachable: ${err.message}`);
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════
//  pm3 config
// ══════════════════════════════════════════════════════════════

program
  .command('config [action] [key] [value]')
  .description('View or edit PM3 configuration')
  .action((action, key, value) => {

    // ── helpers ──────────────────────────────────────────────
    function fmtVal(v) {
      if (v === null || v === undefined) return chalk.dim('—');
      if (v === true)  return chalk.green('true');
      if (v === false) return chalk.red('false');
      return chalk.white(String(v));
    }

    function showAll() {
      const current  = cfg.getAll();
      const { SCHEMA } = cfg;
      const W = Math.min(termW(), 72);

      nl();
      console.log(boxTop('PM3 Config', null, W));
      console.log(boxBlank(W));

      // Header
      const keyW  = 22;
      const valW  = 9;
      const defW  = 9;
      const unitW = 6;
      const thead =
        chalk.dim(padR('KEY',     keyW)) + '  ' +
        chalk.dim(padR('VALUE',   valW)) + '  ' +
        chalk.dim(padR('DEFAULT', defW)) + '  ' +
        chalk.dim(padR('UNIT',    unitW));
      const trule = chalk.dim(
        '─'.repeat(keyW) + '──' + '─'.repeat(valW) + '──' +
        '─'.repeat(defW) + '──' + '─'.repeat(unitW)
      );
      console.log(boxRow(thead, W));
      console.log(boxRow(trule, W));

      Object.entries(SCHEMA).forEach(([k, meta]) => {
        const cur  = current[k];
        const def  = meta.default;
        const same = JSON.stringify(cur) === JSON.stringify(def);
        const row  =
          padR(same ? chalk.white(k) : chalk.cyan.bold(k), keyW) + '  ' +
          padR(fmtVal(cur), valW) + '  ' +
          padR(chalk.dim(def === null ? '—' : String(def)), defW) + '  ' +
          padR(chalk.dim(meta.unit || ''), unitW);
        console.log(boxRow(row, W));
      });

      console.log(boxBlank(W));
      console.log(boxRow(chalk.dim('Config file: ' + PATHS.config), W));
      console.log(boxBlank(W));
      console.log(boxDiv(W));

      // Descriptions
      Object.entries(SCHEMA).forEach(([k, meta]) => {
        console.log(boxRow(
          chalk.dim(padR(k, 22)) + chalk.dim(trunc(meta.desc, W - 28)),
          W
        ));
      });

      console.log(boxBlank(W));
      console.log(boxBot(W));
      nl();
      hint('pm3 config set <key> <value>   Set a value');
      hint('pm3 config get <key>           Get a value');
      hint('pm3 config reset               Reset all to defaults');
      nl();
    }

    // ── actions ───────────────────────────────────────────────
    if (!action || action === 'show') {
      showAll();

    } else if (action === 'set') {
      if (!key)   return fail('Usage:  pm3 config set <key> <value>');
      if (!value) return fail('Usage:  pm3 config set <key> <value>');
      try {
        const { key: k, value: v, prev } = cfg.set(key, value);
        nl();
        ok(chalk.bold(k) + '  ' + chalk.dim(JSON.stringify(prev) ?? '—') + '  →  ' + fmtVal(v));
        nl();
      } catch (e) { fail(e.message); }

    } else if (action === 'get') {
      if (!key) return fail('Usage:  pm3 config get <key>');
      const v = cfg.get(key);
      if (v === undefined) return fail(`Unknown key: ${key}`);
      nl();
      console.log(`  ${chalk.dim(padR(key, 22))} ${fmtVal(v)}`);
      nl();

    } else if (action === 'reset') {
      cfg.reset();
      ok('Config reset to defaults');
      showAll();

    } else {
      fail(`Unknown action "${action}". Use: show · set · get · reset`);
    }
  });

// ══════════════════════════════════════════════════════════════
//  pm3 list
// ══════════════════════════════════════════════════════════════

program
  .command('list')
  .alias('ls')
  .description('List all processes')
  .action(async () => {
    await ensureDaemon();
    const procs = await api('get', '/api/processes');
    const list  = Object.values(procs);

    nl();
    console.log(`  ${chalk.bold.white('⚡ PM3')}  ${chalk.dim('v' + VERSION)}`);
    nl();

    if (!list.length) {
      hint('No processes. Start one with:  pm3 start <script>');
      nl(); return;
    }

    // Dynamic name column width
    const nameW    = Math.min(Math.max(6, ...list.map(p => p.name.length)) + 1, 22);
    const statusW  = 13; // fits '↻ restarting'
    const C = { id:4, name:nameW, status:statusW, cpu:6, ram:9, restarts:8, uptime:10, pid:7 };

    // Header
    const head = [
      padL (chalk.dim('ID'),       C.id),
      padR (chalk.dim('NAME'),     C.name),
      padR (chalk.dim('STATUS'),   C.status + 2),
      padL (chalk.dim('CPU'),      C.cpu),
      padL (chalk.dim('RAM'),      C.ram),
      padL (chalk.dim('RESTARTS'), C.restarts),
      padR (chalk.dim('UPTIME'),   C.uptime),
      padL (chalk.dim('PID'),      C.pid),
    ].join('  ');

    const rule = chalk.dim([
      '─'.repeat(C.id), '─'.repeat(C.name), '─'.repeat(C.status + 2),
      '─'.repeat(C.cpu), '─'.repeat(C.ram), '─'.repeat(C.restarts),
      '─'.repeat(C.uptime), '─'.repeat(C.pid),
    ].join('──'));

    console.log('  ' + head);
    console.log('  ' + rule);

    list.forEach(p => {
      const statusStr = sFull(p.status);   // vlen: max 12 (restarting)
      const row = [
        padL(chalk.dim(String(p.id)),  C.id),
        padR(chalk.bold(trunc(p.name, C.name)), C.name),
        padR(statusStr, C.status + 2 + (vlen(statusStr) < C.status + 2 ? 0 : 0)),
        padL(fmtCpu(p.cpu),            C.cpu),
        padL(fmtMem(p.memory),         C.ram),
        padL(fmtN(p.restartCount),     C.restarts),
        padR(fmtUp(p.uptime),          C.uptime),
        padL(fmtPid(p.pid),            C.pid),
      ].join('  ');
      console.log('  ' + row);
    });

    console.log('  ' + rule);
    nl();

    const running  = list.filter(p => p.status === 'running').length;
    const stopped  = list.filter(p => p.status === 'stopped').length;
    const crashed  = list.filter(p => p.status === 'crashed').length;
    const restarts = list.reduce((s, p) => s + (p.restartCount || 0), 0);
    const dot = chalk.dim('  ·  ');
    const parts = [
      chalk.dim(`${list.length} process${list.length !== 1 ? 'es' : ''}`),
      running  ? chalk.green(`${running} running`)   : null,
      stopped  ? chalk.gray(`${stopped} stopped`)    : null,
      crashed  ? chalk.red(`${crashed} crashed`)     : null,
      restarts ? chalk.yellow(`${restarts} restarts`): null,
    ].filter(Boolean);
    console.log('  ' + parts.join(dot));
    nl();
  });

// ══════════════════════════════════════════════════════════════
//  pm3 monit
// ══════════════════════════════════════════════════════════════

program
  .command('monit')
  .description('Live terminal monitor')
  .action(async () => {
    await ensureDaemon();
    const readline = require('readline');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const render = async () => {
      console.clear();

      const [procs, sys] = await Promise.all([
        api('get', '/api/processes'),
        api('get', '/api/system'),
      ]);
      const list = Object.values(procs);
      const W    = termW();

      const cpuPct = sys.cpu || 0;
      const ramPct = sys.memory?.percent || 0;
      const ramUsed = sys.memory ? fmtMem(Math.round(sys.memory.used / 1024 / 1024)) : '—';
      const ramTotal = sys.memory ? fmtMem(Math.round(sys.memory.total / 1024 / 1024)) : '—';
      const running  = list.filter(p => p.status === 'running').length;

      // ── Header box ──────────────────────────────────────────
      const titleStr = '⚡ PM3 Monitor';
      const hintStr  = 'q to quit';
      console.log(boxTop(titleStr, hintStr, W));
      console.log(boxBlank(W));

      // System metrics
      const barW = 22;
      console.log(boxRow(
        chalk.dim('CPU  ') + bar(cpuPct, barW) + '  ' + chalk.bold(padL(cpuPct + '%', 4)),
        W
      ));
      console.log(boxRow(
        chalk.dim('RAM  ') + bar(ramPct, barW) + '  ' + chalk.bold(padL(ramPct + '%', 4))
        + chalk.dim('   ' + ramUsed + ' / ' + ramTotal),
        W
      ));
      console.log(boxRow(
        chalk.dim('Up   ') + fmtUp(sys.uptime) +
        chalk.dim('   ·   ') + chalk.white(list.length) + chalk.dim(' processes') +
        (running ? chalk.dim('  ·  ') + chalk.green(running + ' running') : ''),
        W
      ));

      console.log(boxBlank(W));
      console.log(boxDiv(W));

      if (!list.length) {
        console.log(boxBlank(W));
        console.log(boxRow(chalk.dim('No processes. Start one with:  pm3 start <script>'), W));
        console.log(boxBlank(W));
        console.log(boxBot(W));
        return;
      }

      // ── Process table ────────────────────────────────────────
      const nameW   = Math.min(Math.max(6, ...list.map(p => p.name.length)) + 1, 18);
      const T = { id:3, name:nameW, status:13, cpu:6, ram:8, restarts:8, uptime:9 };

      const thead = [
        padL (chalk.dim('ID'),       T.id),
        padR (chalk.dim('NAME'),     T.name),
        padR (chalk.dim('STATUS'),   T.status + 1),
        padL (chalk.dim('CPU'),      T.cpu),
        padL (chalk.dim('RAM'),      T.ram),
        padL (chalk.dim('RESTARTS'), T.restarts),
        padR (chalk.dim('UPTIME'),   T.uptime),
      ].join('  ');

      const trule = chalk.dim([
        '─'.repeat(T.id), '─'.repeat(T.name), '─'.repeat(T.status + 1),
        '─'.repeat(T.cpu), '─'.repeat(T.ram), '─'.repeat(T.restarts), '─'.repeat(T.uptime),
      ].join('──'));

      console.log(boxBlank(W));
      console.log(boxRow(thead, W));
      console.log(boxRow(trule, W));

      list.forEach(p => {
        const row = [
          padL(chalk.dim(String(p.id)), T.id),
          padR(chalk.bold(trunc(p.name, T.name)), T.name),
          padR(sFull(p.status), T.status + 1),
          padL(fmtCpu(p.cpu),           T.cpu),
          padL(fmtMem(p.memory),        T.ram),
          padL(fmtN(p.restartCount),    T.restarts),
          padR(fmtUp(p.uptime),         T.uptime),
        ].join('  ');
        console.log(boxRow(row, W));
      });

      console.log(boxBlank(W));
      console.log(boxBot(W));
      console.log(chalk.dim(`\n  Refreshing every 2s`));
    };

    await render();
    const interval = setInterval(render, cfg.get('monitorInterval') ?? 2000);

    process.stdin.on('keypress', (str, key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        clearInterval(interval);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        console.clear(); process.exit(0);
      }
    });
  });

// ══════════════════════════════════════════════════════════════
//  pm3 status
// ══════════════════════════════════════════════════════════════

program
  .command('status <id>')
  .description('Show detailed process status')
  .action(async (id) => {
    await ensureDaemon();
    const p = await api('get', `/api/processes/${id}`);
    if (p.error) return fail(p.error);

    const W = Math.min(termW(), 66);
    nl();

    console.log(boxTop(p.name, null, W));
    console.log(boxBlank(W));
    console.log(boxRow(sFull(p.status), W));
    console.log(boxBlank(W));

    // CPU bar
    if (p.cpu != null) {
      console.log(boxRow(
        chalk.dim('CPU     ') + bar(p.cpu, 24) + '  ' + chalk.bold(p.cpu + '%'),
        W
      ));
    }
    // Memory bar (scale: memoryLimit or 1024 MB as 100%)
    if (p.memory) {
      const limit  = p.memoryLimit || 1024;
      const memPct = Math.round((p.memory / limit) * 100);
      const extra  = p.memoryLimit ? chalk.dim(`  / ${p.memoryLimit} MB limit`) : '';
      console.log(boxRow(
        chalk.dim('Memory  ') + bar(memPct, 24) + '  ' + chalk.bold(fmtMem(p.memory)) + extra,
        W
      ));
    }

    console.log(boxBlank(W));

    const kv = [
      ['PID',      p.pid         ? chalk.white(p.pid)                               : chalk.dim('—')],
      ['Restarts', chalk.white(fmtN(p.restartCount))],
      ['Uptime',   chalk.white(fmtUp(p.uptime))],
      ['Script',   chalk.dim(trunc(p.script || '—', W - 18))],
      ['CWD',      chalk.dim(trunc(p.cwd    || '—', W - 18))],
      ['Started',  p.startTime   ? chalk.dim(new Date(p.startTime).toLocaleString()) : chalk.dim('—')],
    ];
    const kW = 10;
    kv.forEach(([k, v]) => {
      console.log(boxRow(chalk.dim(padR(k, kW)) + v, W));
    });

    console.log(boxBlank(W));
    console.log(boxBot(W));
    nl();
  });

// ══════════════════════════════════════════════════════════════
//  pm3 logs
// ══════════════════════════════════════════════════════════════

program
  .command('logs <id>')
  .description('View logs for a process')
  .option('-n, --lines <n>', 'Number of lines', String(cfg.get('logLines') ?? 100))
  .option('-f, --follow',    'Follow output live')
  .action(async (id, opts) => {
    await ensureDaemon();
    const result = await api('get', `/api/logs/${id}?lines=${opts.lines}`);
    if (result.error) return fail(result.error);

    const W = termW();
    nl();
    console.log(boxTop(`${id}  logs`, opts.follow ? 'live' : `last ${opts.lines} lines`, W));
    console.log(boxBot(W));
    nl();

    const lines = result.combined.split('\n').filter(Boolean);
    lines.forEach(line => {
      if (line.includes('[ERR]')) console.log('  ' + chalk.red(line));
      else console.log('  ' + chalk.dim(line.replace(/^\[OUT\]\s?/, '')));
    });

    if (opts.follow) {
      const io = require('socket.io-client');
      const socket = io(DAEMON_BASE_URL);
      nl();
      console.log('  ' + chalk.dim('─'.repeat(W - 2)));
      console.log('  ' + chalk.dim('Following  —  Ctrl+C to stop'));
      console.log('  ' + chalk.dim('─'.repeat(W - 2)));
      nl();
      socket.on('log', data => {
        if (data.name !== id && data.name !== result.name) return;
        const line = '  ' + data.line;
        console.log(data.type === 'err' ? chalk.red(line) : line);
      });
    } else {
      nl();
    }
  });

// ══════════════════════════════════════════════════════════════
//  Process management commands
// ══════════════════════════════════════════════════════════════

program
  .command('start <script>')
  .description('Start a process')
  .option('--name <name>',         'Process name')
  .option('--cwd <path>',          'Working directory')
  .option('--env <vars>',          'Environment variables (KEY=VAL,KEY2=VAL2)')
  .option('--watch',               'Watch for file changes and auto-restart')
  .option('--no-autorestart',      'Disable auto-restart on crash')
  .option('--max-restarts <n>',    'Max restart attempts (default from config)', parseInt)
  .option('--memory-limit <mb>',   'Memory limit in MB (default from config)', parseInt)
  .argument('[args...]',           'Extra arguments passed to the process')
  .action(async (script, args, opts) => {
    await ensureDaemon();
    const env = {};
    if (opts.env) opts.env.split(',').forEach(pair => {
      const [k, v] = pair.split('=');
      if (k) env[k.trim()] = (v || '').trim();
    });
    const path = require('path');
    const fs   = require('fs');
    // A script is a known-extension file OR any single-word arg that exists
    // as a file on disk (e.g. an extensionless executable like `./launch`).
    const hasKnownExt  = /\.(js|mjs|cjs|sh|py|rb|pl)$/.test(script);
    const resolvedPath = path.resolve(script);
    const isLocalFile  = !script.includes(' ') && fs.existsSync(resolvedPath) &&
                         fs.statSync(resolvedPath).isFile();
    const isScript     = hasKnownExt || isLocalFile;
    const resSrc       = isScript ? resolvedPath : script;
    const resCwd       = opts.cwd ? path.resolve(opts.cwd)
                       : isScript ? path.dirname(resolvedPath) : process.cwd();

    if (isScript && !fs.existsSync(resSrc)) {
      fail(`File not found: ${resSrc}`);
      const dir  = path.dirname(resSrc);
      const base = path.basename(resSrc).toLowerCase();
      try {
        const match = fs.readdirSync(dir).find(f => f.toLowerCase() === base);
        if (match) hint(`Did you mean: ${path.join(dir, match)}`);
      } catch {}
      process.exit(1);
    }
    const config = {
      script: resSrc, name: opts.name, cwd: resCwd, env, args,
      watch: opts.watch, autorestart: opts.autorestart !== false,
      maxRestarts:  opts.maxRestarts  ?? cfg.get('defaultMaxRestarts'),
      memoryLimit:  opts.memoryLimit  ?? cfg.get('defaultMemoryLimit') ?? undefined,
    };
    const r = await api('post', '/api/processes/start', config);
    if (r.error) return fail(r.error);
    nl();
    ok(chalk.bold(r.name) + '  ' + chalk.green('started'));
    hint(`id=${r.id}   pid=${r.pid}   script=${r.script}`);
    if (cfg.get('autoSave')) {
      await api('post', '/api/save');
      hint(`Auto-saved  ${chalk.dim(PATHS.processes)}  ${chalk.dim('(pm3 config set autoSave false to disable)')}`);
    }
    nl();
  });

program
  .command('stop <id>')
  .description('Stop a process')
  .action(async (id) => {
    await ensureDaemon();
    const r = await api('post', `/api/processes/${id}/stop`);
    if (r.error) return fail(r.error);
    ok(chalk.bold(r.name) + '  ' + chalk.gray('stopped'));
    if (cfg.get('autoSave')) { await api('post', '/api/save'); hint(`Auto-saved  ${chalk.dim(PATHS.processes)}`); }
  });

program
  .command('restart <id>')
  .description('Restart a process')
  .action(async (id) => {
    await ensureDaemon();
    const r = await api('post', `/api/processes/${id}/restart`);
    if (r.error) return fail(r.error);
    ok(chalk.bold(r.name) + '  ' + chalk.cyan('restarting…'));
    if (cfg.get('autoSave')) { await api('post', '/api/save'); hint(`Auto-saved  ${chalk.dim(PATHS.processes)}`); }
  });

program
  .command('delete <id>')
  .description('Delete a process')
  .action(async (id) => {
    await ensureDaemon();
    const r = await api('delete', `/api/processes/${id}`);
    if (r.error) return fail(r.error);
    ok(chalk.bold(r.name) + '  ' + chalk.red('deleted'));
    if (cfg.get('autoSave')) { await api('post', '/api/save'); hint(`Auto-saved  ${chalk.dim(PATHS.processes)}`); }
  });

// ══════════════════════════════════════════════════════════════
//  Other commands
// ══════════════════════════════════════════════════════════════

program
  .command('info <id>')
  .description('Full process info as JSON')
  .action(async (id) => {
    await ensureDaemon();
    const r = await api('get', `/api/processes/${id}`);
    if (r.error) return fail(r.error);
    console.log(JSON.stringify(r, null, 2));
  });

program
  .command('save')
  .description('Save current process list for resurrect')
  .action(async () => {
    await ensureDaemon();
    const r = await api('post', '/api/save');
    ok(`Saved ${chalk.bold(r.saved)} processes  →  ${chalk.dim(PATHS.processes)}`);
    hint('Run  pm3 resurrect  to restore them after a reboot.');
  });

program
  .command('resurrect')
  .description('Restore saved processes')
  .action(async () => {
    await ensureDaemon();
    const procs = await api('get', '/api/processes');
    const count = Object.values(procs).filter(p => p.status === 'running').length;
    ok(`Resurrected ${chalk.bold(count)} processes`);
  });

program
  .command('dashboard')
  .description('Open the web dashboard')
  .action(async () => {
    await ensureDaemon();
    const url = `${DAEMON_BASE_URL}/dashboard`;
    ok('Dashboard  ' + chalk.cyan.underline(url));
    const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { require('child_process').exec(`${cmd} ${url}`); } catch {}
  });

program
  .command('kill')
  .description('Stop the PM3 daemon')
  .action(async () => {
    const { stopDaemon } = require('../daemon/launcher');
    const r = await stopDaemon();
    if (r.error) return fail(r.error);
    ok('PM3 daemon stopped');
  });

program
  .command('startup')
  .description('Configure PM3 to start on system boot')
  .action(async () => {
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');
    const { execSync } = require('child_process');
    const pm3Bin = process.argv[1], nodeBin = process.execPath;
    // When run via sudo, use the original user's name so the service runs as them
    const user = process.env.SUDO_USER || os.userInfo().username;

    if (process.platform === 'linux') {
      let hasSystemd = false;
      try { execSync('systemctl --version', { stdio:'ignore' }); execSync('systemctl list-units --no-pager', { stdio:'ignore', timeout:2000 }); hasSystemd = true; } catch {}
      if (hasSystemd) {
        const svcPath = '/etc/systemd/system/pm3.service';
        if (fs.existsSync(svcPath)) {
          let enabled = false;
          try { execSync('systemctl is-enabled pm3', { stdio:'ignore' }); enabled = true; } catch {}
          if (enabled) {
            warn('PM3 is already configured to start on boot  ' + chalk.dim('(systemd)'));
            hint('Service: ' + svcPath);
            hint('Run  pm3 unstartup  to remove it.');
            return;
          }
        }
        const svc = `[Unit]\nDescription=PM3 Process Manager\nAfter=network.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=${user}\nExecStart=${nodeBin} ${pm3Bin} list\nExecStop=${nodeBin} ${pm3Bin} kill\n\n[Install]\nWantedBy=multi-user.target\n`;
        try {
          fs.writeFileSync(svcPath, svc, 'utf8');
          execSync('systemctl daemon-reload'); execSync('systemctl enable pm3');
          ok('systemd service installed and enabled');
          hint('Service: ' + svcPath);
          hint('Run  pm3 save  to persist your current processes.');
        } catch (err) {
          if (err.message.includes('Permission denied') || err.message.includes('EACCES')) {
            warn('Root required. Run:'); nl();
            console.log(`      ${chalk.cyan(`sudo ${nodeBin} ${pm3Bin} startup`)}`); nl();
          } else fail(err.message);
        }
      } else {
        try {
          let crontab = ''; try { crontab = execSync('crontab -l 2>/dev/null', { encoding:'utf8' }); } catch {}
          const entry = `@reboot ${nodeBin} ${pm3Bin} list`;
          const legacyEntry = `@reboot ${nodeBin} ${pm3Bin} resurrect`;
          if (crontab.includes(entry) || crontab.includes(legacyEntry)) {
            warn('PM3 is already configured to start on boot  ' + chalk.dim('(crontab)'));
            hint('Run  pm3 unstartup  to remove it.');
          } else {
            execSync(`(crontab -l 2>/dev/null; echo "${entry}") | crontab -`);
            ok('Added PM3 to crontab (@reboot)');
            hint('Run  pm3 save  to persist your current processes.');
          }
        } catch (err) { fail('Failed to update crontab: ' + err.message); }
      }
    } else if (process.platform === 'darwin') {
      const plistName = 'com.pm3.daemon';
      const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${plistName}.plist`);
      if (fs.existsSync(plistPath)) {
        warn('PM3 is already configured to start on boot  ' + chalk.dim('(launchd)'));
        hint('Plist: ' + plistPath);
        hint('Run  pm3 unstartup  to remove it.');
        return;
      }
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${plistName}</string>\n  <key>ProgramArguments</key><array><string>${nodeBin}</string><string>${pm3Bin}</string><string>list</string></array>\n  <key>RunAtLoad</key><true/><key>KeepAlive</key><false/>\n  <key>StandardOutPath</key><string>${path.join(os.homedir(),'.pm3','launchd.log')}</string>\n  <key>StandardErrorPath</key><string>${path.join(os.homedir(),'.pm3','launchd-error.log')}</string>\n</dict></plist>\n`;
      try { fs.mkdirSync(path.dirname(plistPath), { recursive:true }); fs.writeFileSync(plistPath, plist, 'utf8'); execSync(`launchctl load ${plistPath}`); ok('launchd agent installed'); hint(`Plist: ${plistPath}`); hint('Run  pm3 save  to persist your current processes.'); } catch (err) { fail(err.message); }
    } else if (process.platform === 'win32') {
      const taskName = 'PM3ProcessManager';
      let taskExists = false;
      try { execSync(`schtasks /query /tn "${taskName}"`, { stdio:'ignore' }); taskExists = true; } catch {}
      if (taskExists) {
        warn('PM3 is already configured to start on boot  ' + chalk.dim('(Task Scheduler)'));
        hint(`Task: ${taskName}`);
        hint('Run  pm3 unstartup  to remove it.');
        return;
      }
      const cmd = `schtasks /create /tn "${taskName}" /tr "${nodeBin} ${pm3Bin} list" /sc onlogon /rl highest /f`;
      try { execSync(cmd, { stdio:'ignore' }); ok('Windows Task Scheduler entry created'); hint(`Task: ${taskName}  (triggers on logon)`); hint('Run  pm3 save  to persist your current processes.'); }
      catch { warn('Run as Administrator, or create the task manually:'); nl(); console.log(`      ${chalk.cyan(cmd)}`); nl(); }
    } else {
      warn(`Unsupported platform: ${process.platform}`);
      hint('Add this to your init system manually:');
      hint(chalk.cyan(`${nodeBin} ${pm3Bin} list`));
    }
  });

program
  .command('unstartup')
  .description('Remove PM3 from system startup')
  .action(() => {
    const { execSync } = require('child_process');
    const path = require('path'), os = require('os'), fs = require('fs');
    const pm3Bin = process.argv[1], nodeBin = process.execPath;
    if (process.platform === 'linux') {
      let hasSystemd = false;
      try { execSync('systemctl --version', { stdio:'ignore' }); hasSystemd = true; } catch {}
      if (hasSystemd) {
        if (process.getuid && process.getuid() !== 0) {
          warn('Root required. Run:'); nl();
          console.log(`      ${chalk.cyan(`sudo ${nodeBin} ${pm3Bin} unstartup`)}`); nl();
          return;
        }
        try { execSync('systemctl disable pm3', { stdio:'ignore' }); } catch {}
        try { fs.unlinkSync('/etc/systemd/system/pm3.service'); } catch {}
        try { execSync('systemctl daemon-reload', { stdio:'ignore' }); } catch {}
        ok('systemd service removed');
      } else {
        try {
          const entryNew = `@reboot ${nodeBin} ${pm3Bin} list`;
          const entryOld = `@reboot ${nodeBin} ${pm3Bin} resurrect`;
          const ct = execSync('crontab -l 2>/dev/null', { encoding:'utf8' });
          const filtered = ct.split('\n').filter(l => { const t = l.trim(); return t !== entryNew && t !== entryOld; }).join('\n');
          execSync(`printf '%s\n' ${JSON.stringify(filtered)} | crontab -`);
          ok('Removed PM3 from crontab');
        } catch (err) { fail('Failed to update crontab: ' + err.message); }
      }
    } else if (process.platform === 'darwin') {
      const pp = path.join(os.homedir(), 'Library/LaunchAgents/com.pm3.daemon.plist');
      try { execSync(`launchctl unload ${pp}`, { stdio:'ignore' }); fs.unlinkSync(pp); ok('launchd agent removed'); } catch { warn('No launchd agent found'); }
    } else if (process.platform === 'win32') {
      try { execSync('schtasks /delete /tn "PM3ProcessManager" /f', { stdio:'ignore' }); ok('Task Scheduler entry removed'); } catch { warn('No Task Scheduler entry found'); }
    }
  });

// ══════════════════════════════════════════════════════════════
//  pm3 doctor — check required / optional system tools
// ══════════════════════════════════════════════════════════════

program
  .command('doctor')
  .description('Check system tools required or used by PM3')
  .action(async () => {
    await ensureDaemon();
    const tools = await api('get', '/api/system/tools');
    const W = Math.min(termW(), 62);
    nl();
    console.log(boxTop('PM3 Doctor', 'tool check', W));
    console.log(boxBlank(W));

    function toolRow(icon, label, status, detail) {
      const labelPad = padR(label, 18);
      console.log(boxRow(`${icon}  ${labelPad}${status}`, W));
      if (detail) console.log(boxRow(`   ${chalk.dim(padR('', 18))}${chalk.dim(detail)}`, W));
    }

    const sm = tools.smartmontools;
    if (!sm) {
      toolRow(chalk.red('✕'), 'smartmontools', chalk.red('unknown'));
    } else if (!sm.installed) {
      toolRow(chalk.red('✕'), 'smartmontools', chalk.red('not installed'));
      if (sm.fixHint) {
        console.log(boxRow(`   ${chalk.dim('Fix: ')}${chalk.cyan(sm.fixHint)}`, W));
      }
    } else if (sm.needsPermission && !sm.canAccess) {
      toolRow(chalk.yellow('⚠'), 'smartmontools', chalk.yellow('needs permission'), sm.path || '');
      if (sm.fixHint) {
        console.log(boxRow(`   ${chalk.dim('Fix: ')}${chalk.cyan(sm.fixHint)}`, W));
      }
    } else if (sm.usesSudo) {
      toolRow(chalk.green('✓'), 'smartmontools', chalk.green('ok') + chalk.dim(' (via sudo)'), sm.path || '');
    } else {
      toolRow(chalk.green('✓'), 'smartmontools', chalk.green('ok'), sm.path || '');
    }

    console.log(boxBlank(W));
    console.log(boxBot(W));
    nl();
  });

// ══════════════════════════════════════════════════════════════
//  Help screen & parse
// ══════════════════════════════════════════════════════════════

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  const W = Math.min(termW(), 68);
  nl();
  console.log(boxTop('⚡ PM3', `v${VERSION}`, W));
  console.log(boxBlank(W));

  const section = (title) =>
    boxRow(chalk.dim('  ' + title.toUpperCase()), W);

  const cmd = (name, args, desc) =>
    boxRow('  ' + chalk.white(padR(name, 12)) + chalk.dim(padR(args, 18)) + chalk.dim(desc), W);

  console.log(section('Processes'));
  console.log(cmd('start',     '<script>',      'Start a process'));
  console.log(cmd('stop',      '<id|name>',     'Stop a process'));
  console.log(cmd('restart',   '<id|name>',     'Restart a process'));
  console.log(cmd('delete',    '<id|name>',     'Delete a process'));
  console.log(cmd('list, ls',  '',              'List all processes'));
  console.log(cmd('logs',      '<id|name>',     'View logs  (-f to follow)'));
  console.log(cmd('monit',     '',              'Live terminal monitor'));
  console.log(cmd('status',    '<id|name>',     'Process status detail'));
  console.log(cmd('info',      '<id|name>',     'Full JSON info'));
  console.log(boxBlank(W));
  console.log(section('Persistence'));
  console.log(cmd('save',      '',              'Save process list'));
  console.log(cmd('resurrect', '',              'Restore saved processes'));
  console.log(cmd('startup',   '',              'Configure system boot'));
  console.log(cmd('unstartup', '',              'Remove boot config'));
  console.log(cmd('config',    '[action]',      'View or edit configuration'));
  console.log(boxBlank(W));
  console.log(section('Daemon'));
  console.log(cmd('dashboard', '',              'Open web dashboard'));
  console.log(cmd('kill',      '',              'Stop the PM3 daemon'));
  console.log(boxBlank(W));
  console.log(boxDiv(W));
  console.log(boxRow(chalk.dim('  Examples'), W));
  console.log(boxRow('  ' + chalk.white('pm3 start app.js') + chalk.dim(' --name api'), W));
  console.log(boxRow('  ' + chalk.white('pm3 start npm') + chalk.dim(' --name web -- run start'), W));
  console.log(boxRow('  ' + chalk.white('pm3 logs api') + chalk.dim(' --follow'), W));
  console.log(boxRow('  ' + chalk.white('pm3 start worker.js') + chalk.dim(' --memory-limit 256'), W));
  console.log(boxBlank(W));
  console.log(boxBot(W));
  nl();
  hint('Run  pm3 <command> --help  for command-specific options.');
  nl();
}
