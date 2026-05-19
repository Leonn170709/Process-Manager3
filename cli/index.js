#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const chalk = require('chalk');
const axios = require('axios');
const Table = require('cli-table3');

const { DAEMON_BASE_URL, DASHBOARD_PORT } = require('../config/constants');
const { startDaemon, isDaemonRunning } = require('../daemon/launcher');

program.name('pm3').description('Modern Node.js Process Manager').version('1.0.0');

// Ensure daemon is running, start if not
async function ensureDaemon() {
  const running = await isDaemonRunning();
  if (!running) {
    process.stdout.write(chalk.yellow('Starting PM3 daemon... '));
    const result = await startDaemon();
    if (result.error) {
      console.log(chalk.red('FAILED'));
      console.error(chalk.red(result.error));
      process.exit(1);
    }
    console.log(chalk.green('OK'));
  }
}

async function api(method, path, data) {
  try {
    const res = await axios({ method, url: `${DAEMON_BASE_URL}${path}`, data, timeout: 5000 });
    return res.data;
  } catch (err) {
    if (err.response) return err.response.data;
    console.error(chalk.red(`Daemon not reachable: ${err.message}`));
    process.exit(1);
  }
}

// Status color helper
function statusColor(status) {
  switch (status) {
    case 'running': return chalk.green(status);
    case 'stopped': return chalk.gray(status);
    case 'crashed': return chalk.red(status);
    case 'restarting': return chalk.yellow(status);
    case 'starting': return chalk.cyan(status);
    default: return chalk.white(status);
  }
}

function formatUptime(seconds) {
  if (!seconds) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatBytes(mb) {
  if (!mb) return '-';
  return `${mb} MB`;
}

// --- COMMANDS ---

program
  .command('start <script>')
  .description('Start a process')
  .option('--name <name>', 'Process name')
  .option('--cwd <path>', 'Working directory')
  .option('--env <vars>', 'Environment variables (KEY=VAL,KEY2=VAL2)')
  .option('--watch', 'Watch for file changes')
  .option('--no-autorestart', 'Disable auto-restart on crash')
  .option('--max-restarts <n>', 'Max restart attempts', parseInt)
  .option('--memory-limit <mb>', 'Memory limit in MB', parseInt)
  .argument('[args...]', 'Extra arguments passed to the process')
  .action(async (script, args, opts) => {
    await ensureDaemon();
    const env = {};
    if (opts.env) {
      opts.env.split(',').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k) env[k.trim()] = (v || '').trim();
      });
    }
    const config = {
      script,
      name: opts.name,
      cwd: opts.cwd,
      env,
      args,
      watch: opts.watch,
      autorestart: opts.autorestart !== false,
      maxRestarts: opts.maxRestarts,
      memoryLimit: opts.memoryLimit,
    };
    const result = await api('post', '/api/processes/start', config);
    if (result.error) return console.error(chalk.red(result.error));
    console.log(chalk.green(`✓ Process "${result.name}" started (ID: ${result.id}, PID: ${result.pid})`));
  });

program
  .command('stop <id>')
  .description('Stop a process')
  .action(async (id) => {
    await ensureDaemon();
    const result = await api('post', `/api/processes/${id}/stop`);
    if (result.error) return console.error(chalk.red(result.error));
    console.log(chalk.yellow(`✓ Process "${result.name}" stopped`));
  });

program
  .command('restart <id>')
  .description('Restart a process')
  .action(async (id) => {
    await ensureDaemon();
    const result = await api('post', `/api/processes/${id}/restart`);
    if (result.error) return console.error(chalk.red(result.error));
    console.log(chalk.cyan(`✓ Process "${result.name}" restarting...`));
  });

program
  .command('delete <id>')
  .description('Delete a process')
  .action(async (id) => {
    await ensureDaemon();
    const result = await api('delete', `/api/processes/${id}`);
    if (result.error) return console.error(chalk.red(result.error));
    console.log(chalk.red(`✓ Process "${result.name}" deleted`));
  });

program
  .command('list')
  .alias('ls')
  .description('List all processes')
  .action(async () => {
    await ensureDaemon();
    const procs = await api('get', '/api/processes');
    const list = Object.values(procs);

    if (!list.length) {
      console.log(chalk.gray('No processes found. Use: pm3 start <script>'));
      return;
    }

    const table = new Table({
      head: ['ID', 'Name', 'Status', 'PID', 'CPU', 'Memory', 'Restarts', 'Uptime'].map(h => chalk.cyan(h)),
      style: { head: [], border: [] },
    });

    list.forEach(p => {
      table.push([
        p.id,
        chalk.white(p.name),
        statusColor(p.status),
        p.pid || '-',
        p.cpu ? `${p.cpu}%` : '-',
        formatBytes(p.memory),
        p.restartCount,
        formatUptime(p.uptime),
      ]);
    });

    console.log(table.toString());
  });

