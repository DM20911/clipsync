# ClipSync — Security Mitigations + Per-Device Tutorials

**Date:** 2026-05-04
**Author:** DM20911 / OptimizarIA Consulting SPA
**Status:** Approved design — ready for implementation plan

---

## Goal

Mitigate all 15 vulnerabilities identified in the security audit (CRITICAL → INFO) without losing functionality, and produce per-device installation/usage tutorials that double as developer reference. ClipSync runs as an OS-level service that auto-starts at boot, with installation requiring admin/root privileges.

## Non-goals

- Rewriting the WebSocket protocol or op codes
- Replacing SQLite or the mDNS discovery flow
- Adding cloud features (ClipSync remains LAN-only)
- Mobile-native clients beyond the PWA

---

## Architecture overview

| Layer | Before | After |
|-------|--------|-------|
| Crypto | Single shared `networkKey` (AES-256-GCM via PBKDF2) | Per-device X25519 keypair + envelope encryption (HKDF + AES-256-GCM) |
| Hub HTTP API | No authentication | Admin token (3 modes, default: console-printed) |
| CORS | `Access-Control-Allow-Origin: *` | Origin allowlist + `Vary: Origin` |
| TLS verification | `rejectUnauthorized: false` | TOFU certificate pinning per client |
| PIN flow | Unlimited attempts, plaintext in memory, modulo bias | Hashed in memory, rate-limited (per-IP + per-PIN), `crypto.randomInt` |
| JWT revocation | Flag-only on device | Closes active WS + revokes JTI in DB |
| Rate limiting | None | Token bucket per device (WS) + per IP (HTTP) |
| SSE auth | Open to any LAN host | Same-origin admin cookie required |
| PWA key storage | Raw key in localStorage | Non-extractable `CryptoKey` in IndexedDB |
| Auto-start | Manual `npm start` | launchd / systemd / Task Scheduler service |

---

## 1 · Security mitigations

### 1.1 Envelope encryption (VULN-001 + VULN-014)

Each device generates an **X25519 keypair** during registration. The hub stores public keys for all devices. The shared `networkKey` is removed.

**Send flow (client):**

```
1. content_key ← randomBytes(32)
2. encrypted_payload ← AES-256-GCM(content_key, payload)
3. ephemeral_keypair ← X25519.generate()
4. for each registered device d:
     shared ← X25519(ephemeral_private, d.public)
     wrap_key ← HKDF-SHA256(shared, salt=salt, info="clipsync-v1")
     wrapped[d.id] ← AES-256-GCM(wrap_key, content_key)
5. send: {
     encrypted_payload,
     sender_ephemeral_public,
     wrapped_keys: { [device_id]: wrapped },
     wrap_salt
   }
```

**Receive flow (client):**

```
1. shared ← X25519(my_private, sender_ephemeral_public)
2. wrap_key ← HKDF-SHA256(shared, salt=wrap_salt, info="clipsync-v1")
3. content_key ← AES-256-GCM-decrypt(wrap_key, wrapped_keys[my_id])
4. payload ← AES-256-GCM-decrypt(content_key, encrypted_payload)
```

**Hub:** stores the bundle as-is. On `BROADCAST`, sends each device only its own `wrapped_keys[device_id]` plus the encrypted payload, sender ephemeral public, and salt. Hub never has access to plaintext.

**Why this fixes VULN-001:** A revoked device's public key is removed from the recipient list. Future clips never include a wrapped key for it; the device cannot decrypt anything new. Past clips (already on its disk) remain readable, but no further damage propagates.

**Why this fixes VULN-014:** PBKDF2 was used as a KDF on a 256-bit random key — wrong tool. HKDF is the correct primitive for high-entropy IKM (X25519 shared secret).

### 1.2 Admin auth (VULN-002 + VULN-008)

New module `hub/src/admin.js` exposes `createAdminMiddleware(mode)` and `requireAdmin(req, res)`.

**Three modes** (selected via `CLIPSYNC_ADMIN_MODE` env var):

- **`token` (default):** Hub generates a 32-byte random token at first start, stores it in `meta.admin_token`, prints it to console once:
  ```
  [clipsync] Admin token (save this — shown once):
  [clipsync]   AbCd1234EfGh5678IjKl9012MnOp3456...
  ```
  Dashboard at `/admin` shows a one-time login form. Submitted token is verified via `crypto.timingSafeEqual` and exchanged for an `admin_session` cookie (HttpOnly, Secure, SameSite=Strict, 8h TTL).

