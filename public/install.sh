#!/usr/bin/env bash
# JiraTime laptop helper — one-time setup.
# Installs (or updates) JiraTime in ~/.local/share/jiratime and runs it in the background at every login,
# so https://jiratime-by-rocky.netlify.app can use git on this laptop (clone, commit, push, conflicts).
# It listens only on 127.0.0.1 and accepts browser requests only from the JiraTime website.
# Usage:  curl -fsSL https://jiratime-by-rocky.netlify.app/install.sh | bash
# Remove: curl -fsSL https://jiratime-by-rocky.netlify.app/install.sh | bash -s -- --uninstall
set -euo pipefail
DIR="${JIRATIME_DIR:-$HOME/.local/share/jiratime}"
REPO="https://github.com/Rocky-Saini/JiraTime.git"
PORT="${PORT:-9027}"
OS="$(uname -s)"
UNIT="$HOME/.config/systemd/user/jiratime.service"
PLIST="$HOME/Library/LaunchAgents/com.jiratime.helper.plist"

# an older manual setup on port 3000 started by hand is not touched; only the background helper is managed here
if [ "${1:-}" = "--uninstall" ]; then
  if [ "$OS" = "Linux" ]; then systemctl --user disable --now jiratime.service 2>/dev/null || true; rm -f "$UNIT"; systemctl --user daemon-reload 2>/dev/null || true; fi
  if [ "$OS" = "Darwin" ]; then launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; fi
  echo "✓ JiraTime helper stopped and removed from login. Files are still in $DIR (delete the folder if you want)."
  exit 0
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ '$1' is not installed. $2"; exit 1; }; }
need git "Install it first (Ubuntu: sudo apt install git · macOS: xcode-select --install)."
need node "Install Node.js 18 or newer from https://nodejs.org first."
NODE="$(command -v node)"
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 18 ] || { echo "✗ Node.js $MAJOR is too old — JiraTime needs Node.js 18 or newer."; exit 1; }

echo "→ Getting JiraTime into $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only -q; else mkdir -p "$(dirname "$DIR")"; git clone -q --depth 1 "$REPO" "$DIR"; fi

if [ "$OS" = "Linux" ]; then
  command -v systemctl >/dev/null 2>&1 || { echo "✗ This Linux has no systemd user services, so the JiraTime helper cannot start by itself."; exit 1; }
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=JiraTime laptop helper (git + GitLab for the JiraTime website)

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/server.js
Environment=PORT=$PORT
Environment=PATH=$(dirname "$NODE"):$HOME/.local/bin:/snap/bin:/usr/local/bin:/usr/bin:/bin
Environment=DISPLAY=${DISPLAY:-:0}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable jiratime.service >/dev/null 2>&1
  systemctl --user restart jiratime.service
elif [ "$OS" = "Darwin" ]; then
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jiratime.helper</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>$PORT</string><key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/jiratime-helper.log</string><key>StandardErrorPath</key><string>/tmp/jiratime-helper.log</string>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
else
  echo "✗ The JiraTime helper supports Linux and macOS for now."; exit 1
fi

sleep 2
if curl -s -m 3 "http://127.0.0.1:$PORT/api/gitlab/status" | grep -q '"api":2'; then
  echo "✓ Done. The JiraTime helper runs in the background and starts by itself at every login."
  echo "  Go back to JiraTime (https://jiratime-by-rocky.netlify.app) → GitLab → Local repos → “Connect this laptop”."
else
  echo "! The helper was installed but is not answering yet — wait 10 seconds and press “Connect this laptop” again."
  [ "$OS" = "Linux" ] && echo "  Status: systemctl --user status jiratime    Logs: journalctl --user -u jiratime -n 30"
fi
