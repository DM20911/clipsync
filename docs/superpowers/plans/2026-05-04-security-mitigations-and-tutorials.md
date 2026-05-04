# ClipSync Security Mitigations + Tutorials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mitigate all 15 security vulnerabilities (envelope encryption, admin auth, rate limiting, TOFU pinning, JWT revocation, input validation) and produce per-device user+developer tutorials. Add OS-level auto-start as user service.

**Architecture:** Hub stays Node.js + SQLite + WSS. Per-device X25519 keypairs replace shared `networkKey`. Admin token (3 modes, default console-printed) protects HTTP API. PWA persists non-extractable `CryptoKey` in IndexedDB. Desktop client pins hub TLS fingerprint TOFU.

**Tech Stack:** Node 18+, `node:crypto` (X25519, HKDF, randomInt), `better-sqlite3`, `ws`, Web Crypto API (browser), launchd / systemd / Task Scheduler.

---

## Phase 0 — Setup

### Task 0.1: Initialize git and create branch

**Files:**
- Init: repo root

- [ ] **Step 1: Initialize git if not already**

```bash
cd /Users/dm20911/Documents/dev_ia_proyect/clipsync
git init
git add -A
git commit -m "chore: initial snapshot before security overhaul"
```

- [ ] **Step 2: Create feature branch**

```bash
git checkout -b feat/security-overhaul-v2
```

---

## Phase 1 — Shared crypto foundation

### Task 1.1: Create `shared/crypto-node.js` (X25519 + HKDF + AES-GCM)

**Files:**
- Create: `shared/crypto-node.js`
- Test: `hub/src/__tests__/crypto-node.test.js`

- [ ] **Step 1: Write failing test**

```javascript
// hub/src/__tests__/crypto-node.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateX25519, deriveSharedKey, encryptAesGcm, decryptAesGcm,
  randomBytes, randomPin, sha256Hex
} from '../../../shared/crypto-node.js';

test('X25519 round trip via HKDF', () => {
  const a = generateX25519();
  const b = generateX25519();
  const salt = randomBytes(16);
  const k1 = deriveSharedKey(a.privateKey, b.publicKey, salt, 'test');
  const k2 = deriveSharedKey(b.privateKey, a.publicKey, salt, 'test');
  assert.deepEqual(k1, k2);
  assert.equal(k1.length, 32);
});

test('AES-GCM encrypt/decrypt', () => {
  const key = randomBytes(32);
  const ct = encryptAesGcm(key, Buffer.from('hello'));
  const pt = decryptAesGcm(key, ct);
  assert.equal(pt.toString(), 'hello');
});

test('randomPin always 6 digits', () => {
  for (let i = 0; i < 100; i++) {
    const p = randomPin(6);
    assert.match(p, /^\d{6}$/);
  }
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd hub && node --test src/__tests__/crypto-node.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `shared/crypto-node.js`**

```javascript
// AES-256-GCM + X25519 + HKDF + helpers. Used by hub and Node clients.
import crypto from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

export function generateX25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
  };
}

export function importX25519Private(der) {
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
export function importX25519Public(der) {
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function deriveSharedKey(privDer, pubDer, salt, info) {
  const priv = importX25519Private(privDer);
  const pub  = importX25519Public(pubDer);
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(info, 'utf8'), 32));
}