- **`password`:** Reads `CLIPSYNC_ADMIN_PASSWORD` from env. Same login form; password compared via timing-safe equal of bcrypt hashes (stored in DB).

- **`first-device`:** First successfully registered device is marked `is_admin = 1`. Admin operations are sent over the device's authenticated WebSocket using new ops `OP.ADMIN_PIN`, `OP.ADMIN_REVOKE`, `OP.ADMIN_HISTORY_CLEAR`. Dashboard authenticates via the same JWT.

**Protected routes** (require admin in any mode):
- `POST /api/pin`
- `GET /api/qr`
- `DELETE /api/devices/:id`
- `DELETE /api/history`
- `GET /api/events` (SSE)

**Open routes** (no admin needed):
- `POST /api/register` (consumes a PIN — protected by PIN flow)
- `GET /api/status` (no sensitive data)
- `GET /api/config` (read-only public config)
- `GET /` and `/admin` HTML (login flow handles auth)

### 1.3 CORS hardening (VULN-003)

```javascript
const allowedOrigin = `https://${primaryLanIp()}:${CONFIG.PORT_HTTP}`;
const origin = req.headers.origin;
if (origin && origin !== allowedOrigin) {
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end('forbidden origin');
  return;
}
res.setHeader('access-control-allow-origin', allowedOrigin);
res.setHeader('access-control-allow-credentials', 'true');
res.setHeader('vary', 'Origin');
```

Requests without `Origin` header (curl, native clients) bypass the check (they don't run in browser context, so cross-origin attacks don't apply).

### 1.4 Rate limiting (VULN-004 + VULN-007)

New module `hub/src/rate-limit.js`:

```javascript
class TokenBucket {
  constructor({ capacity, refillPerSec })
  consume(key, n=1) → boolean
  reset(key)
}

class AttemptCounter {
  constructor({ maxAttempts, windowMs })
  hit(key) → { allowed, remaining, resetAt }
}
```

Applied:
- **PIN per IP:** `AttemptCounter({ maxAttempts: 10, windowMs: 60_000 })` keyed by IP. Triggered on `POST /api/register`.
- **PIN per PIN value:** Failure count stored in `activePins` Map entry. Invalidated after 5 failures.
- **WS PUSH per device:** `TokenBucket({ capacity: 20, refillPerSec: 5 })` keyed by device ID. Exceeded → `OP.ERROR` with `reason: 'rate_limited'`, no disconnection.

PIN comparison uses `crypto.timingSafeEqual`. PIN generated with `crypto.randomInt(0, 1_000_000)`.

### 1.5 PIN hashing in memory (VULN-011)

`activePins` Map now stores `{ pinHash, salt, expiresAt, failures }` instead of plaintext PIN as the Map key. Lookup uses `crypto.timingSafeEqual(sha256(salt+input), pinHash)` over all active entries (max ~10 active at any time, so O(n) is fine).

### 1.6 TOFU certificate pinning (VULN-005)

**Desktop client** (`client-desktop/src/ws-client.js`):

```javascript
const ws = new WebSocket(url, { rejectUnauthorized: false });
ws.on('upgrade', (response) => {
  const fp = response.socket.getPeerCertificate().fingerprint256;
  if (state.hub_cert_fp && state.hub_cert_fp !== fp) {
    ws.close(1008, 'cert_mismatch');
    log.error('TLS fingerprint changed — manual review required');
    return;
  }
  if (!state.hub_cert_fp) {
    state.hub_cert_fp = fp;
    save(state);
    log.info(`pinned cert ${fp.slice(0, 16)}…`);
  }
});
```

**PWA:** Documented in `pwa.md`. The QR payload includes the cert SHA-256 fingerprint; the user is instructed to compare it against the browser's cert details on first acceptance.

### 1.7 JWT revocation (VULN-006)

New table:

```sql
CREATE TABLE device_jtis (
  jti        TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_device_jtis_device ON device_jtis(device_id);
```

`auth.signToken()` records every issued JTI here. `auth.revokeDevice(id)`:

1. Marks `devices.revoked = 1`
2. Selects all non-expired JTIs for this device
3. Inserts them into `revoked_jti`
4. Calls back into server via emitted event `device:revoked` → server closes the live WS (`sockets.get(id)?.close(1008, 'revoked')`)

JWT lifetime reduced from 30d to 7d. Refresh handled at next successful auth (token renewed transparently).

### 1.8 Non-extractable AES key in PWA (VULN-009)

**Storage:** the per-device X25519 private key (the actual sensitive material) is generated via `crypto.subtle.generateKey({ name: 'X25519' }, /*extractable=*/false, ['deriveKey'])`. The `CryptoKey` object is stored in IndexedDB (which supports CryptoKey persistence with non-extractable keys preserved).

`localStorage` keeps only:
- `device_id`, `jwt`, `hub_url`, `hub_cert_fp`
- The X25519 **public key** (extractable, base64)

The private key never appears in JS memory in raw form. XSS at most can call `crypto.subtle.deriveKey` using the key handle, but cannot exfiltrate the bytes.

### 1.9 History anti-replay (VULN-010)

`db.insertHistory()` switches from `INSERT OR REPLACE` to `INSERT OR IGNORE`. On conflict, returns `changes === 0`; the hub responds `OP.ERROR` with `reason: 'duplicate_id'`. Sender treats this as success (clip already in history) and does not retry.

### 1.10 Input validation (VULN-012)

In `hub/src/auth.js#registerDevice`:

```javascript
function validateRegistration({ name, os, fingerprint }) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) throw new Error('invalid_name');
  if (typeof os !== 'string' || os.length > 32) throw new Error('invalid_os');
  if (fingerprint != null && !/^[a-f0-9]{32,128}$/i.test(fingerprint)) throw new Error('invalid_fingerprint');
  // Reject control chars + normalize
  return { name: name.normalize('NFC').replace(/[\x00-\x1f]/g, ''), os, fingerprint };
}
```

### 1.11 Script injection hardening (VULN-013)

`writeImage` darwin: pass `tmp` via `argv` instead of string interpolation:

```javascript
const script = `on run argv
  set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)
