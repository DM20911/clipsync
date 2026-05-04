#!/usr/bin/env bash
# ClipSync — Linux installer (systemd user units).
set -euo pipefail

ROLE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"
NODE_BIN="$(command -v node)"

if [[ -z "$ROLE" ]]; then
  echo "usage: install-linux.sh hub|client|both"
  exit 1
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH"; exit 1
fi

mkdir -p "$SYSTEMD_DIR"

install_hub() {
  (cd "$ROOT/hub" && npm install)
  cat > "$SYSTEMD_DIR/clipsync-hub.service" <<EOF
[Unit]
Description=ClipSync Hub
After=network.target

[Service]
ExecStart=$NODE_BIN $ROOT/hub/src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now clipsync-hub.service
  echo "✓ hub installed (systemctl --user status clipsync-hub)"
}

install_client() {
  (cd "$ROOT/client-desktop" && npm install)
  read -rp "Register this device now? [Y/n] " ans
  if [[ "${ans:-Y}" =~ ^[Yy] ]]; then
    (cd "$ROOT/client-desktop" && node src/register.js) || true
  fi
  cat > "$SYSTEMD_DIR/clipsync-client.service" <<EOF
[Unit]
Description=ClipSync Desktop Client
After=network.target graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=$NODE_BIN $ROOT/client-desktop/src/main.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now clipsync-client.service
  echo "✓ desktop client installed"
  echo "   ensure xclip (X11) or wl-clipboard (Wayland) is available for image clipboard support"
}

case "$ROLE" in
  hub)    install_hub ;;
  client) install_client ;;
  both)   install_hub; install_client ;;
  *)      echo "unknown role: $ROLE"; exit 1 ;;
esac