// Layout: [iv:12][tag:16][ciphertext]
export function encryptAesGcm(key, payload) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decryptAesGcm(key, buf) {
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export function randomBytes(n) { return crypto.randomBytes(n); }
export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
export function randomPin(digits = 6) {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}
export function sha256Hex(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return crypto.createHash('sha256').update(data).digest('hex');
}
export function timingSafeEqualBuf(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
cd hub && node --test src/__tests__/crypto-node.test.js
```
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add shared/crypto-node.js hub/src/__tests__/crypto-node.test.js
git commit -m "feat(crypto): add shared X25519 + HKDF + AES-GCM module"
```

---

### Task 1.2: Update `shared/protocol.js` with new ops + version bump

**Files:**
- Modify: `shared/protocol.js`

- [ ] **Step 1: Bump PROTOCOL_VERSION and add new ops**

Replace the version constant and OP block:

```javascript
export const PROTOCOL_VERSION = 2;

export const OP = {
  AUTH:        'auth',
  AUTH_OK:     'auth_ok',
  AUTH_FAIL:   'auth_fail',
  ERROR:       'error',
  PUSH:        'push',
  BROADCAST:   'broadcast',
  PING:        'ping',
  PONG:        'pong',
  HISTORY_REQ: 'history_request',
  HISTORY:     'history',
  DEVICE_JOINED: 'device_joined',
  DEVICE_LEFT:   'device_left',
  REVOKED:     'revoked',
  REGISTER:    'register',
  REGISTER_OK: 'register_ok',
  PEERS:       'peers',          // new — hub publishes updated peer pubkey list
};
```

- [ ] **Step 2: Add `isValidEnvelope` validator**

Append:

```javascript
export function isValidEnvelope(clip) {
  if (!isValidClip(clip)) return false;
  if (typeof clip.encrypted_payload !== 'string') return false;
  if (typeof clip.sender_ephemeral_public !== 'string') return false;
  if (typeof clip.wrap_salt !== 'string') return false;
  if (!clip.wrapped_keys || typeof clip.wrapped_keys !== 'object') return false;
  return true;
}
```

- [ ] **Step 3: Commit**

```bash
git add shared/protocol.js
git commit -m "feat(protocol): bump to v2, add PEERS op and envelope validator"
```

---

## Phase 2 — DB schema and migrations

### Task 2.1: Add `device_jtis` table and `public_key` column

**Files:**
- Modify: `hub/src/db.js`
- Test: `hub/src/__tests__/db.test.js` (new)

- [ ] **Step 1: Write failing test**

```javascript
// hub/src/__tests__/db.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB } from '../db.js';

function tmpDb() {
  return path.join(os.tmpdir(), `clipsync-test-${Date.now()}-${Math.random()}.db`);
}

test('insertDevice with public_key', () => {
  const p = tmpDb();
  const db = new DB(p);
  db.insertDevice({
    id: 'd1', name: 'a', os: 'linux', token: 't', fingerprint: null,
    created_at: 1, last_seen: null, public_key: Buffer.from('pk'),
  });
  const d = db.getDevice('d1');
  assert.equal(d.id, 'd1');
  assert.deepEqual(d.public_key, Buffer.from('pk'));
  db.close();
  fs.unlinkSync(p);
});

test('JTI tracking and revocation cascade', () => {
  const p = tmpDb();
  const db = new DB(p);
  db.insertDevice({ id: 'd1', name: 'a', os: '', token: 't', fingerprint: null, created_at: 1, last_seen: null, public_key: Buffer.from('pk') });
  db.recordJti('jti-1', 'd1', 1, 1000);
  db.recordJti('jti-2', 'd1', 1, 1000);
  db.revokeAllJtisForDevice('d1');
  assert.equal(db.isJtiRevoked('jti-1'), true);
  assert.equal(db.isJtiRevoked('jti-2'), true);
  db.close();
  fs.unlinkSync(p);
});

test('insertHistory rejects duplicate id', () => {
  const p = tmpDb();
  const db = new DB(p);
  const r1 = db.insertHistory({
    id: 'c1', type: 'text', mime: null, size: 1, source_id: 'd1',
    timestamp: 1, checksum: null, payload_b64: 'p', meta_json: '{}',
  });
  const r2 = db.insertHistory({
    id: 'c1', type: 'text', mime: null, size: 2, source_id: 'd1',
    timestamp: 2, checksum: null, payload_b64: 'q', meta_json: '{}',
  });
  assert.equal(r1, true);
  assert.equal(r2, false);
  db.close();
  fs.unlinkSync(p);
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
cd hub && node --test src/__tests__/db.test.js
```
Expected: FAIL.

- [ ] **Step 3: Update `hub/src/db.js`**

Replace the migration block in `#migrate()`:

```javascript
this.db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY, value TEXT
  );
  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    os          TEXT,
    token       TEXT NOT NULL,
    fingerprint TEXT,
    public_key  BLOB,
    is_admin    INTEGER DEFAULT 0,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER,
    revoked     INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, mime TEXT, size INTEGER,
    source_id TEXT, timestamp INTEGER NOT NULL, checksum TEXT,
    payload_b64 TEXT NOT NULL, meta_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp DESC);
  CREATE TABLE IF NOT EXISTS revoked_jti (
    jti TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_jtis (
    jti TEXT PRIMARY KEY, device_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_device_jtis_device ON device_jtis(device_id);
`);
// Defensive migration for older DBs
const cols = this.db.prepare("PRAGMA table_info(devices)").all().map(c => c.name);
if (!cols.includes('public_key')) this.db.exec('ALTER TABLE devices ADD COLUMN public_key BLOB');
if (!cols.includes('is_admin'))  this.db.exec('ALTER TABLE devices ADD COLUMN is_admin INTEGER DEFAULT 0');
```

Update `insertDevice`:

```javascript
insertDevice(d) {
  this.db.prepare(`
    INSERT INTO devices(id,name,os,token,fingerprint,public_key,created_at,last_seen,revoked,is_admin)
    VALUES(@id,@name,@os,@token,@fingerprint,@public_key,@created_at,@last_seen,0,@is_admin)
  `).run({ is_admin: 0, ...d });
}
```

Update `insertHistory` to return boolean:

```javascript
insertHistory(item) {
  const r = this.db.prepare(`
    INSERT OR IGNORE INTO history(id,type,mime,size,source_id,timestamp,checksum,payload_b64,meta_json)
    VALUES(@id,@type,@mime,@size,@source_id,@timestamp,@checksum,@payload_b64,@meta_json)
  `).run(item);
  return r.changes === 1;
}
```

Add new methods:

```javascript
recordJti(jti, deviceId, issuedAt, expiresAt) {
  this.db.prepare(
    'INSERT OR IGNORE INTO device_jtis(jti,device_id,issued_at,expires_at) VALUES(?,?,?,?)'
  ).run(jti, deviceId, issuedAt, expiresAt);
}
revokeAllJtisForDevice(deviceId) {
  const now = Date.now();
  const rows = this.db.prepare(
    'SELECT jti FROM device_jtis WHERE device_id = ? AND expires_at > ?'
  ).all(deviceId, now);
  const stmt = this.db.prepare('INSERT OR IGNORE INTO revoked_jti(jti,revoked_at) VALUES(?,?)');
  const tx = this.db.transaction((items) => { for (const r of items) stmt.run(r.jti, now); });
  tx(rows);
}
listDevicePublicKeys(excludeId) {
  return this.db.prepare(
    'SELECT id, public_key FROM devices WHERE revoked = 0 AND public_key IS NOT NULL AND id != ?'
  ).all(excludeId || '');
}
setDeviceAdmin(id, isAdmin) {
  this.db.prepare('UPDATE devices SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
}
hasAnyAdmin() {
  return this.db.prepare('SELECT COUNT(*) as n FROM devices WHERE is_admin = 1 AND revoked = 0').get().n > 0;
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
cd hub && node --test src/__tests__/db.test.js
```
Expected: PASS 3/3.

- [ ] **Step 5: Commit**

```bash
git add hub/src/db.js hub/src/__tests__/db.test.js
git commit -m "feat(db): add device_jtis table, public_key column, history dedup"
```

---

## Phase 3 — Hub modules: rate-limit, admin, envelope

### Task 3.1: Create `hub/src/rate-limit.js`

**Files:**
- Create: `hub/src/rate-limit.js`
- Test: `hub/src/__tests__/rate-limit.test.js`

- [ ] **Step 1: Write failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, AttemptCounter } from '../rate-limit.js';

test('TokenBucket allows up to capacity then blocks', () => {
  const tb = new TokenBucket({ capacity: 3, refillPerSec: 1 });
  assert.equal(tb.consume('k', 1), true);
  assert.equal(tb.consume('k', 1), true);
  assert.equal(tb.consume('k', 1), true);
  assert.equal(tb.consume('k', 1), false);
});

test('TokenBucket refills over time', async () => {
  const tb = new TokenBucket({ capacity: 1, refillPerSec: 1000 });
  tb.consume('k', 1);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(tb.consume('k', 1), true);
});

test('AttemptCounter blocks after maxAttempts', () => {
  const ac = new AttemptCounter({ maxAttempts: 3, windowMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    const r = ac.hit('ip');
    assert.equal(r.allowed, true);
  }
  assert.equal(ac.hit('ip').allowed, false);
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd hub && node --test src/__tests__/rate-limit.test.js
```

- [ ] **Step 3: Implement `hub/src/rate-limit.js`**

```javascript
export class TokenBucket {
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
  }
  consume(key, n = 1) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, last: now }; this.buckets.set(key, b); }
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.last = now;
    if (b.tokens < n) return false;
    b.tokens -= n;
    return true;
  }
  reset(key) { this.buckets.delete(key); }
  cleanup(maxIdleMs = 600_000) {
    const cutoff = Date.now() - maxIdleMs;
    for (const [k, b] of this.buckets) if (b.last < cutoff) this.buckets.delete(k);
  }
}

export class AttemptCounter {
  constructor({ maxAttempts, windowMs }) {
    this.max = maxAttempts;
    this.windowMs = windowMs;
    this.counts = new Map();
  }
  hit(key) {
    const now = Date.now();
    let e = this.counts.get(key);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + this.windowMs }; this.counts.set(key, e); }
    e.count++;
    return { allowed: e.count <= this.max, remaining: Math.max(0, this.max - e.count), resetAt: e.resetAt };
  }
  reset(key) { this.counts.delete(key); }
  cleanup() {
    const now = Date.now();
    for (const [k, e] of this.counts) if (now > e.resetAt) this.counts.delete(k);
  }
}
```

- [ ] **Step 4: Run (expect pass)**

```bash
cd hub && node --test src/__tests__/rate-limit.test.js
```

- [ ] **Step 5: Commit**

```bash
git add hub/src/rate-limit.js hub/src/__tests__/rate-limit.test.js
git commit -m "feat(hub): add token bucket + attempt counter"
```

---

### Task 3.2: Create `hub/src/admin.js`

**Files:**
- Create: `hub/src/admin.js`
- Test: `hub/src/__tests__/admin.test.js`

- [ ] **Step 1: Write failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Admin } from '../admin.js';

const fakeDb = (() => {
  const store = new Map();
  return {
    getMeta: (k) => store.get(k) ?? null,
    setMeta: (k, v) => store.set(k, v),
    hasAnyAdmin: () => false,
  };
})();

test('token mode generates and verifies', () => {
  const a = new Admin({ db: fakeDb, mode: 'token' });
  const token = a.bootstrap();
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(a.verifyCredential(token), true);
  assert.equal(a.verifyCredential('wrong'), false);
});

test('session cookie issuance and verification', () => {
  const a = new Admin({ db: fakeDb, mode: 'token' });
  a.bootstrap();
  const sid = a.issueSession();
  assert.equal(a.verifySession(sid), true);
  assert.equal(a.verifySession('nope'), false);
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
cd hub && node --test src/__tests__/admin.test.js
```

- [ ] **Step 3: Implement `hub/src/admin.js`**

```javascript
import crypto from 'node:crypto';
import { randomToken, timingSafeEqualBuf } from '../../shared/crypto-node.js';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class Admin {
  constructor({ db, mode = 'token', password = null }) {
    this.db = db;
    this.mode = mode;        // 'token' | 'password' | 'first-device'
    this.password = password;
    this.sessions = new Map(); // sid -> expiresAt
  }

  bootstrap() {
    if (this.mode === 'token') {
      let tok = this.db.getMeta('admin_token');
      let printed = false;
      if (!tok) {
        tok = randomToken(32);
        this.db.setMeta('admin_token', tok);
        printed = true;
      }
      this.adminToken = tok;
      return printed ? tok : null;   // null = already existed, don't reprint
    }
    if (this.mode === 'password') {
      if (!this.password) throw new Error('CLIPSYNC_ADMIN_PASSWORD required in password mode');
    }
    return null;
  }

  verifyCredential(input) {
    if (this.mode === 'token') {
      if (!this.adminToken || !input) return false;
      const a = Buffer.from(this.adminToken);
      const b = Buffer.from(String(input));
      return timingSafeEqualBuf(a, b);
    }
    if (this.mode === 'password') {
      if (!this.password || !input) return false;
      const a = Buffer.from(this.password);
      const b = Buffer.from(String(input));
      return timingSafeEqualBuf(a, b);
    }
    return false;
  }

  issueSession() {
    const sid = randomToken(32);
    this.sessions.set(sid, Date.now() + SESSION_TTL_MS);
    return sid;
  }

  verifySession(sid) {
    const exp = this.sessions.get(sid);
    if (!exp) return false;
    if (Date.now() > exp) { this.sessions.delete(sid); return false; }
    return true;
  }

  revokeSession(sid) { this.sessions.delete(sid); }

  cleanupSessions() {
    const now = Date.now();
    for (const [s, e] of this.sessions) if (now > e) this.sessions.delete(s);
  }

  // first-device mode: check if this device JWT belongs to admin
  isAdminDevice(deviceId) {
    if (this.mode !== 'first-device') return false;
    return !!this.db.getDevice(deviceId)?.is_admin;
  }
}

export function parseCookie(header, name) {
  if (!header) return null;
  const m = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
```

- [ ] **Step 4: Run (expect pass)**

```bash
cd hub && node --test src/__tests__/admin.test.js
```

- [ ] **Step 5: Commit**

```bash
git add hub/src/admin.js hub/src/__tests__/admin.test.js
git commit -m "feat(hub): admin token/password/first-device auth"
```

---

### Task 3.3: Update `hub/src/auth.js` — input validation, PIN hashing, JTI tracking, X25519

**Files:**
- Modify: `hub/src/auth.js`
- Test: extend `hub/src/__tests__/auth.test.js`

- [ ] **Step 1: Add tests for new behavior**

Append to `hub/src/__tests__/auth.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB } from '../db.js';
import { Auth } from '../auth.js';

function freshAuth() {
  const p = path.join(os.tmpdir(), `clipsync-auth-${Date.now()}-${Math.random()}.db`);
  const db = new DB(p);
  return { db, auth: new Auth(db), cleanup: () => { db.close(); fs.unlinkSync(p); } };
}

test('PIN invalidated after 5 failures', () => {
  const { auth, cleanup } = freshAuth();
  const { pin } = auth.issuePin();
  for (let i = 0; i < 5; i++) auth.consumePin('000000');  // wrong
  assert.equal(auth.consumePin(pin), false);  // PIN invalidated
  cleanup();
});

test('registerDevice rejects oversize name', () => {
  const { auth, cleanup } = freshAuth();
  const longName = 'x'.repeat(100);
  assert.throws(() => auth.registerDevice({ name: longName, os: 'l', publicKey: Buffer.from('pk') }), /invalid_name/);
  cleanup();
});

test('JTI revocation cascade closes JWTs', () => {
  const { db, auth, cleanup } = freshAuth();
  const reg = auth.registerDevice({ name: 'a', os: 'l', publicKey: Buffer.from('pk') });
  const v1 = auth.verifyToken(reg.jwt);
  assert.equal(v1.ok, true);
  auth.revokeDevice(reg.id);
  const v2 = auth.verifyToken(reg.jwt);
  assert.equal(v2.ok, false);
  cleanup();
});
```

- [ ] **Step 2: Rewrite `hub/src/auth.js`**

```javascript
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { randomToken, randomPin, timingSafeEqualBuf, sha256Hex } from '../../shared/crypto-node.js';
import { CONFIG } from './config.js';

const JWT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PIN_MAX_FAILURES = 5;
const NAME_MAX = 64;
const OS_MAX = 32;
const FP_RE = /^[a-f0-9]{32,128}$/i;

function validateRegistration({ name, os, fingerprint }) {
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) {
    throw new Error('invalid_name');
  }
  if (typeof os !== 'string' || os.length > OS_MAX) {
    throw new Error('invalid_os');
  }
  if (fingerprint != null && !FP_RE.test(String(fingerprint))) {
    throw new Error('invalid_fingerprint');
  }
  return {
    name: name.normalize('NFC').replace(/[\x00-\x1f]/g, ''),
    os: os.normalize('NFC'),
    fingerprint: fingerprint || null,
  };
}

export class Auth {
  constructor(db) {
    this.db = db;
    // Map<pinHashHex, { salt, expiresAt, failures }>
    this.activePins = new Map();
    this.serverSecret = this.#loadOrCreateSecret();
  }

  #loadOrCreateSecret() {
    let s = this.db.getMeta('server_secret');
    if (!s) {
      s = randomToken(48);
      this.db.setMeta('server_secret', s);
      this.db.setMeta('secret_created_at', String(Date.now()));
    }
    return s;
  }

  rotateSecret() {
    this.serverSecret = randomToken(48);
    this.db.setMeta('server_secret', this.serverSecret);
    this.db.setMeta('secret_created_at', String(Date.now()));
  }
  shouldRotate() {
    const c = parseInt(this.db.getMeta('secret_created_at') || '0', 10);
    return (Date.now() - c) > CONFIG.TOKEN_ROTATION_MS;
  }

  issuePin() {
    const pin = randomPin(6);
    const salt = crypto.randomBytes(8).toString('hex');
    const hash = sha256Hex(salt + pin);
    this.activePins.set(hash, { salt, expiresAt: Date.now() + CONFIG.PIN_TTL_MS, failures: 0 });
    return { pin, expiresAt: Date.now() + CONFIG.PIN_TTL_MS };
  }

  consumePin(pin) {
    const now = Date.now();
    for (const [hash, entry] of this.activePins) {
      if (now > entry.expiresAt) { this.activePins.delete(hash); continue; }
      const want = sha256Hex(entry.salt + pin);
      if (timingSafeEqualBuf(Buffer.from(hash, 'hex'), Buffer.from(want, 'hex'))) {
        this.activePins.delete(hash);
        return true;
      }
    }
    // Wrong — find the most recently issued PIN and bump failure count
    // (we don't know which PIN was being targeted; bump *all* unexpired)
    for (const [hash, entry] of this.activePins) {
      entry.failures++;
      if (entry.failures >= PIN_MAX_FAILURES) this.activePins.delete(hash);
    }
    return false;
  }

  cleanExpiredPins() {
    const now = Date.now();
    for (const [h, e] of this.activePins) if (now > e.expiresAt) this.activePins.delete(h);
  }

  registerDevice({ name, os, fingerprint, publicKey, isAdmin = false }) {
    const v = validateRegistration({ name, os, fingerprint });
    if (!Buffer.isBuffer(publicKey) || publicKey.length === 0) throw new Error('invalid_public_key');
    const id = crypto.randomUUID();
    const deviceToken = randomToken(32);
    this.db.insertDevice({
      id, name: v.name, os: v.os, token: deviceToken,
      fingerprint: v.fingerprint, public_key: publicKey,
      created_at: Date.now(), last_seen: null, is_admin: isAdmin ? 1 : 0,
    });
    const jwtToken = this.signToken({ device_id: id });
    return { id, jwt: jwtToken };
  }

  signToken(payload) {
    const jti = crypto.randomUUID();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + JWT_TTL_MS;
    const tok = jwt.sign({ ...payload, jti }, this.serverSecret, {
      algorithm: 'HS256', expiresIn: Math.floor(JWT_TTL_MS / 1000),
    });
    if (payload.device_id) this.db.recordJti(jti, payload.device_id, issuedAt, expiresAt);
    return tok;
  }

  verifyToken(jwtStr) {
    try {
      const decoded = jwt.verify(jwtStr, this.serverSecret, { algorithms: ['HS256'] });
      if (decoded.jti && this.db.isJtiRevoked(decoded.jti)) return { ok: false, reason: 'revoked' };
      const dev = this.db.getDevice(decoded.device_id);
      if (!dev) return { ok: false, reason: 'unknown_device' };
      if (dev.revoked) return { ok: false, reason: 'device_revoked' };
      return { ok: true, decoded, device: dev };
    } catch (e) {
      return { ok: false, reason: 'invalid_token', error: e.message };
    }
  }

  revokeDevice(id) {
    this.db.revokeDevice(id);
    this.db.revokeAllJtisForDevice(id);
  }
}
```

- [ ] **Step 3: Run all hub tests**

```bash
cd hub && npm test
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add hub/src/auth.js hub/src/__tests__/auth.test.js
git commit -m "feat(auth): input validation, PIN hashing+lockout, JTI revocation cascade"
```

---

### Task 3.4: Create `hub/src/envelope.js` — envelope routing helpers

**Files:**
- Create: `hub/src/envelope.js`
- Test: `hub/src/__tests__/envelope.test.js`

- [ ] **Step 1: Test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPerRecipient } from '../envelope.js';

test('buildPerRecipient picks correct wrapped key per device', () => {
  const clip = {
    id: 'c1', type: 'text', size: 5, timestamp: 1, checksum: 'h',
    encrypted_payload: 'EP', sender_ephemeral_public: 'SP', wrap_salt: 'WS',
    wrapped_keys: { d1: 'WK1', d2: 'WK2' },
  };
  const m1 = buildPerRecipient(clip, 'd1', 'sender');
  assert.equal(m1.clip.wrapped_key, 'WK1');
  assert.equal(m1.clip.wrapped_keys, undefined);
  assert.equal(m1.clip.source_device, 'sender');
  const m2 = buildPerRecipient(clip, 'd2', 'sender');
  assert.equal(m2.clip.wrapped_key, 'WK2');
});

test('buildPerRecipient returns null for excluded device', () => {
  const clip = { wrapped_keys: { d1: 'WK1' } };
  assert.equal(buildPerRecipient(clip, 'd2', 'sender'), null);
});
```

- [ ] **Step 2: Implement**

```javascript
// hub/src/envelope.js
// Hub-side helpers for envelope-encrypted clip routing.
import { OP } from '../../shared/protocol.js';

export function buildPerRecipient(clip, recipientId, sourceDeviceId) {
  const wk = clip.wrapped_keys?.[recipientId];
  if (!wk) return null;
  return {
    op: OP.BROADCAST,
    clip: {
      id: clip.id,
      type: clip.type,
      mime: clip.mime,
      size: clip.size,
      source_device: sourceDeviceId,
      timestamp: clip.timestamp,
      checksum: clip.checksum,
      name: clip.name || null,
      encrypted_payload: clip.encrypted_payload,
      sender_ephemeral_public: clip.sender_ephemeral_public,
      wrap_salt: clip.wrap_salt,
      wrapped_key: wk,
    },
  };
}

export function packageHistoryRow(row, recipientId) {
  let meta = {};
  try { meta = JSON.parse(row.meta_json || '{}'); } catch {}
  if (!meta.wrapped_keys?.[recipientId]) return null;
  return {
    id: row.id, type: row.type, mime: row.mime, size: row.size,
    source_device: row.source_id, timestamp: row.timestamp, checksum: row.checksum,
    encrypted_payload: row.payload_b64,
    sender_ephemeral_public: meta.sender_ephemeral_public,
    wrap_salt: meta.wrap_salt,
    wrapped_key: meta.wrapped_keys[recipientId],
  };
}
```

- [ ] **Step 3: Run, commit**

```bash
cd hub && node --test src/__tests__/envelope.test.js
git add hub/src/envelope.js hub/src/__tests__/envelope.test.js
git commit -m "feat(hub): envelope encryption routing helpers"
```

---

## Phase 4 — Hub server + routes integration

### Task 4.1: Update `hub/src/server.js` — envelope, rate limit, revocation

**Files:**
- Modify: `hub/src/server.js`

- [ ] **Step 1: Replace the file**

```javascript
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

import { CONFIG } from './config.js';
import { DB } from './db.js';
import { Auth } from './auth.js';
import { Admin } from './admin.js';
import { ensureTlsCert } from './tls.js';
import { announceService } from './mdns.js';
import { Routes } from './routes.js';
import { log } from './logger.js';
import { TokenBucket, AttemptCounter } from './rate-limit.js';
import { buildPerRecipient, packageHistoryRow } from './envelope.js';
import { OP, isPrivateIp, isValidEnvelope, LIMITS } from '../../shared/protocol.js';

const db   = new DB(CONFIG.DB_PATH);
const auth = new Auth(db);
const admin = new Admin({
  db,
  mode: process.env.CLIPSYNC_ADMIN_MODE || 'token',
  password: process.env.CLIPSYNC_ADMIN_PASSWORD || null,
});
const events = new EventEmitter();
events.setMaxListeners(50);

const adminTokenPrinted = admin.bootstrap();
if (adminTokenPrinted) {
  console.log('\n[clipsync] Admin token (save — shown once):');
  console.log(`[clipsync]   ${adminTokenPrinted}\n`);
}

if (auth.shouldRotate()) {
  log.info('rotating server secret (>30d old)');
  auth.rotateSecret();
}

const tls = ensureTlsCert(CONFIG.TLS_DIR);

const sockets = new Map();
const meta    = new WeakMap();

const pushBucket = new TokenBucket({ capacity: 20, refillPerSec: 5 });
const pinIpCounter = new AttemptCounter({ maxAttempts: 10, windowMs: 60_000 });

function listConnected() {
  const out = [];
  for (const [id, ws] of sockets) {
    const m = meta.get(ws) || {};
    out.push({ id, name: m.name, os: m.os, last_seen: m.lastPong || Date.now() });
  }
  return out;
}

function closeDevice(id, reason) {
  const ws = sockets.get(id);
  if (ws) try { ws.close(1008, reason); } catch {}
  sockets.delete(id);
}

events.on('device:revoked', ({ id }) => closeDevice(id, 'revoked'));

const routes = new Routes({
  db, auth, admin, eventBus: events,
  getDevices: listConnected,
  pinIpCounter,
});

const httpServer = https.createServer(
  { key: tls.key, cert: tls.cert },
  (req, res) => routes.handle(req, res).catch((e) => {
    log.error('route_error', { err: e.message });
    if (!res.headersSent) { res.writeHead(500); res.end('internal'); }
  })
);
httpServer.listen(CONFIG.PORT_HTTP, CONFIG.HOST, () => {
  log.info('https listening', { port: CONFIG.PORT_HTTP, host: CONFIG.HOST });
});

const wssHttp = https.createServer({ key: tls.key, cert: tls.cert });
const wss = new WebSocketServer({ server: wssHttp, maxPayload: LIMITS.FILE_MAX + (1 << 20) });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || '';
  if (!isPrivateIp(ip)) {
    log.warn('rejecting non-private ws connection', { ip });
    ws.close(1008, 'forbidden_ip'); return;
  }
  meta.set(ws, { authed: false });
  ws.on('message', (raw) => onMessage(ws, raw, ip));
  ws.on('close',   ()    => onClose(ws));
  ws.on('error',   (e)   => log.warn('ws_error', { err: e.message }));
  ws.on('pong',    ()    => { const m = meta.get(ws); if (m) m.lastPong = Date.now(); });
});

wssHttp.listen(CONFIG.PORT_WSS, CONFIG.HOST, () => {
  log.info('wss listening', { port: CONFIG.PORT_WSS, host: CONFIG.HOST });
});

setInterval(() => {
  for (const ws of wss.clients) { try { ws.ping(); } catch {} }
}, CONFIG.PING_INTERVAL_MS);

setInterval(() => {
  db.pruneHistory(CONFIG.HISTORY_MAX, CONFIG.HISTORY_TTL_MS);
  auth.cleanExpiredPins();
  pushBucket.cleanup();
  pinIpCounter.cleanup();
  admin.cleanupSessions();
}, 5 * 60 * 1000);

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

function broadcastPeers() {
  const list = [];
  for (const [id, ws] of sockets) {
    const dev = db.getDevice(id);
    if (dev?.public_key) {
      list.push({ id, name: dev.name, public_key: dev.public_key.toString('base64') });
    }
  }
  for (const ws of sockets.values()) {
    send(ws, { op: OP.PEERS, peers: list });
  }
}

function onMessage(ws, raw, ip) {
  let msg;
  try { msg = JSON.parse(raw.toString('utf8')); }
  catch { return send(ws, { op: OP.AUTH_FAIL, reason: 'malformed_json' }); }

  const m = meta.get(ws) || {};

  if (msg.op === OP.REGISTER) {
    const ipHit = pinIpCounter.hit(ip);
    if (!ipHit.allowed) {
      send(ws, { op: OP.AUTH_FAIL, reason: 'rate_limited' });
      return ws.close(1008, 'rate_limited');
    }
    const { pin, name, os: osName, fingerprint, public_key } = msg;
    if (!auth.consumePin(String(pin || ''))) {
      send(ws, { op: OP.AUTH_FAIL, reason: 'invalid_or_expired_pin' });
      return ws.close(1008, 'pin_failed');
    }
    let pkBuf;
    try { pkBuf = Buffer.from(String(public_key || ''), 'base64'); }
    catch { send(ws, { op: OP.AUTH_FAIL, reason: 'invalid_public_key' }); return ws.close(1008); }
    let reg;
    try {
      const isFirstAdmin = admin.mode === 'first-device' && !db.hasAnyAdmin();
      reg = auth.registerDevice({ name, os: osName, fingerprint, publicKey: pkBuf, isAdmin: isFirstAdmin });
    } catch (e) {
      send(ws, { op: OP.AUTH_FAIL, reason: e.message });
      return ws.close(1008);
    }
    log.event('device_registered', { id: reg.id, name, ip });
    events.emit('event', { kind: 'device_registered', id: reg.id, name });
    send(ws, { op: OP.REGISTER_OK, device_id: reg.id, jwt: reg.jwt });
    return ws.close(1000, 'registered');
  }

  if (!m.authed) {
    if (msg.op !== OP.AUTH) {
      send(ws, { op: OP.AUTH_FAIL, reason: 'auth_required' });
      return ws.close(1008, 'auth_required');
    }
    const result = auth.verifyToken(String(msg.token || ''));
    if (!result.ok) {
      send(ws, { op: OP.AUTH_FAIL, reason: result.reason });
      return ws.close(1008, 'auth_failed');
    }
    const dev = result.device;
    const prev = sockets.get(dev.id);
    if (prev && prev !== ws) try { prev.close(1000, 'replaced'); } catch {}
    sockets.set(dev.id, ws);
    meta.set(ws, { authed: true, deviceId: dev.id, name: dev.name, os: dev.os, lastPong: Date.now() });
    db.touchDevice(dev.id);
    const peers = db.listDevicePublicKeys(dev.id).map(p => ({
      id: p.id, public_key: p.public_key.toString('base64'),
    }));
    send(ws, { op: OP.AUTH_OK, device_id: dev.id, devices: listConnected().filter(d => d.id !== dev.id), peers });
    broadcastAll({ op: OP.DEVICE_JOINED, device: { id: dev.id, name: dev.name, os: dev.os } }, dev.id);
    broadcastPeers();
    log.event('device_connected', { id: dev.id, name: dev.name, ip });
    events.emit('event', { kind: 'device_connected', id: dev.id, name: dev.name });
    return;
  }

  switch (msg.op) {
    case OP.PING:
      return send(ws, { op: OP.PONG, t: Date.now() });

    case OP.PUSH: {
      if (!pushBucket.consume(m.deviceId, 1)) {
        return send(ws, { op: OP.ERROR, reason: 'rate_limited' });
      }
      const clip = msg.clip;
      if (!isValidEnvelope(clip)) return send(ws, { op: OP.ERROR, reason: 'invalid_clip' });
      const sizeLimit = { text: LIMITS.TEXT_MAX, url: LIMITS.TEXT_MAX, image: LIMITS.IMAGE_MAX, file: LIMITS.FILE_MAX };
      if (clip.size && clip.size > (sizeLimit[clip.type] ?? LIMITS.FILE_MAX)) {
        return send(ws, { op: OP.ERROR, reason: 'too_large' });
      }
      const inserted = db.insertHistory({
        id: clip.id, type: clip.type, mime: clip.mime || null, size: clip.size || 0,
        source_id: m.deviceId, timestamp: clip.timestamp || Date.now(),
        checksum: clip.checksum || null, payload_b64: clip.encrypted_payload,
        meta_json: JSON.stringify({
          name: clip.name || null,
          sender_ephemeral_public: clip.sender_ephemeral_public,
          wrap_salt: clip.wrap_salt,
          wrapped_keys: clip.wrapped_keys,
        }),
      });
      if (!inserted) return send(ws, { op: OP.ERROR, reason: 'duplicate_id' });

      // Per-recipient broadcast
      for (const [id, peerWs] of sockets) {
        if (id === m.deviceId) continue;
        const out = buildPerRecipient(clip, id, m.deviceId);
        if (out) try { peerWs.send(JSON.stringify(out)); } catch {}
      }
      log.event('clip_pushed', { id: clip.id, type: clip.type, size: clip.size, from: m.deviceId });
      events.emit('event', { kind: 'clip', id: clip.id, type: clip.type, size: clip.size, from: m.deviceId, timestamp: clip.timestamp });
      return;
    }

    case OP.HISTORY_REQ: {
      const limit = Math.min(parseInt(msg.limit ?? 10, 10), 50);
      const rows = db.recentHistory(limit)
        .map((r) => packageHistoryRow(r, m.deviceId))
        .filter(Boolean);
      return send(ws, { op: OP.HISTORY, items: rows });
    }

    default:
      send(ws, { op: OP.ERROR, reason: 'unknown_op' });
  }
}

function broadcastAll(obj, exceptDeviceId) {
  const json = JSON.stringify(obj);
  for (const [id, ws] of sockets) {
    if (id === exceptDeviceId) continue;
    try { ws.send(json); } catch {}
  }
}

function onClose(ws) {
  const m = meta.get(ws);
  if (m && m.deviceId) {
    if (sockets.get(m.deviceId) === ws) sockets.delete(m.deviceId);
    broadcastAll({ op: OP.DEVICE_LEFT, device_id: m.deviceId });
    broadcastPeers();
    log.event('device_disconnected', { id: m.deviceId });
    events.emit('event', { kind: 'device_disconnected', id: m.deviceId });
  }
}

const mdns = announceService({
  port: CONFIG.PORT_WSS, name: CONFIG.HUB_NAME,
  txt: { v: '2', http: String(CONFIG.PORT_HTTP) },
});

log.info('clipsync hub started', {
  hub: CONFIG.HUB_NAME, wss: CONFIG.PORT_WSS, http: CONFIG.PORT_HTTP, dataDir: CONFIG.DATA_DIR,
});
console.log('\nClipSync Hub running.');
console.log(`  Dashboard:  https://localhost:${CONFIG.PORT_HTTP}/admin`);
console.log(`  PWA:        https://localhost:${CONFIG.PORT_HTTP}/`);
console.log(`  WSS:        wss://localhost:${CONFIG.PORT_WSS}\n`);

async function shutdown() {
  log.info('shutting_down');
  try { await mdns.stop(); } catch {}
  for (const ws of wss.clients) { try { ws.close(1001, 'shutdown'); } catch {} }
  httpServer.close();
  wssHttp.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 2: Commit**

```bash
git add hub/src/server.js
git commit -m "feat(hub): envelope routing, rate limiting, revoke close, peer broadcast"
```

---

### Task 4.2: Update `hub/src/routes.js` — admin middleware, login, CORS allowlist

**Files:**
- Modify: `hub/src/routes.js`

- [ ] **Step 1: Replace `Routes` class**

```javascript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { isPrivateIp } from '../../shared/protocol.js';
import { CONFIG } from './config.js';
import { parseCookie } from './admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const PWA_DIR    = path.resolve(__dirname, '..', '..', 'client-pwa');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function primaryLanIp() {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) return reject(new Error('too_large'));
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export class Routes {
  constructor({ db, auth, admin, eventBus, getDevices, pinIpCounter }) {
    this.db = db; this.auth = auth; this.admin = admin;
    this.events = eventBus; this.getDevices = getDevices;
    this.pinIpCounter = pinIpCounter;
    this.sseClients = new Set();
    eventBus.on('event', (ev) => this.#sseBroadcast(ev));
    this.allowedOrigin = `https://${primaryLanIp()}:${CONFIG.PORT_HTTP}`;
  }

  #sseBroadcast(ev) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(line); } catch { this.sseClients.delete(res); }
    }
  }

  #checkPrivate(req, res) {
    const ip = req.socket.remoteAddress || '';
    if (!isPrivateIp(ip)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden — non-private IP');
      return false;
    }
    return true;
  }

  #checkOrigin(req, res) {
    const origin = req.headers.origin;
    if (origin && origin !== this.allowedOrigin) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden origin');
      return false;
    }
    return true;
  }

  #isAdmin(req) {
    if (this.admin.mode === 'first-device') {
      // Bearer JWT of an admin device
      const auth = req.headers.authorization || '';
      const m = /^Bearer (.+)$/.exec(auth);
      if (!m) return false;
      const v = this.auth.verifyToken(m[1]);
      return v.ok && !!v.device.is_admin;
    }
    const sid = parseCookie(req.headers.cookie, 'admin_session');
    return this.admin.verifySession(sid);
  }

  async handle(req, res) {
    if (!this.#checkPrivate(req, res)) return;
    if (!this.#checkOrigin(req, res)) return;

    const u = new URL(req.url, 'https://localhost');
    const pathname = u.pathname;

    res.setHeader('access-control-allow-origin', this.allowedOrigin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // PWA static
    if (pathname === '/' || pathname === '/pwa') {
      return this.#sendFile(res, path.join(PWA_DIR, 'index.html'));
    }
    if (pathname.startsWith('/pwa/')) {
      const f = path.join(PWA_DIR, pathname.replace(/^\/pwa\//, ''));
      if (f.startsWith(PWA_DIR)) return this.#sendFile(res, f);
    }
    if (pathname === '/manifest.webmanifest' || pathname === '/sw.js') {
      return this.#sendFile(res, path.join(PWA_DIR, pathname.slice(1)));
    }

    // Admin dashboard
    if (pathname === '/admin') return this.#sendFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    if (pathname.startsWith('/admin/')) {
      const f = path.join(PUBLIC_DIR, pathname.replace(/^\/admin\//, ''));
      if (f.startsWith(PUBLIC_DIR)) return this.#sendFile(res, f);
    }

    // Admin login (open)
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const body = await readJson(req).catch(() => null);
      if (!body) return this.#json(res, 400, { error: 'invalid_json' });
      if (!this.admin.verifyCredential(body.credential)) {
        return this.#json(res, 401, { error: 'invalid_credential' });
      }
      const sid = this.admin.issueSession();
      res.setHeader('set-cookie', `admin_session=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${8*60*60}`);
      return this.#json(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      const sid = parseCookie(req.headers.cookie, 'admin_session');
      if (sid) this.admin.revokeSession(sid);
      res.setHeader('set-cookie', 'admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
      return this.#json(res, 200, { ok: true });
    }
    if (pathname === '/api/admin/whoami') {
      return this.#json(res, 200, { mode: this.admin.mode, authed: this.#isAdmin(req) });
    }

    // Open
    if (pathname === '/api/status') {
      return this.#json(res, 200, {
        ok: true, hub: os.hostname(), devices: this.getDevices(),
        history_count: this.db.countHistory(), time: Date.now(),
      });
    }
    if (pathname === '/api/config' && req.method === 'GET') {
      return this.#json(res, 200, {
        history_max: CONFIG.HISTORY_MAX, history_ttl_ms: CONFIG.HISTORY_TTL_MS,
        protocol_version: 2,
      });
    }

    // PIN-based registration (open — PIN is the secret)
    if (pathname === '/api/register' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || '';
      const ipHit = this.pinIpCounter.hit(ip);
      if (!ipHit.allowed) return this.#json(res, 429, { error: 'rate_limited', reset_at: ipHit.resetAt });

      const body = await readJson(req).catch(() => null);
      if (!body) return this.#json(res, 400, { error: 'invalid_json' });
      const { pin, name, os: osName, fingerprint, public_key } = body;
      if (!this.auth.consumePin(String(pin || ''))) {
        return this.#json(res, 401, { error: 'invalid_or_expired_pin' });
      }
      let pkBuf;
      try { pkBuf = Buffer.from(String(public_key || ''), 'base64'); }
      catch { return this.#json(res, 400, { error: 'invalid_public_key' }); }
      let reg;
      try {
        const isFirstAdmin = this.admin.mode === 'first-device' && !this.db.hasAnyAdmin();
        reg = this.auth.registerDevice({ name, os: osName, fingerprint, publicKey: pkBuf, isAdmin: isFirstAdmin });
      } catch (e) {
        return this.#json(res, 400, { error: e.message });
      }
      this.events.emit('event', { kind: 'device_registered', id: reg.id, name });
      return this.#json(res, 200, reg);
    }

    // ────── PROTECTED (admin only) ──────
    if (pathname.startsWith('/api/devices') ||
        pathname === '/api/history'         ||
        pathname === '/api/pin'             ||
        pathname === '/api/qr'              ||
        pathname === '/api/events') {
      if (!this.#isAdmin(req)) return this.#json(res, 401, { error: 'admin_required' });
    }

    if (pathname === '/api/devices' && req.method === 'GET') {
      return this.#json(res, 200, { devices: this.db.listDevices() });
    }
    if (pathname.match(/^\/api\/devices\/[^/]+$/) && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      this.auth.revokeDevice(id);
      this.events.emit('event', { kind: 'device_revoked', id });
      this.events.emit('device:revoked', { id });
      return this.#json(res, 200, { ok: true });
    }
    if (pathname === '/api/history' && req.method === 'GET') {
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '20', 10), 50);
      const items = this.db.recentHistory(limit).map(r => ({
        id: r.id, type: r.type, mime: r.mime, size: r.size,
        source_id: r.source_id, timestamp: r.timestamp, checksum: r.checksum,
      }));
      return this.#json(res, 200, { items });
    }
    if (pathname === '/api/history' && req.method === 'DELETE') {
      this.db.clearHistory();
      this.events.emit('event', { kind: 'history_cleared' });
      return this.#json(res, 200, { ok: true });
    }
    if (pathname === '/api/pin' && req.method === 'POST') {
      const { pin, expiresAt } = this.auth.issuePin();
      this.events.emit('event', { kind: 'pin_issued', expiresAt });
      return this.#json(res, 200, { pin, expiresAt });
    }
    if (pathname === '/api/qr' && req.method === 'GET') {
      const { pin, expiresAt } = this.auth.issuePin();
      const ip = primaryLanIp();
      const wssUrl = `wss://${ip}:${CONFIG.PORT_WSS}`;
      const certFp = this.db.getMeta('cert_fingerprint') || '';
      const payload = JSON.stringify({ v: 2, hub: wssUrl, pin, fp: certFp });
      const dataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, scale: 8 });
      return this.#json(res, 200, { pin, expiresAt, qr: dataUrl, payload, hub: wssUrl, fp: certFp });
    }
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`: connected\n\n`);
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  #sendFile(res, p) {
    const ext = path.extname(p).toLowerCase();
    const stream = fs.createReadStream(p);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      } else res.destroy();
    });
    stream.on('open', () => {
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
      stream.pipe(res);
    });
  }
  #json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }
}
```

- [ ] **Step 2: Update `hub/src/tls.js` to record cert fingerprint**

Append after cert generation in `ensureTlsCert()` (or add a helper `recordCertFingerprint(db, certPem)`):

```javascript
import crypto from 'node:crypto';
export function fingerprintOf(certPem) {
  const der = Buffer.from(certPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  return crypto.createHash('sha256').update(der).digest('hex').match(/../g).join(':').toUpperCase();
}
```

In `server.js` after `ensureTlsCert`, add:

```javascript
import { fingerprintOf } from './tls.js';
const certFp = fingerprintOf(tls.cert.toString());
db.setMeta('cert_fingerprint', certFp);
log.info('cert fingerprint', { fp: certFp });
```

- [ ] **Step 3: Run hub tests**

```bash
cd hub && npm test
```

- [ ] **Step 4: Commit**

```bash
git add hub/src/routes.js hub/src/server.js hub/src/tls.js
git commit -m "feat(hub): admin middleware, CORS allowlist, login, cert fingerprint"
```

---

### Task 4.3: Update `hub/public/admin.html` with login form

**Files:**
- Modify: `hub/public/admin.html`

- [ ] **Step 1: Read current admin.html, add login overlay and auth-aware fetch**

Open the existing file and add at the top of `<body>`:

```html
<div id="login-overlay" style="display:none; position:fixed; inset:0; background:#0008; z-index:1000;">
  <div style="background:#1e1e1e; color:#eee; max-width:420px; margin:80px auto; padding:24px; border-radius:8px;">
    <h2 style="margin-top:0">Admin login</h2>
    <p id="login-mode" style="opacity:.7; font-size:.9em"></p>
    <input id="login-cred" type="password" placeholder="Admin token / password" style="width:100%; padding:8px; box-sizing:border-box;" />
    <button id="login-btn" style="margin-top:8px; padding:8px 16px;">Sign in</button>
    <p id="login-err" style="color:#f66; margin-top:8px; min-height:1.2em;"></p>
  </div>
</div>
<script>
async function whoami() {
  const r = await fetch('/api/admin/whoami', { credentials: 'include' });
  return r.json();
}
async function login(cred) {
  const r = await fetch('/api/admin/login', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: cred }),
  });
  return r.ok;
}
(async () => {
  const w = await whoami();
  if (!w.authed && w.mode !== 'first-device') {
    document.getElementById('login-overlay').style.display = 'block';
    document.getElementById('login-mode').textContent = 'Mode: ' + w.mode;
    document.getElementById('login-btn').onclick = async () => {
      const cred = document.getElementById('login-cred').value;
      if (await login(cred)) location.reload();
      else document.getElementById('login-err').textContent = 'invalid credential';
    };
  }
})();
// Patch all fetch calls to include credentials
const _fetch = window.fetch;
window.fetch = (u, o = {}) => _fetch(u, { credentials: 'include', ...o });
</script>
```

- [ ] **Step 2: Commit**

```bash
git add hub/public/admin.html
git commit -m "feat(admin-ui): login overlay and credentialed fetch"
```

---

## Phase 5 — Desktop client envelope + TOFU

### Task 5.1: Update `client-desktop/src/store.js` with new fields

**Files:**
- Modify: `client-desktop/src/store.js`

- [ ] **Step 1: Add new fields documentation comment**

Replace file:

```javascript
// Persistent local store. Fields:
//   device_id, jwt, hub_url, hub_cert_fp,
//   x25519_private_b64, x25519_public_b64
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = process.env.CLIPSYNC_CLIENT_DIR
  || path.join(os.homedir(), '.config', 'clipsync', 'client');