end run`;
await exec('osascript', ['-e', script, tmp]);
```

`writeImage` win32: replace shelled-out PowerShell with a small Node helper using the existing Electron `clipboard.writeImage` API once we run inside Electron (out of scope for now), or — interim — keep PowerShell but strictly validate `tmp` matches `/^([A-Z]:\\|\/)[^"'`$]+\.png$/` before interpolation.

### 1.12 PIN entropy (VULN-015)

`randomPin()` becomes:

```javascript
export function randomPin(digits = 6) {
  const max = 10 ** digits;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(digits, '0');
}
```

---

## 2 · Auto-start as system service

| OS | Mechanism | Install | Privileges |
|----|-----------|---------|------------|
| macOS | launchd user agent (`~/Library/LaunchAgents/com.clipsync.daemon.plist`) | `install-mac.sh` | sudo only for `/opt/clipsync` |
| Linux | systemd user unit (`~/.config/systemd/user/clipsync.service`) | `install-linux.sh` | sudo only for system deps (node, xclip/wl-clipboard) |
| Windows | Task Scheduler at logon | `install-win.ps1` | RunAsAdministrator (registers task only) |

**Common boot sequence:**

```
OS boots → user logs in → service starts
  ↓
state.json present and JWT valid?
  no  → daemon idles, logs "not registered, run `clipsync register`"
  yes → mDNS lookup hub
        ↓
        TLS cert fingerprint matches state.hub_cert_fp?
          no  → daemon halts, logs critical alert, no sync
          yes → WSS auth → enter sync loop
