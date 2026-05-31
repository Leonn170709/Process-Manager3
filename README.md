# ⚡ PM3 — Process Manager

> A lightweight, modern Node.js process manager with a real-time Liquid Glass web dashboard and persistent issue tracking.

![Node.js](https://img.shields.io/badge/node-%3E%3D16-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)

---

## Features

- **Auto-restart** — configurable restart limits, crash detection, and memory-limit enforcement
- **Liquid Glass dashboard** — real-time web UI at `localhost:4926/dashboard`
- **Persistent issue tracking** — every crash is logged with full stack traces, survives restarts
- **Live log streaming** — WebSocket-based log tail in the dashboard and via `pm3 logs --follow`
- **Terminal monitor** — `pm3 monit` for a live process overview in the terminal
- **Process persistence** — `pm3 save` / `pm3 resurrect` to survive reboots
- **System boot integration** — systemd, launchd, and Windows Task Scheduler via `pm3 startup`
- **Zero-config daemon** — starts automatically on first use, runs detached in the background
- **CPU & memory detail modals** — click the CPU or Memory card in the System tab for live charts, per-core/thread breakdown, and a sortable process list that can switch between PM3-managed and all system-wide processes

---

## Installation

```bash
git clone https://github.com/Leonn170709/Process-Manager3.git
cd Process-Manager3
npm install
npm install -g .
```

---

## Quick Start

```bash
# Start a process
pm3 start app.js

# Give it a name
pm3 start server.js --name api

# Check what's running
pm3 list

# Stream logs live
pm3 logs api --follow

# Open the web dashboard
pm3 dashboard
```

The PM3 daemon starts automatically on first use and runs in the background.

---

## CLI Reference

### Commands

| Command | Description |
|---|---|
| `pm3 start <script>` | Start a process |
| `pm3 stop <id\|name>` | Stop a process |
| `pm3 restart <id\|name>` | Restart a process |
| `pm3 delete <id\|name>` | Delete a process |
| `pm3 list` / `pm3 ls` | List all processes |
| `pm3 logs <id\|name>` | View logs |
| `pm3 monit` | Live terminal monitor |
| `pm3 status <id\|name>` | Process status detail |
| `pm3 info <id\|name>` | Full JSON info |
| `pm3 save` | Save process list |
| `pm3 resurrect` | Restore saved processes |
| `pm3 dashboard` | Open web dashboard |
| `pm3 startup` | Configure system boot |
| `pm3 unstartup` | Remove boot config |
| `pm3 kill` | Stop the PM3 daemon |

### `pm3 start` options

```
--name <name>           Process name  (default: script filename)
--cwd <path>            Working directory
--env <KEY=VAL,...>     Environment variables
--watch                 Watch files, auto-restart on change
--no-autorestart        Disable crash auto-restart
--max-restarts <n>      Max restart attempts  (default: 15)
--memory-limit <mb>     Auto-restart if RAM exceeds this limit
```

### `pm3 logs` options

```
-n, --lines <n>         Number of lines to show  (default: 100)
-f, --follow            Follow output live
```

### Examples

```bash
# Simple script
pm3 start bot.js

# Named process with env vars
pm3 start index.js --name backend --env NODE_ENV=production,PORT=8080

# npm script
pm3 start npm --name web -- run start

# With working directory
pm3 start server.js --name api --cwd /var/www/app

# File watching for development
pm3 start dev.js --name dev --watch

# Memory-limited worker
pm3 start worker.js --name worker --memory-limit 256

# Follow logs
pm3 logs api --follow

# Show last 500 lines
pm3 logs api -n 500
```

---

## Web Dashboard

Open at `http://localhost:4926/dashboard` or run `pm3 dashboard`.

### Tabs

| Tab | What you get |
|---|---|
| **Processes** | Live status, CPU/RAM usage, restart count, uptime · per-process Start/Stop/Restart/Logs/Delete |
| **Logs** | Real-time log streaming via WebSocket with process selector |
| **Issues** | Crash history with severity levels, full error messages, and stack traces |
| **System** | CPU load, memory usage, network I/O with sparklines, disk usage, server uptime — click the CPU or Memory card for a detailed modal |
| **Config** | Edit all PM3 settings live via the dashboard |

### CPU detail modal

Click the **CPU Load** card in the System tab to open a detailed view:

- **3-minute sparkline** — rolling CPU history with tap-to-pin crosshair
- **Stat boxes** — User %, System %, Idle %, Load average (1m / 5m / 15m), logical core count
- **Per-core grid** — individual load bar for every logical thread. If the CPU has hyperthreading enabled (physical cores < logical threads), a **Thread / Core toggle** appears:
  - *Threads* — shows each logical CPU separately (Thread 0, Thread 1 …)
  - *Cores* — groups sibling threads by physical core, shows the averaged load, and displays a per-thread breakdown line (`T0: X% · T1: Y%`) inside each box
- **Process list** — sortable by CPU usage (highest / lowest). Toggle between **⚡ PM3** (managed processes only) and **🖥 System** (all running system processes, top 60). Click any row to expand it:
  - PM3 process: PID, status, uptime, restarts, net I/O, memory limit, script path — plus buttons to open the full Stats or Logs modal
  - System process: PID, parent PID, user, state, nice, priority, full command line

### Memory detail modal

Click the **Memory** card in the System tab to open a detailed view:

- **3-minute sparkline** — rolling memory % history
- **Segmented usage bar** — shows Used (active), Cached, and Buffers as distinct colour bands with a legend
- **Stat boxes** — Total RAM, Used (active), Available, Cached, Buffers, Swap used / total
- **Process list** — sortable by RAM usage. Same **⚡ PM3 / 🖥 System** toggle and click-to-expand rows as the CPU modal

---

## Issue Tracking

PM3 automatically records issues when:

- A process exits with a non-zero code
- `Error:`, `Exception`, or `FATAL` appears in stderr
- A process exceeds its max restart limit

Issues are **persistent** — stored in `~/.pm3/issues.json` and survive daemon restarts. They are never auto-deleted.

Each issue captures:
- Timestamp, process name & ID
- Severity (`warning` / `error` / `critical`)
- Error message and full stack trace
- Exit code and crash reason

---

## Persistence & Startup

```bash
# Save all currently running processes
pm3 save

# Restore them (e.g. after a reboot)
pm3 resurrect

# Wire up system boot integration automatically
pm3 startup

# Remove it
pm3 unstartup
```

With startup integration enabled, PM3 starts the daemon on boot and auto-resurrects saved processes by default.
You can disable this with `pm3 config set autoResurrect false`.

`pm3 startup` handles the right method per platform:

| Platform | Method |
|---|---|
| Linux (systemd) | Creates and enables `/etc/systemd/system/pm3.service` |
| Linux (no systemd) | Adds `@reboot` entry to crontab |
| macOS | Installs a launchd agent in `~/Library/LaunchAgents/` |
| Windows | Creates a Task Scheduler entry (run as Admin) |

---

## Configuration

PM3 stores all state in `~/.pm3/`:

```
~/.pm3/
├── processes.json        # Saved process list  (pm3 save)
├── issues.json           # Persistent issue log
├── daemon.pid            # Daemon PID file
├── daemon.log            # Daemon stdout
├── daemon-error.log      # Daemon stderr
└── logs/
    ├── <name>-out.log    # Process stdout
    └── <name>-err.log    # Process stderr
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PM3_HOME` | `~/.pm3` | Data directory |
| `PM3_DAEMON_PORT` | `4926` | Daemon/dashboard port |

### Config keys

| Key | Default | Description |
|---|---|---|
| `autoResurrect` | `true` | Automatically resurrect saved processes when the daemon starts |

---

## Architecture

```
pm3/
├── cli/index.js                  # CLI entry point (Commander.js)
├── daemon/
│   ├── index.js                  # Express + Socket.IO server
│   └── launcher.js               # Detached daemon spawner
├── core/processManager.js        # Process lifecycle (spawn/stop/restart)
├── issues/index.js               # Persistent error tracker
├── storage/index.js              # JSON file persistence layer
├── config/constants.js           # Ports, paths, status constants
└── dashboard/public/index.html   # Liquid Glass web UI
```

**Data flow:**
- CLI → HTTP REST API → Daemon
- Daemon → `child_process.spawn` → Managed processes
- Daemon → Socket.IO → Dashboard (real-time updates)
- All state → JSON files in `~/.pm3/`

---

## Troubleshooting

**Daemon won't start**
```bash
# Check the error log
cat ~/.pm3/daemon-error.log

# Remove a stale PID file and retry
rm ~/.pm3/daemon.pid
pm3 list
```

**Port already in use**
```bash
PM3_DAEMON_PORT=5000 pm3 start app.js
```

**Process won't stop**
```bash
pm3 delete myapp   # Force-removes the process entirely
```

**Lost processes after reboot**
```bash
pm3 save           # Always save before shutting down
pm3 config get autoResurrect   # Should be true
pm3 resurrect                  # Restore immediately
```

**Dashboard not loading**
```bash
pm3 list           # Ensures daemon is running
# Then open http://localhost:4926/dashboard
```

**`pm3 startup` says "Root required"** (Linux)
```bash
sudo pm3 startup
```

---

## FAQ

**How is PM3 different from PM2?**  
PM3 is a simpler, dependency-light alternative. It has a built-in Liquid Glass dashboard, persistent per-process issue tracking, and a single-file daemon that's easy to understand and modify.

**Does PM3 support clustering?**  
Not in v1.0 — single-process mode only. Cluster support is planned for a future release.

**Can I run npm scripts?**  
Yes: `pm3 start npm --name myapp -- run start`

**Where are logs stored?**  
`~/.pm3/logs/<name>-out.log` (stdout) and `~/.pm3/logs/<name>-err.log` (stderr).

**Is PM3 cross-platform?**  
Yes. All APIs used (`child_process`, `path`, `fs`) are cross-platform. Tested on Linux, macOS, and Windows.
