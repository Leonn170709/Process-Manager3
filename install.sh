#!/usr/bin/env bash
# Install PM3:  curl -fsSL https://raw.githubusercontent.com/Leonn170709/Process-Manager3/main/install.sh | bash
#
# Clones into $PM3_DIR (default ~/.local/share/pm3 - not ~/.pm3, that is the data folder) and links
# the global `pm3` to it. Running it again on an existing install just updates it via update.sh.
set -euo pipefail

main() {
  local dir="${PM3_DIR:-$HOME/.local/share/pm3}"

  for cmd in git node npm; do
    command -v "$cmd" >/dev/null || { echo "PM3 needs '$cmd' - install it first." >&2; exit 1; }
  done

  if [[ -d "$dir/.git" ]]; then
    echo "==> PM3 already installed in $dir - updating"
    exec "$dir/update.sh"
  fi

  echo "==> Cloning PM3 into $dir"
  git clone --depth 1 https://github.com/Leonn170709/Process-Manager3.git "$dir"
  cd "$dir"
  echo "==> Installing dependencies"
  npm ci --no-audit --no-fund
  echo "==> Linking the pm3 command"
  npm install -g . --no-audit --no-fund ||
    { echo "Global install failed - rerun 'sudo npm install -g .' in $dir." >&2; exit 1; }
  echo "==> Done - try 'pm3 list'"
}

main "$@"