```

The service runs under the **user account**, never as root/SYSTEM. This is intentional: clipboard access requires user-session context (especially for Wayland and macOS).

---

## 3 · Per-device tutorials

All tutorials live in `docs/tutorials/`. Common structure:

```
1. ¿Qué es ClipSync?           (2 lines)
2. Requisitos previos
3. Instalación                 (exact commands)
4. Registro inicial            (PIN/QR flow)
5. Uso diario
6. Auto-start
7. Solución de problemas
8. ──── Notas técnicas ────
9. Arquitectura del cliente
10. Variables de entorno
11. Logs y debugging
12. Desinstalar
```

Footer present on every tutorial:

```markdown
---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) —
[OptimizarIA Consulting SPA](https://optimizaria.com)
```

### Files

| File | Audience | Notes |
|------|----------|-------|
| `docs/tutorials/README.md` | Hub admin + index | How to launch the hub, configure admin mode (A/B/C), system diagram, links to all tutorials |
| `docs/tutorials/macos.md` | macOS user + dev | `install-mac.sh`, accessibility permission, AppleScript notes, `~/.config/clipsync` paths |
| `docs/tutorials/linux.md` | Linux user + dev | xclip/wl-clipboard auto-detection, systemd `--user`, `journalctl` logs |
| `docs/tutorials/windows.md` | Windows user + dev | PowerShell install, Task Scheduler, Windows.Forms.Clipboard |
| `docs/tutorials/pwa.md` | Mobile/browser user + dev | TLS exception flow, fingerprint comparison, IndexedDB persistence, Add to Home Screen |

---

## 4 · Files affected

```
NEW
  hub/src/admin.js
  hub/src/rate-limit.js
  hub/src/envelope.js
  shared/crypto-node.js          (consolidates crypto.js + crypto-bridge.js)
  shared/x25519.js               (cross-platform helpers, Node + Web Crypto)
  docs/tutorials/README.md
  docs/tutorials/macos.md
  docs/tutorials/linux.md
  docs/tutorials/windows.md
  docs/tutorials/pwa.md
  docs/superpowers/specs/2026-05-04-security-mitigations-and-tutorials-design.md  (this file)

MODIFIED
  shared/protocol.js              (new ops, OP.ERROR, isUrlClip already added)
  hub/src/server.js               (admin check, rate limit, envelope routing, JWT revoke close)
  hub/src/routes.js               (admin middleware on protected routes, login endpoints)
  hub/src/auth.js                 (input validation, JTI tracking, lifetime, PIN hashing)
  hub/src/db.js                   (device_jtis table, INSERT OR IGNORE, public_key column)
  hub/src/crypto.js               (HKDF helpers, randomInt, removed PBKDF2)
  hub/src/config.js               (CLIPSYNC_ADMIN_MODE, CLIPSYNC_ADMIN_PASSWORD)
  client-desktop/src/main.js      (envelope flow, removed shared key)
  client-desktop/src/ws-client.js (TOFU pinning)
  client-desktop/src/store.js     (hub_cert_fp, x25519_private, x25519_public)
  client-desktop/src/register.js  (sends X25519 public key on registration)
  client-desktop/src/crypto-bridge.js  → REMOVED (replaced by shared/crypto-node.js)
  client-pwa/app.js               (envelope flow, IndexedDB CryptoKey storage)
  hub/public/admin.html           (login form, Authorization for SSE via cookie)
  scripts/install-mac.sh          (launchd plist)
  scripts/install-linux.sh        (systemd unit)
  scripts/install-win.ps1         (Task Scheduler)
```

---

## 5 · Test plan

**Unit tests (extend existing `hub/src/__tests__/`):**
- `envelope.test.js` — encrypt/decrypt round-trip with multiple recipients; rejects revoked devices
- `rate-limit.test.js` — token bucket refill, attempt counter window expiry
- `admin.test.js` — token mode (timing-safe compare, cookie issue/verify), password mode, first-device mode
- `auth.test.js` — extend with PIN hashing, failure invalidation, JTI revocation chain

**Integration tests (new `hub/src/__tests__/integration.test.js`):**
- Full registration flow with X25519 key exchange
- Admin protected route returns 401 without cookie
- CORS rejects foreign origin
- WS PUSH rate limit triggers `rate_limited` error
- Device revocation closes active WS

**Manual QA matrix:**

| Scenario | macOS | Linux | Windows | PWA |
|----------|-------|-------|---------|-----|
| Fresh install + register | ✓ | ✓ | ✓ | ✓ |
| Auto-start after reboot | ✓ | ✓ | ✓ | n/a |
| Cert fingerprint mismatch | ✓ | ✓ | ✓ | ✓ (manual) |
| Revoked from admin → disconnect | ✓ | ✓ | ✓ | ✓ |
| Send/receive text | ✓ | ✓ | ✓ | ✓ |
| Send/receive image | ✓ | ✓ | ✓ | ✓ |
| 50MB file | ✓ | ✓ | ✓ | ✓ |

---

## 6 · Migration / backwards compatibility

This is a breaking change to the wire protocol (envelope encryption replaces shared-key encryption). Mitigation:

1. Bump `PROTOCOL_VERSION` from 1 to 2 in `shared/protocol.js`.
2. Hub on first start with new code: invalidate all existing devices (force re-registration). Log a warning explaining why.
3. Old clients connecting with v1 payloads receive `OP.AUTH_FAIL` with `reason: 'protocol_upgrade_required'`.
4. Tutorials include a "Upgrading from v1" section: revoke all old devices, regenerate PINs, re-register.

No data migration is possible for old encrypted history (different key schema). History is wiped on upgrade — documented as part of the migration step.

---

## 7 · Out of scope (future work)

- Argon2id for any future password-based flows
- WebAuthn/passkey-based admin auth
- Full Electron repackaging of the desktop client (currently raw Node + scripts)
- End-to-end audit logging of admin actions
- Per-clip recipient ACLs ("send only to my phone")

---

Footer applies to all generated tutorials:

> Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
