# PM3 — Modern Node.js Process Manager

A production-grade process manager for Node.js applications, inspired by PM2. Features a daemon-based architecture, persistent process management, real-time web dashboard with Liquid Glass UI, and automatic issue/error tracking.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/yourorg/pm3.git
cd pm3

# Install dependencies
npm install

# Install globally (makes pm3 CLI available system-wide)
npm install -g .
```

---

## Quick Start

```bash
# Start a process
pm3 start app.js

# Start with a name
pm3 start server.js --name api

# Start npm script
pm3 start npm --name website -- run start

# List all processes
pm3 list

# View logs
pm3 logs api

# Open web dashboard
pm3 dashboard
```

The PM3 daemon starts automatically on first use and runs in the background.

---

## CLI Commands

| Command | Description |
|---|---|
| `pm3 start <script>` | Start a process |
| `pm3 stop <id\|name>` | Stop a process |
| `pm3 restart <id\|name>` | Restart a process |
| `pm3 delete <id\|name>` | Delete a process |
| `pm3 logs <id\|name>` | View process logs |
| `pm3 list` | List all processes |
| `pm3 monit` | Terminal live monitor |
| `pm3 status <id\|name>` | Show process status |
| `pm3 info <id\|name>` | Full process info (JSON) |
| `pm3 save` | Save process list for resurrect |
| `pm3 resurrect` | Restore saved processes |
| `pm3 dashboard` | Open web dashboard |
| `pm3 kill` | Stop the PM3 daemon |
| `pm3 help` | Show help |

### Start Options

```bash
pm3 start <script> [options]

Options:
  --name <name>         Process name (default: pm3-<id>)
  --cwd <path>          Working directory
  --env <vars>          Env vars: KEY=VAL,KEY2=VAL2
  --watch               Watch files for changes, auto-restart
  --no-autorestart      Disable crash auto-restart
  --max-restarts <n>    Maximum restart attempts (default: 15)
  --memory-limit <mb>   Restart if RAM exceeds this limit
```

### Examples

```bash
# Simple node script
pm3 start bot.js

# Named process
pm3 start server.js --name api

# With env vars and cwd
pm3 start index.js --name backend --cwd /var/www/app --env NODE_ENV=production,PORT=8080

# npm script
pm3 start npm --name website -- run start

# With file watching
pm3 start dev.js --name dev --watch

# With memory limit
pm3 start worker.js --name worker --memory-limit 256

# Follow logs live
pm3 logs api --follow

# Last 500 lines
pm3 logs api -n 500
```

---

## Web Dashboard

```
http://localhost:4926/dashboard
```

### Features

- **Processes tab** — live status, CPU/RAM, restart count, uptime, start/stop/restart/delete buttons
- **Logs tab** — real-time log streaming via WebSocket with process selector
- **Issues tab** — persistent crash/error tracking with full stack traces
- **System tab** — CPU load, memory usage, disk usage, server uptime

### Starting the dashboard

```bash
pm3 dashboard
```

Or open `http://localhost:4926/dashboard` directly in a browser.

---

## Issue / Error Tracking

PM3 automatically captures and stores issues when:
- A process crashes (non-zero exit code)
- Errors are detected in stderr (Error:, Exception, FATAL)
- A process exceeds its restart limit

Issues are **persistent** — they survive daemon restarts and are stored in `~/.pm3/issues.json`.

### Issue fields
- Timestamp
- Process name & ID
- Error message
- Full stack trace / stderr logs
- Exit code
- Severity (warning / error / critical)
- Crash reason

### Managing issues
- View all in the **Issues** tab of the dashboard
- Click an issue to see full details and stack trace
- Delete individual issues with ✕
- **Clear All** button to wipe the list
- Issues are never auto-deleted

---

## Persistence

```bash
# Save current process list
pm3 save

# Restore on next daemon start
pm3 resurrect
```

Processes marked as `running` at save time will be automatically restarted by `resurrect`.

For **auto-start on system boot**, add to your system's startup (systemd/crontab):

```bash
# crontab -e
@reboot /usr/bin/pm3 resurrect
```

Or create a systemd service:

```ini
# /etc/systemd/system/pm3.service
[Unit]
Description=PM3 Process Manager
After=network.target

[Service]
Type=forking
User=youruser
ExecStart=/usr/bin/pm3 resurrect
ExecStop=/usr/bin/pm3 kill
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable pm3
sudo systemctl start pm3
```

---

## Configuration

PM3 stores all data in `~/.pm3/`:

```
~/.pm3/
├── processes.json    # Persistent process list
├── issues.json       # Persistent issue log
├── daemon.pid        # Daemon PID
├── daemon.log        # Daemon stdout
├── daemon-error.log  # Daemon stderr
└── logs/
    ├── <name>-out.log
    └── <name>-err.log
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PM3_HOME` | `~/.pm3` | Data directory |
| `PM3_DAEMON_PORT` | `4926` | Daemon/dashboard port |

---

## Architecture

```
pm3/
├── cli/              # Commander.js CLI entry point
│   └── index.js
├── daemon/
│   ├── index.js      # Express + Socket.IO daemon server
│   └── launcher.js   # Detached daemon spawner
├── core/
│   └── processManager.js  # Process lifecycle (spawn/stop/restart)
├── issues/
│   └── index.js      # Persistent issue tracker
├── storage/
│   └── index.js      # JSON file persistence layer
├── config/
│   └── constants.js  # Ports, paths, status constants
├── dashboard/
│   └── public/
│       └── index.html  # Liquid Glass web UI
└── package.json
```

**Architecture overview:**
- CLI connects to daemon via HTTP REST API
- Daemon manages all processes as child_process spawns
- Socket.IO pushes real-time updates to dashboard
- All state persisted as JSON in `~/.pm3/`
- Issues stored separately and never auto-cleared

---

## Troubleshooting

**Daemon won't start**
```bash
# Check daemon log
cat ~/.pm3/daemon-error.log

# Kill stale PID and retry
rm ~/.pm3/daemon.pid
pm3 list
```

**Port already in use**
```bash
# Use a different port
PM3_DAEMON_PORT=5000 pm3 start app.js
```

**Process won't stop**
```bash
# Force stop by name
pm3 stop myapp

# Or delete it entirely
pm3 delete myapp
```

**Lost process list after restart**
```bash
# Always save before shutting down
pm3 save

# Restore
pm3 resurrect
```

**Dashboard not loading**
Make sure the daemon is running:
```bash
pm3 list  # auto-starts daemon
# Then visit http://localhost:4926/dashboard
```

---

## Development Setup

```bash
git clone https://github.com/yourorg/pm3.git
cd pm3
npm install

# Run daemon directly (foreground, with logs)
node daemon/index.js

# In another terminal, test CLI
node cli/index.js list
node cli/index.js start test/app.js --name test
```

---

## FAQ

**Q: Is PM3 compatible with Windows?**  
A: Yes. `child_process.spawn` and all Node.js APIs used are cross-platform. File paths use `path.join`.

**Q: Can I run multiple node versions?**  
A: Yes — `pm3 start npm -- run start` uses the system npm; you can specify full paths.

**Q: How is PM3 different from PM2?**  
A: PM3 is a modern, dependency-light alternative with a built-in Liquid Glass dashboard, persistent issue tracking, and simpler architecture (single-file daemon).

**Q: Does PM3 support clustering?**  
A: Not in v1.0. Single-process mode only. Cluster support is planned.

**Q: Where are logs stored?**  
A: `~/.pm3/logs/<name>-out.log` and `~/.pm3/logs/<name>-err.log`.