const FILE = path.join(dir, 'state.json');

export function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}
export function save(state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}
export function clear() {
  try { fs.unlinkSync(FILE); } catch {}
}
export const STATE_DIR = dir;
```

- [ ] **Step 2: Commit**

```bash
git add client-desktop/src/store.js
git commit -m "feat(client): document new state fields"
```

---

### Task 5.2: Rewrite `client-desktop/src/register.js` to use X25519

**Files:**
- Modify: `client-desktop/src/register.js`

- [ ] **Step 1: Read current register.js, then replace**

```javascript
#!/usr/bin/env node
// Interactive PIN-based registration. Generates X25519 keypair on first run.
import readline from 'node:readline/promises';
import https from 'node:https';
import os from 'node:os';
import { load, save } from './store.js';
import { findHub } from './discovery.js';
import { generateX25519 } from '../../shared/crypto-node.js';

async function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      method: 'POST',
      host: u.hostname, port: u.port, path: u.pathname,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      rejectUnauthorized: false,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('ClipSync registration\n');

  let state = load();
  if (!state.x25519_private_b64) {
    const kp = generateX25519();
    state.x25519_private_b64 = kp.privateKey.toString('base64');
    state.x25519_public_b64  = kp.publicKey.toString('base64');
  }

  // Hub URL
  let hubUrl = state.hub_url;
  if (!hubUrl) {
    console.log('Searching hub via mDNS...');
    const found = await findHub({ timeoutMs: 5000 });
    if (found) hubUrl = found.url;
  }
  if (!hubUrl) hubUrl = await rl.question('Hub WSS URL (e.g. wss://192.168.1.10:5678): ');
  const httpBase = hubUrl.replace(/^wss:/, 'https:').replace(/:(\d+)$/, ':5679');

  const pin  = (await rl.question('PIN: ')).trim();
  const name = (await rl.question(`Device name [${os.hostname()}]: `)).trim() || os.hostname();

  const r = await postJson(httpBase + '/api/register', {
    pin, name, os: process.platform, fingerprint: null,
    public_key: state.x25519_public_b64,
  });
  if (r.status !== 200) { console.error('registration failed:', r.body); process.exit(1); }

  state.hub_url = hubUrl;
  state.device_id = r.body.id;
  state.jwt = r.body.jwt;
  save(state);
  console.log(`OK — device ${r.body.id.slice(0,8)} registered.`);
  rl.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add client-desktop/src/register.js
