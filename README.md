# ClipSync

Local-network clipboard synchronization. Copy on one device, paste on any other registered device on the same LAN. Text, URLs, and images. End-to-end AES-256-GCM. No cloud.

```
                    Linux
                      ●
                      │
         macOS  ●─────┤─────●  Windows
                      │
                    [HUB]            ←  Node.js + WSS + SQLite
                      │
            iOS  ●────┴────●  Android
                  (PWA)       (PWA)
```

## Components

| Path             | What it is                                                            |
|------------------|-----------------------------------------------------------------------|
| `hub/`           | Central server. WSS broker, mDNS announcer, admin dashboard, PWA host |
| `client-desktop/`| Daemon for macOS / Linux / Windows. Watches the OS clipboard          |
| `client-pwa/`    | Mobile-friendly PWA (iOS Safari, Android Chrome) served by the hub    |
| `shared/`        | Shared protocol constants (op codes, limits, subnet checks)           |
| `scripts/`       | OS-specific install scripts                                           |

## Requirements

- Node.js ≥ 20 on every device that runs the hub or desktop client
- All devices on the same LAN (private subnets only — `192.168/16`, `10/8`, `172.16/12`)
- Linux clients: `xclip` (X11) or `wl-clipboard` (Wayland) for image-clipboard support
- A modern browser for the PWA (Chrome / Edge / Safari / Firefox)

## Quick start

### 1. Pick a device for the hub and start it

```bash
cd hub
npm install
npm start
```

Output prints the URLs:

```
Dashboard:  https://localhost:5679/admin
PWA:        https://localhost:5679/
WSS:        wss://localhost:5678
```

The hub auto-generates a self-signed TLS cert on first run and announces itself via mDNS as `_clipsync._tcp`.

### 2. Open the dashboard

`https://<hub-ip>:5679/admin` — accept the self-signed cert.

Click **+ register new device**. A 6-digit PIN and a QR code appear (PIN expires in 5 min).

### 3. Register a desktop device

On any machine that should sync:

```bash
cd client-desktop
npm install
npm run register     # finds the hub via mDNS, asks for the PIN
npm start            # starts the daemon
```

That's it — copy something on either machine; it appears on the other.

### 4. Register a mobile device (PWA)

1. On the phone, open `https://<hub-ip>:5679/` and accept the cert
2. From the dashboard, generate a PIN
3. In the PWA, paste the hub URL (`wss://<hub-ip>:5678`) and the PIN, tap **register**
4. Tap **Add to Home Screen** to install the PWA

iOS note: Safari does not allow PWAs to read the clipboard automatically. Use the **paste from clipboard** button in the PWA, or rely on the **Share Sheet** (the PWA registers as a share target).

### 5. Install as a system service (optional)

```bash
# macOS — installs LaunchAgent(s)
./scripts/install-mac.sh hub        # only the hub
./scripts/install-mac.sh client     # only the daemon
./scripts/install-mac.sh both

# Linux (systemd user units)
./scripts/install-linux.sh both

# Windows (PowerShell, Task Scheduler at logon)
.\scripts\install-win.ps1 -Role both
```

## Architecture

### Topology

Hub-and-spoke. One hub (Node.js); every other device is a client over WSS. The hub:

- terminates WSS for all clients
- broadcasts incoming clips to every other authenticated client
- persists the last 50 clips for 24 h in SQLite (encrypted payloads only — the hub never sees plaintext)
- announces itself via mDNS so clients discover it without manual IPs

### Encryption

- Hub generates a single **network key** on first boot (random 64-byte secret, stored in `meta`)
- On registration, every device receives this network key
- Clipboard payloads are encrypted client-side with **AES-256-GCM**, key derived from the network key via **PBKDF2 (100k iterations, SHA-256, random per-message salt)**
- The hub stores and forwards the encrypted base64 blobs as-is. It can read metadata (type, size, mime, checksum) but not contents.
- Layout: `salt(16) | iv(12) | tag(16) | ciphertext`

### Authentication

- First connection from a new device requires a **6-digit PIN** issued from the hub UI (single-use, 5-min TTL)
- Hub then issues a **JWT (HS256, 30-day expiry)** signed with a per-installation server secret
- Server secret rotates automatically every 30 days
- Tokens carry a `jti` and can be individually revoked from the dashboard

### Network isolation

- The hub rejects WS / HTTP connections from any IP outside the configured private CIDR list (`192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `127/8`)
- Self-signed TLS cert covers `localhost`, the hostname, and every local non-loopback IPv4

### Loop prevention

- Each client hashes (SHA-256) outgoing clipboard contents and ignores incoming broadcasts whose hash matches
- After writing a remote clip to the local clipboard, the source hash is suppressed for 1.5 s

## WebSocket protocol

All messages are JSON. Connect to `wss://<hub>:<port>` then:

```jsonc
// client → hub
{ "op": "auth",  "token": "<jwt>" }
{ "op": "register", "pin": "123456", "name": "...", "os": "darwin", "fingerprint": null }
{ "op": "push", "clip": { "id": "...", "type": "text|image|url|file",
                          "mime": "...", "size": 1234, "timestamp": 0,
                          "checksum": "sha256...", "payload_b64": "..." } }
{ "op": "ping" }
{ "op": "history_request", "limit": 10 }

// hub → client
{ "op": "auth_ok",   "device_id": "...", "devices": [...] }
{ "op": "auth_fail", "reason": "..." }
{ "op": "register_ok", "device_id": "...", "token": "<network-key>", "jwt": "..." }
{ "op": "broadcast", "clip": { ... } }
{ "op": "history",   "items": [ ... ] }
{ "op": "device_joined", "device": { "id": "...", "name": "...", "os": "..." } }
{ "op": "device_left",   "device_id": "..." }
{ "op": "pong", "t": 0 }
```

## Limits

| Type      | Max size |
|-----------|----------|
| Text / URL| 1 MB     |
| Image     | 10 MB    |
| File      | 50 MB    |

History: 50 items / 24 h (configurable via env vars).

## Configuration

Copy `.env.example` to `.env` and edit, or export the variables in your shell. See the file for the full list.

## Tests

```bash
cd hub
npm test
```

Covers `crypto.js`, `auth.js`, and the shared `protocol.js`.

## Troubleshooting

- **Self-signed cert warning** in the browser. Expected. Accept once per device.
- **mDNS fails on Windows.** Some firewalls block UDP 5353. Either allow it, or pass the hub URL manually to `clipsync register`.
- **iOS PWA does not read the clipboard.** Browser security. Use the `paste from clipboard` button or the share sheet.
- **Linux: image clipboard does nothing.** Install `xclip` (X11) or `wl-clipboard` (Wayland).
- **Hub is reachable but client never connects.** Check the IP is in a private CIDR; the hub rejects public IPs by design.
- **Logs.** Hub: `~/.config/clipsync/hub/hub.log` (rotates at 10 MB × 3). LaunchAgent: `~/Library/Logs/clipsync-*.log`.

## Security notes

- The network key is shared by all registered devices; revoking a single device does NOT rotate the key. To rotate, delete `meta.network_key` from the SQLite DB and re-register every device.
- The hub never logs payload contents — only metadata (type, size, source, timestamp).
- TLS is self-signed and intended for LAN use only. Do not expose ClipSync to the public internet.

## License

MIT.
