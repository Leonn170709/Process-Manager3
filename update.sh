#!/usr/bin/env bash
# Update PM3 to the latest version on GitHub:  ./update.sh [--no-restart]
#
# Pulls the new files, installs dependencies only when they changed, makes the CLI executable,
# and restarts a running daemon so it runs the new code. Managed processes go down with it and
# come back with the new daemon, the same as `pm3 kill` followed by `pm3 resurrect`.
set -euo pipefail

# Everything runs inside main so bash has read the whole script before `git pull` can replace
# this very file underneath it.
main() {
  cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

  local restart=1
  [[ "${1:-}" == "--no-restart" ]] && restart=0

  if [[ ! -d .git ]]; then
    echo "Not a git clone - install with: git clone https://github.com/Leonn170709/Process-Manager3.git" >&2
    exit 1
  fi

  local before
  before=$(git rev-parse HEAD)
  echo "==> Pulling the latest version"
  # --ff-only never merges or overwrites local edits; git stops with its own message instead
  git pull --ff-only
  local changed=0
  [[ "$(git rev-parse HEAD)" != "$before" ]] && changed=1

  # npm ci, not npm install: install may rewrite package-lock.json, and that local edit would
  # make the next pull refuse to run.
  if [[ ! -d node_modules ]] || ! git diff --quiet "$before" HEAD -- package.json package-lock.json; then
    echo "==> Installing dependencies"
    npm ci --no-audit --no-fund
  fi

  chmod +x cli/index.js update.sh

  # `npm install -g .` makes the global pm3 a symlink to this folder, so it is already current.
  # One that resolves elsewhere is a separate copy this script does not touch.
  local bin
  if bin=$(command -v pm3) && [[ "$(readlink -f "$bin")" != "$PWD/cli/index.js" ]]; then
    echo "Note: 'pm3' on your PATH ($bin) is not this folder - run 'npm install -g .' here to switch to it." >&2
  fi

  if (( changed && restart )) &&
     node -e "require('./daemon/launcher').isDaemonRunning().then(up => process.exit(up ? 0 : 1))"; then
    echo "==> Restarting the daemon"
    node cli/index.js kill
    node cli/index.js resurrect
  elif (( changed )); then
    echo "Daemon not restarted - run 'pm3 kill && pm3 resurrect' to load the new version."
  fi

  if (( changed )); then
    echo "==> Updated to $(git rev-parse --short HEAD)"
  else
    echo "==> Already up to date ($(git rev-parse --short HEAD))"
  fi
}

main "$@"
exit