git commit -m "feat(client): X25519 registration flow"
```

---

### Task 5.3: Update `client-desktop/src/ws-client.js` with TOFU pinning

**Files:**
- Modify: `client-desktop/src/ws-client.js`

- [ ] **Step 1: Replace file**

```javascript
import WebSocket from 'ws';
import { OP } from '../../shared/protocol.js';

export class WsClient {
  constructor({ url, jwt, expectedFp = null, onPinFp, onOpen, onMessage, onClose, onCertMismatch }) {
    this.url = url;
    this.jwt = jwt;
    this.expectedFp = expectedFp;
    this.onPinFp = onPinFp || (() => {});
    this.onOpen = onOpen || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    this.onCertMismatch = onCertMismatch || (() => {});
    this.ws = null;
    this.reconnectMs = 1000;
    this.maxReconnectMs = 30_000;
    this.shouldRun = false;
    this.alive = false;
  }

  start() { this.shouldRun = true; this.connect(); }
  stop()  { this.shouldRun = false; try { this.ws?.close(1000, 'stopping'); } catch {} }

  connect() {
    if (!this.shouldRun) return;
    const ws = new WebSocket(this.url, { rejectUnauthorized: false });
    this.ws = ws;
    let certVerified = false;

    ws.on('upgrade', (response) => {
      const cert = response.socket.getPeerCertificate();
      const fp = (cert?.fingerprint256 || '').toUpperCase();
      if (this.expectedFp && this.expectedFp !== fp) {
        this.onCertMismatch({ expected: this.expectedFp, got: fp });
        try { ws.close(1008, 'cert_mismatch'); } catch {}
        return;
      }
      if (!this.expectedFp && fp) { this.onPinFp(fp); this.expectedFp = fp; }
      certVerified = true;
    });
    ws.on('open', () => {
      if (!certVerified) return;
      this.send({ op: OP.AUTH, token: this.jwt });
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (m.op === OP.AUTH_OK) { this.alive = true; this.reconnectMs = 1000; this.onOpen(m); return; }
      if (m.op === OP.AUTH_FAIL) { this.alive = false; this.onMessage(m); return; }
      this.onMessage(m);
    });
    ws.on('close', (code, reason) => {
      this.alive = false;
      this.onClose({ code, reason: reason.toString() });
      if (!this.shouldRun) return;
      const wait = this.reconnectMs + Math.random() * this.reconnectMs * 0.3;
      this.reconnectMs = Math.min(this.reconnectMs * 2, this.maxReconnectMs);
      setTimeout(() => this.connect(), wait);
    });
    ws.on('error', () => {});
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; }
    catch { return false; }
  }
  ping() { this.send({ op: OP.PING }); }
}
```

- [ ] **Step 2: Commit**

```bash
git add client-desktop/src/ws-client.js
git commit -m "feat(client): TOFU TLS fingerprint pinning"
```

---

### Task 5.4: Rewrite `client-desktop/src/main.js` for envelope encryption

**Files:**
- Modify: `client-desktop/src/main.js`
- Delete: `client-desktop/src/crypto-bridge.js`

- [ ] **Step 1: Replace main.js**

```javascript
#!/usr/bin/env node
import os from 'node:os';
import crypto from 'node:crypto';
import {
  generateX25519, deriveSharedKey, encryptAesGcm, decryptAesGcm,
  randomBytes, sha256Hex,
} from '../../shared/crypto-node.js';
import { load, save, clear } from './store.js';
import { findHub } from './discovery.js';
import { WsClient } from './ws-client.js';
import { ClipboardMonitor } from './clipboard.js';
import { OP, LIMITS } from '../../shared/protocol.js';