program
  .command('logs <id>')
  .description('View logs for a process')
  .option('-n, --lines <n>', 'Number of lines', '100')
  .option('-f, --follow', 'Follow log output (live)')
  .action(async (id, opts) => {
    await ensureDaemon();
    const result = await api('get', `/api/logs/${id}?lines=${opts.lines}`);
    if (result.error) return console.error(chalk.red(result.error));

    const lines = result.combined.split('\n').filter(Boolean);
    lines.forEach(line => {
      if (line.includes('[ERR]')) {
        console.log(chalk.red(line));
      } else {
        console.log(line);
      }
    });

    if (opts.follow) {
      const net = require('net');
      const io = require('socket.io-client');
      const socket = io(DAEMON_BASE_URL);
      socket.on('log', data => {
        if (data.name === id || data.name === result.name) {
          if (data.type === 'err') console.log(chalk.red(data.line));
          else console.log(data.line);
        }
      });
      console.log(chalk.gray('\n--- Following logs (Ctrl+C to stop) ---'));
    }
  });

program
  .command('status <id>')
  .description('Show process status')
  .action(async (id) => {
    await ensureDaemon();
    const result = await api('get', `/api/processes/${id}`);
    if (result.error) return console.error(chalk.red(result.error));
    console.log(`${chalk.cyan('Name:')}     ${result.name}`);
    console.log(`${chalk.cyan('Status:')}   ${statusColor(result.status)}`);
    console.log(`${chalk.cyan('PID:')}      ${result.pid || '-'}`);
    console.log(`${chalk.cyan('CPU:')}      ${result.cpu || 0}%`);
    console.log(`${chalk.cyan('Memory:')}   ${formatBytes(result.memory)}`);
    console.log(`${chalk.cyan('Restarts:')} ${result.restartCount}`);
    console.log(`${chalk.cyan('Uptime:')}   ${formatUptime(result.uptime)}`);
    console.log(`${chalk.cyan('Started:')}  ${result.startTime}`);
  });

program
  .command('info <id>')
  .description('Detailed process info')
  .action(async (id) => {
    await ensureDaemon();
    const result = await api('get', `/api/processes/${id}`);
    if (result.error) return console.error(chalk.red(result.error));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('save')
  .description('Save current process list for resurrect')
  .action(async () => {
    await ensureDaemon();
    const result = await api('post', '/api/save');
    console.log(chalk.green(`✓ Saved ${result.saved} processes`));
  });

program
  .command('resurrect')
  .description('Restore saved processes')
  .action(async () => {
    await ensureDaemon();
    const procs = await api('get', '/api/processes');
    const list = Object.values(procs).filter(p => p.status === 'running');
    console.log(chalk.green(`✓ Resurrected ${list.length} processes`));
  });

program
  .command('dashboard')
  .description('Open web dashboard')
  .action(async () => {
    await ensureDaemon();
    const url = `${DAEMON_BASE_URL}/dashboard`;
    console.log(chalk.cyan(`Dashboard: ${url}`));
    const open = (url) => {
      const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      require('child_process').exec(`${cmd} ${url}`);
    };
    try { open(url); } catch {}
  });

program
  .command('monit')
  .description('Live monitoring in terminal')
  .action(async () => {
    await ensureDaemon();
    const readline = require('readline');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const render = async () => {
      console.clear();
      console.log(chalk.bold.cyan('PM3 Monitor') + chalk.gray(' — press q to quit\n'));
      const procs = await api('get', '/api/processes');
      const sys = await api('get', '/api/system');
      const list = Object.values(procs);

      console.log(chalk.bold('System'));
      console.log(`CPU: ${chalk.yellow(sys.cpu + '%')}  RAM: ${chalk.yellow(sys.memory.percent + '%')}  Uptime: ${formatUptime(sys.uptime)}\n`);

      const table = new Table({
        head: ['ID', 'Name', 'Status', 'CPU', 'RAM', 'Restarts'].map(h => chalk.cyan(h)),
        style: { compact: true },
      });
      list.forEach(p => table.push([
        p.id, p.name, statusColor(p.status),
        p.cpu ? `${p.cpu}%` : '-',
        formatBytes(p.memory),
        p.restartCount,
      ]));
      console.log(table.toString());
    };

    await render();
    const interval = setInterval(render, 2000);

    process.stdin.on('keypress', (str, key) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        clearInterval(interval);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
      }
    });
  });

program
  .command('kill')
  .description('Kill the PM3 daemon')
  .action(async () => {
    const { stopDaemon } = require('../daemon/launcher');
    const result = await stopDaemon();
    if (result.error) return console.error(chalk.red(result.error));
    console.log(chalk.red('✓ PM3 daemon stopped'));
  });

program.parse(process.argv);
if (!process.argv.slice(2).length) program.outputHelp();
