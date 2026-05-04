#!/usr/bin/env bash
# ClipSync — macOS installer.
# Installs the hub and/or desktop client as LaunchAgents.
set -euo pipefail

ROLE="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LA_DIR="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"

if [[ -z "$ROLE" ]]; then
  echo "usage: install-mac.sh hub|client|both"
  exit 1
fi

mkdir -p "$LA_DIR"

install_hub() {
  echo "→ installing hub deps"
  (cd "$ROOT/hub" && npm install)
  cat > "$LA_DIR/com.clipsync.hub.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.clipsync.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/hub/src/server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/clipsync-hub.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/clipsync-hub.err</string>
</dict>
</plist>
EOF
  launchctl unload "$LA_DIR/com.clipsync.hub.plist" 2>/dev/null || true
  launchctl load   "$LA_DIR/com.clipsync.hub.plist"
  echo "✓ hub installed"
}

install_client() {
  echo "→ installing desktop-client deps"
  (cd "$ROOT/client-desktop" && npm install)
  echo
  echo "Now register this device. The hub must be running and you need a PIN."
  read -rp "Run registration now? [Y/n] " ans
  if [[ "${ans:-Y}" =~ ^[Yy] ]]; then
    (cd "$ROOT/client-desktop" && node src/register.js) || true
  fi
  cat > "$LA_DIR/com.clipsync.client.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.clipsync.client</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/client-desktop/src/main.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/clipsync-client.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/clipsync-client.err</string>
</dict>
</plist>
EOF
  launchctl unload "$LA_DIR/com.clipsync.client.plist" 2>/dev/null || true
  launchctl load   "$LA_DIR/com.clipsync.client.plist"
  echo "✓ desktop client installed"
}

case "$ROLE" in
  hub)    install_hub ;;
  client) install_client ;;
  both)   install_hub; install_client ;;
  *)      echo "unknown role: $ROLE"; exit 1 ;;
esac

echo "logs in ~/Library/Logs/clipsync-*.log"