async function main() {
  const state = load();
  if (!state.jwt || !state.x25519_private_b64) {
    console.log('Not registered. Run `npm run register`.');
    process.exit(1);
  }

  const myPriv = Buffer.from(state.x25519_private_b64, 'base64');

  let hubUrl = state.hub_url;
  const fresh = await findHub({ timeoutMs: 4000 });
  if (fresh && fresh.url) hubUrl = fresh.url;
  console.log(`[clipsync] connecting to ${hubUrl}`);

  // Map<deviceId, publicKeyBuffer>
  let peers = new Map();

  const monitor = new ClipboardMonitor({ onChange: (item) => publishLocal(item) });

  const client = new WsClient({
    url: hubUrl,
    jwt: state.jwt,
    expectedFp: state.hub_cert_fp || null,
    onPinFp: (fp) => {
      state.hub_cert_fp = fp; save(state);
      console.log(`[clipsync] pinned hub cert fingerprint`);
    },
    onCertMismatch: ({ expected, got }) => {
      console.error(`[clipsync] CERT MISMATCH — expected ${expected}, got ${got}`);
      console.error('[clipsync] refusing to connect. Manual review required.');
      process.exit(3);
    },
    onOpen: (msg) => {
      console.log(`[clipsync] connected — device ${msg.device_id.slice(0, 8)} | peers: ${(msg.peers || []).length}`);
      peers = new Map((msg.peers || []).map(p => [p.id, Buffer.from(p.public_key, 'base64')]));
      monitor.start();
      client.send({ op: OP.HISTORY_REQ, limit: 5 });
    },
    onMessage: handleMessage,
    onClose: ({ code, reason }) => {
      console.log(`[clipsync] disconnected (${code}) ${reason || ''} — will reconnect`);
      monitor.stop();
    },
  });
  client.start();

  function publishLocal({ type, mime, data, checksum }) {
    if (data.length > LIMITS.FILE_MAX) return;
    if (peers.size === 0) return; // no recipients

    const contentKey = randomBytes(32);
    const encryptedPayload = encryptAesGcm(contentKey, data);
    const eph = generateX25519();
    const wrapSalt = randomBytes(16);
    const wrappedKeys = {};
    for (const [pid, pub] of peers) {
      const wk = deriveSharedKey(eph.privateKey, pub, wrapSalt, 'clipsync-v1');
      wrappedKeys[pid] = encryptAesGcm(wk, contentKey).toString('base64');
    }

    client.send({
      op: OP.PUSH,
      clip: {
        id: crypto.randomUUID(), type, mime,
        size: data.length, timestamp: Date.now(), checksum,
        encrypted_payload: encryptedPayload.toString('base64'),
        sender_ephemeral_public: eph.publicKey.toString('base64'),
        wrap_salt: wrapSalt.toString('base64'),
        wrapped_keys: wrappedKeys,
      },
    });
  }

  function decryptIncoming(c) {
    const senderPub = Buffer.from(c.sender_ephemeral_public, 'base64');
    const wrapSalt  = Buffer.from(c.wrap_salt, 'base64');
    const wk = deriveSharedKey(myPriv, senderPub, wrapSalt, 'clipsync-v1');
    const contentKey = decryptAesGcm(wk, Buffer.from(c.wrapped_key, 'base64'));
    return decryptAesGcm(contentKey, Buffer.from(c.encrypted_payload, 'base64'));
  }

  function handleMessage(m) {
    if (m.op === OP.PEERS) {
      peers = new Map(m.peers.map(p => [p.id, Buffer.from(p.public_key, 'base64')]));
      return;
    }
    if (m.op === OP.BROADCAST) {
      const c = m.clip;
      try {
        const buf = decryptIncoming(c);
        if (c.checksum && sha256Hex(buf) !== c.checksum) {
          console.warn('[clipsync] checksum mismatch'); return;
        }
        monitor.write({ type: c.type, mime: c.mime, data: buf })
          .then(() => console.log(`[clipsync] ← ${c.type} (${buf.length}b)`))
          .catch((e) => console.warn('[clipsync] write failed:', e.message));
      } catch (e) { console.warn('[clipsync] decrypt failed:', e.message); }
      return;
    }
    if (m.op === OP.HISTORY) {
      console.log(`[clipsync] history sync: ${m.items.length} items`);
      return;
    }
    if (m.op === OP.AUTH_FAIL) {
      console.error('[clipsync] auth failed:', m.reason);
      if (m.reason === 'revoked' || m.reason === 'device_revoked') {
        clear();
        console.error('[clipsync] device revoked. cleared local state.');
        process.exit(2);
      }
    }
  }

  process.on('SIGINT',  () => { client.stop(); monitor.stop(); process.exit(0); });
  process.on('SIGTERM', () => { client.stop(); monitor.stop(); process.exit(0); });
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Delete crypto-bridge.js**

```bash
rm client-desktop/src/crypto-bridge.js
```

- [ ] **Step 3: Commit**

```bash
git add client-desktop/src/main.js client-desktop/src/crypto-bridge.js
git commit -m "feat(client): envelope encryption + TOFU pinning + remove crypto-bridge"
```

---

## Phase 6 — PWA envelope + IndexedDB

### Task 6.1: Rewrite `client-pwa/app.js` with envelope encryption + IndexedDB

**Files:**
- Modify: `client-pwa/app.js`

- [ ] **Step 1: Replace file**

```javascript
const STATE_KEY = 'clipsync_state_v2';
const DB_NAME = 'clipsync';
const DB_STORE = 'keys';
const $ = (id) => document.getElementById(id);

let state = {};
let ws = null;
let connected = false;
let latest = null;
let history = [];
let reconnectMs = 1000;
let myKeyPair = null;     // { privateKey: CryptoKey, publicKeyB64 }
let peers = new Map();    // deviceId -> CryptoKey (x25519 public)

function loadState() { try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch { return {}; } }
function saveState(s) { localStorage.setItem(STATE_KEY, JSON.stringify(s)); }
function clearState() { localStorage.removeItem(STATE_KEY); }

// ─── IndexedDB for non-extractable keys ───
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, val) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const r = tx.objectStore(DB_STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

// ─── UI helpers ───
function setStatus(text, ok = true) {
  const c = ok ? 'text-emerald-400' : 'text-rose-400';
  $('status').innerHTML = `<span class="${c} pulse-dot inline-block">●</span> ${text}`;
}
function showRegister() {
  $('register').classList.remove('hidden');
  $('compose').classList.add('hidden');
  $('latest').classList.add('hidden');
  $('history-sec').classList.add('hidden');
}
function showMain() {
  $('register').classList.add('hidden');
  $('compose').classList.remove('hidden');
  $('history-sec').classList.remove('hidden');
}
function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB']; let i=0; let n=b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

// ─── Crypto ───
async function ensureKeypair() {
  let priv = await idbGet('x25519_private');
  let pubB64 = (await idbGet('x25519_public_b64')) || null;
  if (!priv) {
    const kp = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    priv = kp.privateKey;
    const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
    pubB64 = btoa(String.fromCharCode(...new Uint8Array(pubRaw)));
    await idbPut('x25519_private', priv);
    await idbPut('x25519_public_b64', pubB64);
  }
  myKeyPair = { privateKey: priv, publicKeyB64: pubB64 };
}

async function importPublicKey(b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'X25519' }, false, []);
}

async function deriveAesKey(myPriv, peerPub, salt, info) {
  const shared = await crypto.subtle.deriveBits(
    { name: 'X25519', public: peerPub }, myPriv, 256
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// Layout: [iv:12][tag:16][ct]   (Web Crypto returns ct||tag — we split)
async function aesGcmEncrypt(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
  const tag = ctTag.subarray(ctTag.length - 16);
  const ct  = ctTag.subarray(0, ctTag.length - 16);
  const out = new Uint8Array(iv.length + tag.length + ct.length);
  out.set(iv, 0); out.set(tag, iv.length); out.set(ct, iv.length + tag.length);
  return out;
}
async function aesGcmDecrypt(key, buf) {
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const ctTag = new Uint8Array(ct.length + tag.length);
  ctTag.set(ct, 0); ctTag.set(tag, ct.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctTag));
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(s);
}
function b64ToBytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2,'0')).join('');
}

// ─── Registration ───
async function registerDevice() {
  await ensureKeypair();
  const url  = $('hub-url').value.trim();
  const pin  = $('pin-input').value.trim();
  const name = $('device-name').value.trim() || 'Browser';
  if (!url || !pin) { $('register-msg').textContent = 'hub URL and PIN required'; return; }

  const httpsBase = url.replace(/^wss:/, 'https:').replace(/:(\d+)$/, ':5679');

  try {
    const r = await fetch(httpsBase + '/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pin, name, os: navigator.platform || 'browser', fingerprint: null,
        public_key: myKeyPair.publicKeyB64,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      $('register-msg').textContent = 'failed: ' + (j.error || r.status);
      return;
    }
    const reg = await r.json();
    state = { hub_url: url, http_base: httpsBase, device_id: reg.id, jwt: reg.jwt };
    saveState(state);
    showMain(); connect();
  } catch (e) { $('register-msg').textContent = 'error: ' + e.message; }
}

// ─── WS ───
function connect() {
  if (!state.jwt) return showRegister();
  setStatus('connecting…');
  ws = new WebSocket(state.hub_url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => ws.send(JSON.stringify({ op: 'auth', token: state.jwt }));
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.op === 'auth_ok') {
      connected = true; reconnectMs = 1000;
      setStatus(`connected · ${(m.peers || []).length} peer(s)`);
      peers.clear();
      for (const p of (m.peers || [])) peers.set(p.id, await importPublicKey(p.public_key));
      ws.send(JSON.stringify({ op: 'history_request', limit: 20 }));
      return;
    }
    if (m.op === 'peers') {
      peers.clear();
      for (const p of (m.peers || [])) if (p.id !== state.device_id) peers.set(p.id, await importPublicKey(p.public_key));
      return;
    }
    if (m.op === 'auth_fail') {
      setStatus('auth failed: ' + m.reason, false);
      if (m.reason === 'revoked' || m.reason === 'device_revoked') { clearState(); state = {}; showRegister(); }
      return;
    }
    if (m.op === 'broadcast' && m.clip) await ingestClip(m.clip);
    if (m.op === 'history' && m.items) for (const c of m.items.reverse()) await ingestClip(c, true);
  };
  ws.onclose = () => {
    connected = false;
    setStatus('disconnected — reconnecting…', false);
    setTimeout(() => { reconnectMs = Math.min(reconnectMs * 2, 30000); connect(); }, reconnectMs);
  };
  ws.onerror = () => {};
}

async function ingestClip(c, silent = false) {
  try {
    const senderPub = await importPublicKey(c.sender_ephemeral_public);
    const wrapSalt  = b64ToBytes(c.wrap_salt);
    const wrapKey   = await deriveAesKey(myKeyPair.privateKey, senderPub, wrapSalt, 'clipsync-v1');
    const contentKeyBytes = await aesGcmDecrypt(wrapKey, b64ToBytes(c.wrapped_key));
    const contentKey = await crypto.subtle.importKey('raw', contentKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const buf = await aesGcmDecrypt(contentKey, b64ToBytes(c.encrypted_payload));
    const item = {
      id: c.id, type: c.type, mime: c.mime, size: c.size,
      timestamp: c.timestamp, source: c.source_device, buf,
      text: (c.type === 'text' || c.type === 'url') ? new TextDecoder().decode(buf) : null,
    };
    history.unshift(item);
    if (history.length > 30) history.pop();
    latest = item;
    renderLatest(); renderHistory();
    if (!silent) flash();
  } catch (e) { console.warn('ingest failed:', e.message); }
}

function flash() {
  document.body.style.boxShadow = 'inset 0 0 0 2px rgba(244,162,45,.55)';
  setTimeout(() => document.body.style.boxShadow = '', 350);
}
function renderLatest() {
  if (!latest) return;
  $('latest').classList.remove('hidden');
  const c = $('latest-content'); c.innerHTML = '';
  if (latest.type === 'image') {
    const blob = new Blob([latest.buf], { type: latest.mime || 'image/png' });
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.className = 'max-w-full rounded';
    c.appendChild(img);
  } else {
    const pre = document.createElement('div');
    pre.className = 'whitespace-pre-wrap break-all text-sm font-mono text-slate-300';
    pre.textContent = latest.text || '';
    c.appendChild(pre);
  }
  const meta = document.createElement('div');
  meta.className = 'mt-2 mono text-xs text-slate-500';
  meta.textContent = `${latest.type} · ${fmtSize(latest.size)} · ${new Date(latest.timestamp).toLocaleTimeString()}`;
  c.appendChild(meta);
}
function renderHistory() {
  $('history-sec').classList.remove('hidden');
  const ul = $('history-list'); ul.innerHTML = '';
  for (const it of history.slice(0, 20)) {
    const li = document.createElement('li');
    li.className = 'bg-slate-900/50 border border-slate-800 rounded p-2 cursor-pointer hover:border-amber-500/40';
    li.innerHTML = `
      <div class="flex justify-between items-center">
        <span class="mono text-xs uppercase text-amber-400">${it.type}</span>
        <span class="mono text-xs text-slate-500">${new Date(it.timestamp).toLocaleTimeString()}</span>
      </div>
      <div class="mt-1 text-sm truncate text-slate-300">${
        it.type === 'image' ? `image · ${fmtSize(it.size)}`
                            : (it.text || '').slice(0, 80).replace(/</g, '&lt;')
      }</div>`;
    li.onclick = async () => { await copyItem(it); flash(); };
    ul.appendChild(li);
  }
}
async function copyItem(item) {
  try {
    if (item.type === 'image' && navigator.clipboard?.write) {
      const blob = new Blob([item.buf], { type: item.mime || 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } else {
      await navigator.clipboard.writeText(item.text || '');
    }
  } catch (e) { alert('clipboard write failed: ' + e.message); }
}

async function sendText() {
  const txt = $('compose-text').value;
  if (!txt) return;
  if (peers.size === 0) { alert('no peers connected'); return; }
  const buf = new TextEncoder().encode(txt);
  const checksum = await sha256Hex(buf);

  const contentKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const contentKey = await crypto.subtle.importKey('raw', contentKeyRaw, { name: 'AES-GCM' }, false, ['encrypt']);
  const encryptedPayload = await aesGcmEncrypt(contentKey, buf);

  const eph = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const wrapSalt = crypto.getRandomValues(new Uint8Array(16));
  const wrappedKeys = {};
  for (const [pid, pub] of peers) {
    const wk = await deriveAesKey(eph.privateKey, pub, wrapSalt, 'clipsync-v1');
    const wrapped = await aesGcmEncrypt(wk, contentKeyRaw);
    wrappedKeys[pid] = bytesToB64(wrapped);
  }

  const isUrl = /^https?:\/\//.test(txt.trim()) && txt.trim().length < 2048;
  ws.send(JSON.stringify({
    op: 'push',
    clip: {
      id: crypto.randomUUID(),
      type: isUrl ? 'url' : 'text',
      mime: isUrl ? 'text/uri-list' : 'text/plain',
      size: buf.byteLength,
      timestamp: Date.now(),
      checksum,
      encrypted_payload: bytesToB64(encryptedPayload),
      sender_ephemeral_public: bytesToB64(ephPubRaw),
      wrap_salt: bytesToB64(wrapSalt),
      wrapped_keys: wrappedKeys,
    },
  }));
  $('compose-text').value = '';
  flash();
}

async function pasteFromClipboard() {
  try { const txt = await navigator.clipboard.readText(); if (txt) $('compose-text').value = txt; }
  catch (e) { alert('clipboard read failed: ' + e.message); }
}
async function copyLatest() { if (!latest) return; await copyItem(latest); flash(); }

// ─── Wire up ───
$('btn-register').addEventListener('click', registerDevice);
$('btn-send').addEventListener('click', sendText);
$('btn-paste').addEventListener('click', pasteFromClipboard);
$('btn-copy').addEventListener('click', copyLatest);
$('btn-config').addEventListener('click', () => { if (confirm('Forget device?')) { clearState(); location.reload(); } });

const params = new URLSearchParams(location.search);
if (params.has('share')) {
  const t = params.get('text') || params.get('url') || params.get('title') || '';
  if (t) $('compose-text').value = t;
}

const guessedUrl = `wss://${location.hostname}:5678`;
state = loadState();
if (!state.jwt) $('hub-url').value = guessedUrl;

(async () => {
  await ensureKeypair();
  if (state.jwt) { showMain(); connect(); }
  else { showRegister(); setStatus('not registered', false); }
})();
```

- [ ] **Step 2: Commit**

```bash
git add client-pwa/app.js
git commit -m "feat(pwa): envelope encryption + non-extractable keys in IndexedDB"
```

---

## Phase 7 — OS auto-start scripts

### Task 7.1: macOS launchd installer

**Files:**
- Modify: `scripts/install-mac.sh`
- Create: `scripts/templates/com.clipsync.daemon.plist.tmpl`

- [ ] **Step 1: Create plist template**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.clipsync.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__INSTALL_DIR__/client-desktop/src/main.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>__HOME__/.config/clipsync/client/daemon.log</string>
  <key>StandardErrorPath</key><string>__HOME__/.config/clipsync/client/daemon.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 2: Update install-mac.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "this installer needs sudo (only for /opt/clipsync)"; exec sudo -E "$0" "$@"
fi
REAL_USER="${SUDO_USER:-$USER}"
REAL_HOME=$(eval echo "~$REAL_USER")
INSTALL_DIR="/opt/clipsync"
NODE_BIN="$(sudo -u "$REAL_USER" which node || echo /usr/local/bin/node)"

echo "Installing ClipSync to $INSTALL_DIR (Node: $NODE_BIN)"
mkdir -p "$INSTALL_DIR"
rsync -a --delete \
  --exclude=node_modules --exclude=.git \
  "$(dirname "$0")/.." "$INSTALL_DIR/"
chown -R "$REAL_USER" "$INSTALL_DIR"

sudo -u "$REAL_USER" bash -c "cd '$INSTALL_DIR/client-desktop' && npm install --omit=dev"

PLIST="$REAL_HOME/Library/LaunchAgents/com.clipsync.daemon.plist"
sudo -u "$REAL_USER" mkdir -p "$REAL_HOME/Library/LaunchAgents" "$REAL_HOME/.config/clipsync/client"
sed -e "s|__NODE__|$NODE_BIN|" \
    -e "s|__INSTALL_DIR__|$INSTALL_DIR|" \
    -e "s|__HOME__|$REAL_HOME|" \
    "$INSTALL_DIR/scripts/templates/com.clipsync.daemon.plist.tmpl" \
    | sudo -u "$REAL_USER" tee "$PLIST" > /dev/null

sudo -u "$REAL_USER" launchctl unload "$PLIST" 2>/dev/null || true
sudo -u "$REAL_USER" launchctl load "$PLIST"
echo "OK — ClipSync installed and loaded."
echo "Run registration: sudo -u $REAL_USER node $INSTALL_DIR/client-desktop/src/register.js"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/install-mac.sh scripts/templates/com.clipsync.daemon.plist.tmpl
git commit -m "feat(install): macOS launchd installer"
```

---

### Task 7.2: Linux systemd installer

**Files:**
- Modify: `scripts/install-linux.sh`
- Create: `scripts/templates/clipsync.service.tmpl`

- [ ] **Step 1: Create unit template**

```ini
[Unit]
Description=ClipSync clipboard sync daemon
After=network.target graphical-session.target

[Service]
ExecStart=__NODE__ __INSTALL_DIR__/client-desktop/src/main.js
Restart=on-failure
RestartSec=5
Environment=DISPLAY=:0
StandardOutput=append:%h/.config/clipsync/client/daemon.log
StandardError=append:%h/.config/clipsync/client/daemon.err

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Update install-linux.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/share/clipsync"
NODE_BIN="$(which node)"
[[ -z "$NODE_BIN" ]] && { echo "Node.js 18+ required"; exit 1; }

if ! command -v xclip >/dev/null && ! command -v wl-paste >/dev/null; then
  echo "Installing clipboard tools (sudo required)..."
  if command -v apt >/dev/null; then sudo apt install -y xclip wl-clipboard
  elif command -v dnf >/dev/null; then sudo dnf install -y xclip wl-clipboard
  elif command -v pacman >/dev/null; then sudo pacman -S --noconfirm xclip wl-clipboard
  fi
fi

mkdir -p "$INSTALL_DIR" "$HOME/.config/clipsync/client" "$HOME/.config/systemd/user"
rsync -a --delete --exclude=node_modules --exclude=.git "$(dirname "$0")/.." "$INSTALL_DIR/"
( cd "$INSTALL_DIR/client-desktop" && npm install --omit=dev )

UNIT="$HOME/.config/systemd/user/clipsync.service"
sed -e "s|__NODE__|$NODE_BIN|" -e "s|__INSTALL_DIR__|$INSTALL_DIR|" \
    "$INSTALL_DIR/scripts/templates/clipsync.service.tmpl" > "$UNIT"

systemctl --user daemon-reload
systemctl --user enable clipsync.service
echo "OK — registered. Run: node $INSTALL_DIR/client-desktop/src/register.js"
echo "Then: systemctl --user start clipsync"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/install-linux.sh scripts/templates/clipsync.service.tmpl
git commit -m "feat(install): Linux systemd installer"
```

---

### Task 7.3: Windows Task Scheduler installer

**Files:**
- Modify: `scripts/install-win.ps1`

- [ ] **Step 1: Replace install-win.ps1**

```powershell
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$installDir = "C:\Program Files\ClipSync"
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $nodeExe) { Write-Error "Node.js 18+ required (https://nodejs.org)"; exit 1 }

Write-Host "Installing ClipSync to $installDir"
New-Item -Force -ItemType Directory $installDir | Out-Null
Copy-Item -Recurse -Force "$PSScriptRoot\..\*" $installDir -Exclude @('node_modules', '.git')

Push-Location "$installDir\client-desktop"
& npm install --omit=dev
Pop-Location

$user = "$env:USERDOMAIN\$env:USERNAME"
$logDir = "$env:USERPROFILE\.config\clipsync\client"
New-Item -Force -ItemType Directory $logDir | Out-Null

$action  = New-ScheduledTaskAction -Execute $nodeExe `
    -Argument "`"$installDir\client-desktop\src\main.js`"" `
    -WorkingDirectory "$installDir\client-desktop"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
$prin    = New-ScheduledTaskPrincipal -UserId $user -RunLevel Limited

Register-ScheduledTask -TaskName "ClipSync" -Action $action -Trigger $trigger `
    -Settings $set -Principal $prin -Force | Out-Null

Write-Host "OK — task ClipSync registered."
Write-Host "Run registration: node `"$installDir\client-desktop\src\register.js`""
```

- [ ] **Step 2: Commit**

```bash
git add scripts/install-win.ps1
git commit -m "feat(install): Windows Task Scheduler installer"
```

---

## Phase 8 — Tutorials

Each tutorial follows the same template. Footer applies on every file:
```
---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
```

### Task 8.1: `docs/tutorials/README.md` — index + hub setup

**Files:**
- Create: `docs/tutorials/README.md`

- [ ] **Step 1: Write file**

```markdown
# ClipSync — Guías por dispositivo

Sincroniza el portapapeles entre tus dispositivos en la red local. Sin nube, sin servidores externos. Cifrado de extremo a extremo con clave por dispositivo (X25519 + AES-256-GCM).

## Cómo levantar el hub

El hub es un servidor Node.js que corre en cualquier equipo de la red local (idealmente uno siempre encendido — Mac, NAS, servidor casero, Raspberry Pi).

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync/hub
npm install
npm start
```

Al primer arranque, el hub muestra en consola un **token de admin** (solo una vez):

```
[clipsync] Admin token (save — shown once):
[clipsync]   AbCd1234EfGh5678IjKl9012MnOp3456...
```

Guárdalo. Lo usarás para entrar al dashboard.

### Modos de admin auth

| Modo | `CLIPSYNC_ADMIN_MODE` | Cómo se autentica |
|------|----------------------|-------------------|
| Token (default) | `token` | Token aleatorio mostrado en consola |
| Password | `password` | Define `CLIPSYNC_ADMIN_PASSWORD` en env |
| Primer dispositivo | `first-device` | El primero en registrarse es admin |

Ejemplo password mode:

```bash
CLIPSYNC_ADMIN_MODE=password CLIPSYNC_ADMIN_PASSWORD='mi-clave-segura' npm start
```

### Diagrama del sistema

```
┌──────────────┐                ┌─────────────┐
│  macOS       │ ◄── WSS ──►    │             │
└──────────────┘                │             │
┌──────────────┐                │     HUB     │
│  Linux       │ ◄── WSS ──►    │  (Node.js)  │
└──────────────┘                │  + SQLite   │
┌──────────────┐                │  + mDNS     │
│  Windows     │ ◄── WSS ──►    │             │
└──────────────┘                │             │
┌──────────────┐                │             │
│  PWA/móvil   │ ◄── WSS ──►    │             │
└──────────────┘                └─────────────┘
```

## Tutoriales por dispositivo

- [macOS](./macos.md)
- [Linux](./linux.md)
- [Windows](./windows.md)
- [PWA / móvil / browser](./pwa.md)

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
```

- [ ] **Step 2: Commit**

```bash
git add docs/tutorials/README.md
git commit -m "docs: tutorials index + hub setup"
```

---

### Task 8.2: `docs/tutorials/macos.md`

**Files:**
- Create: `docs/tutorials/macos.md`

- [ ] **Step 1: Write file** (full content)

```markdown
# ClipSync — macOS

## Requisitos
- macOS 12+
- Node.js 18+ (`brew install node`)
- Permiso de Accesibilidad para tu terminal/Node (Settings → Privacy & Security → Accessibility)

## Instalación

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync
sudo bash scripts/install-mac.sh
```

El script:
1. Copia ClipSync a `/opt/clipsync`
2. Instala dependencias
3. Crea el LaunchAgent en `~/Library/LaunchAgents/com.clipsync.daemon.plist`
4. Carga el agente

`sudo` solo se usa para escribir en `/opt/clipsync`. El servicio corre con tu usuario, **no como root**.

## Registro inicial

1. En el equipo del hub, abre `https://<ip-hub>:5679/admin` y haz login.
2. Click en "Generar PIN" — copia el PIN o muestra el QR.
3. En tu Mac:
   ```bash
   node /opt/clipsync/client-desktop/src/register.js
   ```
4. Introduce el PIN cuando se solicite. El cliente genera tu keypair X25519 y se registra.

## Uso diario

ClipSync corre en background. Copia algo en cualquier dispositivo y aparece en los demás. Logs:

```bash
tail -f ~/.config/clipsync/client/daemon.log
```

## Auto-start

Ya configurado por el instalador. Para verificar:

```bash
launchctl list | grep clipsync
```

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| `cert_mismatch` en logs | El certificado del hub cambió | Borra `hub_cert_fp` de `~/.config/clipsync/client/state.json` y reinicia |
| `auth failed: device_revoked` | Admin te revocó | Re-registra desde cero |
| No copia imágenes | Falta permiso Accesibilidad | Settings → Privacy & Security → Accessibility |
| Daemon no arranca | Node fuera de PATH | Edita el plist y pon ruta absoluta a `node` |

---

## ──── Notas técnicas ────

### Arquitectura del cliente

```
main.js          ← entry, sync loop, envelope encryption
ws-client.js     ← WSS + TOFU cert pinning
clipboard.js     ← clipboardy (texto) + osascript (imagen)
store.js         ← state.json en ~/.config/clipsync/client
discovery.js     ← mDNS para encontrar el hub
register.js      ← registro inicial vía PIN
```

### Variables de entorno

| Variable | Default | Función |
|----------|---------|---------|
| `CLIPSYNC_CLIENT_DIR` | `~/.config/clipsync/client` | Directorio de estado |
| `CLIPSYNC_POLL_MS` | `300` | Intervalo de polling del clipboard |

### Logs y debugging

```bash
tail -f ~/.config/clipsync/client/daemon.log    # stdout
tail -f ~/.config/clipsync/client/daemon.err    # stderr
launchctl unload ~/Library/LaunchAgents/com.clipsync.daemon.plist
node /opt/clipsync/client-desktop/src/main.js   # ejecutar manualmente
```

### Desinstalar

```bash
launchctl unload ~/Library/LaunchAgents/com.clipsync.daemon.plist
rm ~/Library/LaunchAgents/com.clipsync.daemon.plist
sudo rm -rf /opt/clipsync
rm -rf ~/.config/clipsync
```

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
```

- [ ] **Step 2: Commit**

```bash
git add docs/tutorials/macos.md
git commit -m "docs: macOS tutorial"
```

---

### Task 8.3: `docs/tutorials/linux.md`

**Files:**
- Create: `docs/tutorials/linux.md`

- [ ] **Step 1: Write file**

```markdown
# ClipSync — Linux

## Requisitos
- Linux con systemd
- Node.js 18+
- Para imágenes: `xclip` (X11) o `wl-clipboard` (Wayland)

## Instalación

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync
bash scripts/install-linux.sh
```

El script:
1. Instala `xclip`/`wl-clipboard` si faltan (pide sudo)
2. Copia ClipSync a `~/.local/share/clipsync`
3. Crea el unit en `~/.config/systemd/user/clipsync.service`
4. Habilita el servicio (no inicia hasta el registro)

## Registro inicial

```bash
node ~/.local/share/clipsync/client-desktop/src/register.js
# Introduce PIN del dashboard
systemctl --user start clipsync
```

## Uso diario

Sincronización transparente. Logs:

```bash
journalctl --user -u clipsync -f
```

## Auto-start

```bash
systemctl --user enable clipsync   # ya hecho por el instalador
loginctl enable-linger $USER       # opcional: corre incluso sin sesión activa
```

## Solución de problemas

| Síntoma | Causa | Solución |
|---------|-------|----------|
| Wayland no copia imagen | `wl-clipboard` no instalado | `sudo apt install wl-clipboard` |
| Servicio no arranca | DISPLAY mal configurado | Edita unit: `Environment=DISPLAY=:0` |
| `cert_mismatch` | Cert del hub cambió | Edita `state.json`, borra `hub_cert_fp` |

---

## ──── Notas técnicas ────

### Arquitectura

Misma que macOS, con detección automática Wayland → X11.

### Variables

| Variable | Default | Función |
|----------|---------|---------|
| `CLIPSYNC_CLIENT_DIR` | `~/.config/clipsync/client` | Directorio de estado |
| `DISPLAY` | `:0` (en unit) | X server display |

### Logs

```bash
journalctl --user -u clipsync -f --since "1 hour ago"
```

### Desinstalar

```bash
systemctl --user disable --now clipsync
rm ~/.config/systemd/user/clipsync.service
rm -rf ~/.local/share/clipsync ~/.config/clipsync
```

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
```

- [ ] **Step 2: Commit**

```bash
git add docs/tutorials/linux.md
git commit -m "docs: Linux tutorial"
```

---

### Task 8.4: `docs/tutorials/windows.md`

**Files:**
- Create: `docs/tutorials/windows.md`

- [ ] **Step 1: Write file**

```markdown
# ClipSync — Windows

## Requisitos
- Windows 10 (build 1903+) o 11
- Node.js 18+ (https://nodejs.org)
- PowerShell 5+

## Instalación

Abre PowerShell **como Administrador**:

```powershell
git clone https://github.com/DM20911/clipsync.git
cd clipsync
.\scripts\install-win.ps1
```

El script:
1. Copia ClipSync a `C:\Program Files\ClipSync`
2. Instala dependencias
3. Registra una tarea programada `ClipSync` que arranca al iniciar sesión
4. La tarea corre con privilegios limitados (no SYSTEM)

## Registro inicial

```powershell
node "C:\Program Files\ClipSync\client-desktop\src\register.js"
# Introduce PIN del dashboard
Start-ScheduledTask -TaskName ClipSync
```

## Uso diario

```powershell
Get-Content "$env:USERPROFILE\.config\clipsync\client\daemon.log" -Wait
```

## Auto-start

Ya configurado. Verificar:

```powershell
Get-ScheduledTask -TaskName ClipSync
```

## Solución de problemas

| Síntoma | Causa | Solución |
|---------|-------|----------|
| Tarea falla en arranque | Node fuera de PATH | Edita la acción en Task Scheduler con ruta absoluta |
| No copia imágenes | PowerShell ExecutionPolicy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `cert_mismatch` | Cert del hub cambió | Borra `hub_cert_fp` de `state.json` |

---

## ──── Notas técnicas ────

### Arquitectura

`clipboard.js` usa PowerShell (System.Windows.Forms.Clipboard) para imágenes.

### Logs

```powershell
Get-Content "$env:USERPROFILE\.config\clipsync\client\daemon.log" -Tail 100
```

### Desinstalar

```powershell
Unregister-ScheduledTask -TaskName ClipSync -Confirm:$false
Remove-Item -Recurse "C:\Program Files\ClipSync"
Remove-Item -Recurse "$env:USERPROFILE\.config\clipsync"
```

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
```

- [ ] **Step 2: Commit**

```bash
git add docs/tutorials/windows.md
git commit -m "docs: Windows tutorial"
```

---

### Task 8.5: `docs/tutorials/pwa.md`

**Files:**
- Create: `docs/tutorials/pwa.md`

- [ ] **Step 1: Write file**

```markdown
# ClipSync — PWA / móvil / browser

## Requisitos
- Navegador con Web Crypto X25519 e IndexedDB:
  - Chrome / Edge 113+
  - Firefox 119+
  - Safari 17.4+ (iOS 17.4+)
- Estar en la misma red Wi-Fi que el hub

## Instalación / acceso inicial

1. En tu móvil/tablet, abre: `https://<ip-del-hub>:5679/`
2. **Aceptar el certificado self-signed**:
   - El navegador advertirá que la conexión "no es privada".
   - Compara el fingerprint que muestra el navegador (Detalles del certificado → Huella digital SHA-256) con el fingerprint que el dashboard del hub muestra junto al QR.
   - Si coinciden, acepta la excepción. Solo necesitas hacerlo una vez.
3. Click en "Add to Home Screen" (iOS) o "Install app" (Chrome/Android) para usarlo como app nativa.

## Registro

1. En el dashboard del hub, click "Generar QR".
2. En el PWA, escanea el QR (input de URL hub) o introduce manualmente:
   - Hub URL: `wss://<ip>:5678`
   - PIN: el de 6 dígitos
3. El PWA genera un keypair X25519 (clave privada non-extractable, guardada en IndexedDB) y se registra.

## Uso diario

- **Recibir clips**: aparecen en la lista al instante. Click en cualquiera para copiarlo al portapapeles del dispositivo.
- **Enviar clips**: pega texto en el área de compose y dale "Send". También funciona el "Share" desde otras apps (gracias al share-target).

## Solución de problemas

| Síntoma | Causa | Solución |
|---------|-------|----------|
| "your connection is not private" | Cert self-signed | Aceptar excepción la primera vez |
| No conecta tras refrescar | TLS exception caducó | Volver a aceptar |
| `auth_fail: revoked` | Admin te revocó | Forget device → re-registrar |
| iOS no permite escribir clipboard automáticamente | Restricción Safari | El PWA muestra el contenido — copia manual |

---

## ──── Notas técnicas ────

### Arquitectura

```
app.js            ← UI, WS, envelope encryption
sw.js             ← service worker (offline shell)
manifest.webmanifest ← PWA manifest
```

### Almacenamiento

- **localStorage** (`clipsync_state_v2`): hub_url, device_id, jwt
- **IndexedDB** (`clipsync` → `keys`): X25519 privateKey (`extractable: false`) + publicKey base64

La clave privada nunca aparece en JS como bytes raw. XSS puede invocar derivación de claves pero no puede exfiltrar la clave privada.

### Limitaciones

- iOS Safari restringe `navigator.clipboard.write` — para imágenes hay que copiar manualmente
- Si el usuario borra "Site data", se pierden las claves y hay que re-registrar
- El service worker no funciona offline para syncing — solo cachea el shell

### Reset

Click "Forget device" → confirma → recarga. Las claves de IndexedDB se borran al limpiar Site data del navegador.

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
```

- [ ] **Step 2: Commit**

```bash
git add docs/tutorials/pwa.md
git commit -m "docs: PWA / mobile tutorial"
```

---

## Phase 9 — Verification

### Task 9.1: Run full test suite

- [ ] **Step 1: All hub tests**

```bash
cd hub && npm test
```
Expected: all pass.

- [ ] **Step 2: Manual integration check**

```bash
# Terminal 1
cd hub && npm start

# Terminal 2 — register desktop client
node client-desktop/src/register.js

# Terminal 3 — open PWA in browser, register

# Test: copy text in one device, verify it appears in others
```

- [ ] **Step 3: Test admin protected endpoint**

```bash
curl -k https://localhost:5679/api/pin -X POST
# Expect: 401 admin_required
```

- [ ] **Step 4: Test rate limit**

```bash
for i in {1..15}; do
  curl -k https://localhost:5679/api/register -X POST -H 'content-type: application/json' \
    -d '{"pin":"000000","name":"x","os":"l","public_key":""}'
done
# After 10 attempts, expect: 429 rate_limited
```

- [ ] **Step 5: Final commit if needed**

```bash
git status
```

---

## Self-review checklist

- ✅ All 15 vulnerabilities have a corresponding task (VULN-001 → 1.1+5.4+6.1; VULN-002 → 3.2+4.2; VULN-003 → 4.2; VULN-004 → 3.1+3.3+4.2; VULN-005 → 5.3; VULN-006 → 2.1+3.3; VULN-007 → 3.1+4.1; VULN-008 → 4.2; VULN-009 → 6.1; VULN-010 → 2.1; VULN-011 → 3.3; VULN-012 → 3.3; VULN-013 → already in earlier refactor; VULN-014 → 1.1; VULN-015 → 1.1)
- ✅ All 5 tutorial files have tasks (8.1 README + 8.2 macOS + 8.3 Linux + 8.4 Windows + 8.5 PWA)
- ✅ All 3 OS scripts have tasks (7.1 mac + 7.2 linux + 7.3 win)
- ✅ No TBD/TODO placeholders
- ✅ Each task has Files, Steps, exact code, exact commands

---

Footer applied on every tutorial:
> Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
