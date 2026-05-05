#!/usr/bin/env bash
# ClipSync — Linux installer.
# Usage: install-linux.sh hub|client|both
#   When installing client, asks: tray (Electron) or daemon (systemd).
set -euo pipefail

ROLE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
LOG_DIR="$HOME/.config/clipsync/client"
NODE_BIN="$(command -v node || true)"
TPL_DIR="$ROOT/scripts/templates"

if [[ -z "$ROLE" ]]; then
  echo "usage: install-linux.sh hub|client|both"
  exit 1
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js 18+ required"
  exit 1
fi

if [[ "$ROLE" != "hub" ]]; then
  if ! command -v xclip >/dev/null && ! command -v wl-paste >/dev/null; then
    echo "Installing clipboard tools (sudo required)..."
    if   command -v apt    >/dev/null; then sudo apt    install -y xclip wl-clipboard
    elif command -v dnf    >/dev/null; then sudo dnf    install -y xclip wl-clipboard
    elif command -v pacman >/dev/null; then sudo pacman -S --noconfirm xclip wl-clipboard
    fi
  fi
fi

mkdir -p "$UNIT_DIR" "$LOG_DIR"

install_hub() {
  (cd "$ROOT/hub" && npm install)
  cat > "$UNIT_DIR/clipsync-hub.service" <<EOF
[Unit]
Description=ClipSync hub
After=network.target

[Service]
ExecStart=$NODE_BIN $ROOT/hub/src/server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:%h/.config/clipsync/hub/hub.log
StandardError=append:%h/.config/clipsync/hub/hub.err

[Install]
WantedBy=default.target
EOF
  mkdir -p "$HOME/.config/clipsync/hub"
  systemctl --user daemon-reload
  systemctl --user enable --now clipsync-hub.service
  echo "✓ hub installed"
  echo "  Watch admin token: journalctl --user -u clipsync-hub -n 30"
}

install_client_daemon() {
  local unit="$UNIT_DIR/clipsync-client.service"
  sed -e "s|__NODE__|$NODE_BIN|g" \
      -e "s|__INSTALL_DIR__|$ROOT|g" \
      "$TPL_DIR/clipsync.service.tmpl" > "$unit"
  systemctl --user daemon-reload
  systemctl --user enable --now clipsync-client.service
  echo "✓ daemon mode installed (systemd)"
  echo "  Logs: journalctl --user -u clipsync-client -f"
}

install_client_tray() {
  echo "→ installing tray (Electron) deps — first run is slow (~80 MB)"
  (cd "$ROOT/client-tray" && npm install)
  echo "✓ tray mode ready"
  echo "  Start now: $ROOT/bin/clipsync switch tray"
  echo "  Enable 'Auto-start at login' from the tray menu."
}

install_client() {
  echo "→ installing core client deps"
  (cd "$ROOT/client-desktop" && npm install)
  echo
  echo "Cómo quieres correr ClipSync?"
  echo "  1) Tray app (recomendado)"
  echo "  2) Daemon en background (systemd)"
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
