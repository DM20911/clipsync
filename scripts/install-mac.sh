#!/usr/bin/env bash
# ClipSync — macOS installer.
# Usage: install-mac.sh hub|client|both
#  When installing client, asks: tray (Electron menu bar) or daemon (LaunchAgent).
set -euo pipefail

ROLE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LA_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.config/clipsync/client"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
TPL_DIR="$ROOT/scripts/templates"

if [[ -z "$ROLE" ]]; then
  echo "usage: install-mac.sh hub|client|both"
  exit 1
fi
if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node.js 18+ required (https://nodejs.org)"
  exit 1
fi

mkdir -p "$LA_DIR" "$LOG_DIR"

install_hub() {
  echo "→ installing hub deps"
  (cd "$ROOT/hub" && npm install)
  cat > "$LA_DIR/com.clipsync.hub.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.clipsync.hub</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$ROOT/hub/src/server.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/clipsync-hub.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/clipsync-hub.err</string>
</dict></plist>
EOF
  launchctl unload "$LA_DIR/com.clipsync.hub.plist" 2>/dev/null || true
  launchctl load   "$LA_DIR/com.clipsync.hub.plist"
  echo "✓ hub installed"
  echo "  Watch admin token: tail -n 30 ~/Library/Logs/clipsync-hub.log"
}

install_client_daemon() {
  local plist="$LA_DIR/com.clipsync.daemon.plist"
  sed -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__INSTALL_DIR__|$ROOT|g" \
      -e "s|__HOME__|$HOME|g" \
      "$TPL_DIR/com.clipsync.daemon.plist.tmpl" > "$plist"
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load   "$plist"
  echo "✓ daemon mode installed (LaunchAgent)"
  echo "  Logs: tail -f $LOG_DIR/daemon.log"
}

install_client_tray() {
  echo "→ installing tray (Electron) deps — first run is slow (~80 MB)"
  (cd "$ROOT/client-tray" && npm install)
  echo "✓ tray mode ready"
  echo "  Start now: $ROOT/bin/clipsync switch tray"
  echo "  In the tray menu, enable 'Auto-start at login' to start on boot."
}

install_client() {
  echo "→ installing core client deps"
  (cd "$ROOT/client-desktop" && npm install)
  echo
  echo "Cómo quieres correr ClipSync?"
  echo "  1) Tray app (recomendado — ícono en menu bar, click para ver estado)"
  echo "  2) Daemon en background (sin UI, solo logs)"
  read -rp "Modo [1]: " choice
  choice="${choice:-1}"

  echo
  read -rp "Registrar dispositivo ahora? [Y/n] " ans
  if [[ "${ans:-Y}" =~ ^[Yy] ]]; then
    (cd "$ROOT/client-desktop" && node src/register.js) || true
  fi

  case "$choice" in
    1) install_client_tray ;;
    2) install_client_daemon ;;
    *) echo "invalid choice"; exit 1 ;;
  esac
  echo
  echo "Para cambiar de modo después: $ROOT/bin/clipsync switch tray|daemon"
}

case "$ROLE" in
  hub)    install_hub ;;
  client) install_client ;;
  both)   install_hub; install_client ;;
  *)      echo "unknown role: $ROLE"; exit 1 ;;
esac
