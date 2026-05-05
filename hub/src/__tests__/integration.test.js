// Integration test: spawn a hub in-process, run register flow, push a clip,
// verify envelope round-trip across two simulated devices, exercise admin auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DB } from '../db.js';
import { Auth } from '../auth.js';
import { Admin } from '../admin.js';
import { Routes } from '../routes.js';
import { TokenBucket, AttemptCounter } from '../rate-limit.js';
import { buildPerRecipient } from '../envelope.js';
import { OP, isValidEnvelope, LIMITS } from '../../../shared/protocol.js';
import {
  generateX25519, deriveSharedKey, encryptAesGcm, decryptAesGcm,
  randomBytes, sha256Hex,
} from '../../../shared/crypto-node.js';

function tmpDbPath() {
  return path.join(os.tmpdir(), `clipsync-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// Spawn an HTTP-only routes server (no TLS) for integration testing.
// We test the routes layer directly against http.createServer rather than spinning
// up TLS — TOFU pinning and TLS are unit-tested separately.
async function bootHub() {
  const dbPath = tmpDbPath();
  const db = new DB(dbPath);
  const auth = new Auth(db);
  const admin = new Admin({ db, mode: 'token' });
  const adminToken = admin.bootstrap();
  const events = new EventEmitter();
  const sockets = new Map();
  const meta = new WeakMap();
  const pushBucket    = new TokenBucket({ capacity: 20, refillPerSec: 5 });
  const historyBucket = new TokenBucket({ capacity: 5,  refillPerSec: 0.5 });
  const pinIpCounter  = new AttemptCounter({ maxAttempts: 10, windowMs: 60_000 });

  const routes = new Routes({
    db, auth, admin, eventBus: events,
    getDevices: () => [],
    pinIpCounter,
  });

  const httpServer = http.createServer((req, res) => routes.handle(req, res).catch(() => {}));
  await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
  const port = httpServer.address().port;

  const wssHttp = http.createServer();
  const wss = new WebSocketServer({ server: wssHttp, maxPayload: LIMITS.FILE_MAX + (1 << 20) });
  await new Promise(r => wssHttp.listen(0, '127.0.0.1', r));
  const wsPort = wssHttp.address().port;

  function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  function broadcastPeers() {
    const list = [];
    for (const [id] of sockets) {
      const dev = db.getDevice(id);
      if (dev?.public_key) list.push({ id, public_key: dev.public_key.toString('base64') });
    }
    for (const ws of sockets.values()) send(ws, { op: OP.PEERS, peers: list });
  }

  wss.on('connection', (ws) => {
    meta.set(ws, { authed: false });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      const m = meta.get(ws);
      if (msg.op === OP.AUTH && !m.authed) {
        const v = auth.verifyToken(String(msg.token));
        if (!v.ok) { send(ws, { op: OP.AUTH_FAIL, reason: v.reason }); return ws.close(); }
        const dev = v.device;
        sockets.set(dev.id, ws);
        meta.set(ws, { authed: true, deviceId: dev.id });
        const peers = db.listDevicePublicKeys(dev.id).map(p => ({ id: p.id, public_key: p.public_key.toString('base64') }));
        send(ws, { op: OP.AUTH_OK, device_id: dev.id, devices: [], peers });
        broadcastPeers();
        return;
      }
      if (!m.authed) return;
      if (msg.op === OP.PUSH) {
        if (!pushBucket.consume(m.deviceId)) return send(ws, { op: OP.ERROR, reason: 'rate_limited' });
        if (!isValidEnvelope(msg.clip)) return send(ws, { op: OP.ERROR, reason: 'invalid_clip' });
        for (const [id, peerWs] of sockets) {
          if (id === m.deviceId) continue;
          const out = buildPerRecipient(msg.clip, id, m.deviceId);
          if (out) send(peerWs, out);
        }
      }
      if (msg.op === OP.HISTORY_REQ) {
        if (!historyBucket.consume(m.deviceId)) return send(ws, { op: OP.ERROR, reason: 'rate_limited' });
        send(ws, { op: OP.HISTORY, items: [] });
      }
    });
    ws.on('close', () => {
      const m = meta.get(ws);
      if (m?.deviceId) sockets.delete(m.deviceId);
    });
  });

  return {
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${wsPort}`,
    adminToken,
    db, auth, admin, sockets,
    cleanup: async () => {
      await new Promise(r => httpServer.close(() => r()));
      await new Promise(r => wssHttp.close(() => r()));
      for (const ws of wss.clients) ws.terminate();
      db.close();
      try { fs.unlinkSync(dbPath); } catch {}
    },
  };
}

async function postJson(url, body, cookie = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) };
    if (cookie) headers.cookie = cookie;
    const req = http.request({ method: 'POST', host: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: {} }); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function getJson(url, cookie = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (cookie) headers.cookie = cookie;
    http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    }).on('error', reject);
  });
}

test('full envelope round-trip between two devices', async () => {
  const hub = await bootHub();
  try {
    // Login admin
    const login = await postJson(hub.httpUrl + '/api/admin/login', { credential: hub.adminToken });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];

    // Issue PIN
    const pin1 = (await postJson(hub.httpUrl + '/api/pin', {}, cookie)).body.pin;
    const pin2 = (await postJson(hub.httpUrl + '/api/pin', {}, cookie)).body.pin;
    assert.match(pin1, /^\d{6}$/);

    // Two devices generate keypairs and register
    const A = generateX25519();
    const B = generateX25519();
    const regA = await postJson(hub.httpUrl + '/api/register', {
      pin: pin1, name: 'A', os: 'linux', public_key: A.publicKey.toString('base64'),
    });
    assert.equal(regA.status, 200);
    const regB = await postJson(hub.httpUrl + '/api/register', {
      pin: pin2, name: 'B', os: 'linux', public_key: B.publicKey.toString('base64'),
    });
    assert.equal(regB.status, 200);

    // Connect A first, wait for AUTH_OK
    const wsA = new WebSocket(hub.wsUrl);
    const wsAPeers = (id) => new Promise((resolve) => {
      const onMsg = (raw) => {
        const m = JSON.parse(raw.toString('utf8'));
        if (m.op === OP.PEERS && m.peers.some(p => p.id === id)) {
          wsA.off('message', onMsg);
          resolve();
        }
      };
      wsA.on('message', onMsg);
    });
    let bGotClipResolve;
    const bGotClip = new Promise((r) => { bGotClipResolve = r; });

    await new Promise((resolve) => {
      wsA.on('open', () => wsA.send(JSON.stringify({ op: OP.AUTH, token: regA.body.jwt })));
      wsA.once('message', (raw) => {
        const m = JSON.parse(raw.toString('utf8'));
        if (m.op === OP.AUTH_OK) resolve();
      });
    });

    // Set up watcher for B-in-peers (so we know hub knows about B for envelope routing)
    const aSeesB = wsAPeers(regB.body.id);

    // Connect B
    const wsB = new WebSocket(hub.wsUrl);
    wsB.on('open', () => wsB.send(JSON.stringify({ op: OP.AUTH, token: regB.body.jwt })));
    wsB.on('message', (raw) => {
      const m = JSON.parse(raw.toString('utf8'));
      if (m.op === OP.BROADCAST) bGotClipResolve(m.clip);
    });

    // Wait for A's PEERS notification including B
    await aSeesB;

    // A encrypts a clip for B, sends PUSH
    const plaintext = Buffer.from('Hello from A to B', 'utf8');
    const contentKey = randomBytes(32);
    const encryptedPayload = encryptAesGcm(contentKey, plaintext);
    const eph = generateX25519();
    const wrapSalt = randomBytes(16);
    const wk = deriveSharedKey(eph.privateKey, B.publicKey, wrapSalt, 'clipsync-v1');
    const wrapped = encryptAesGcm(wk, contentKey);

    wsA.send(JSON.stringify({
      op: OP.PUSH,
      clip: {
        id: 'test-clip-1', type: 'text', mime: 'text/plain',
        size: plaintext.length, timestamp: Date.now(),
        checksum: sha256Hex(plaintext),
        encrypted_payload: encryptedPayload.toString('base64'),
        sender_ephemeral_public: eph.publicKey.toString('base64'),
        wrap_salt: wrapSalt.toString('base64'),
        wrapped_keys: { [regB.body.id]: wrapped.toString('base64') },
      },
    }));

    // B receives, decrypts
    const clip = await bGotClip;
    const senderPub = Buffer.from(clip.sender_ephemeral_public, 'base64');
    const wkB = deriveSharedKey(B.privateKey, senderPub, Buffer.from(clip.wrap_salt, 'base64'), 'clipsync-v1');
    const ck = decryptAesGcm(wkB, Buffer.from(clip.wrapped_key, 'base64'));
    const pt = decryptAesGcm(ck, Buffer.from(clip.encrypted_payload, 'base64'));
    assert.equal(pt.toString('utf8'), 'Hello from A to B');

    wsA.close(); wsB.close();
  } finally {
    await hub.cleanup();
  }
});

test('admin protected endpoint requires session', async () => {
  const hub = await bootHub();
  try {
    const noAuth = await postJson(hub.httpUrl + '/api/pin', {});
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.body.error, 'admin_required');

    const login = await postJson(hub.httpUrl + '/api/admin/login', { credential: 'wrong-token' });
    assert.equal(login.status, 401);

    const okLogin = await postJson(hub.httpUrl + '/api/admin/login', { credential: hub.adminToken });
    assert.equal(okLogin.status, 200);
    const cookie = okLogin.headers['set-cookie'][0].split(';')[0];

    const withAuth = await postJson(hub.httpUrl + '/api/pin', {}, cookie);
    assert.equal(withAuth.status, 200);
    assert.match(withAuth.body.pin, /^\d{6}$/);
  } finally {
    await hub.cleanup();
  }
});

test('admin login rate limiter triggers after 5 fails', async () => {
  const hub = await bootHub();
  try {
    for (let i = 0; i < 5; i++) {
      const r = await postJson(hub.httpUrl + '/api/admin/login', { credential: 'bad' });
      assert.equal(r.status, 401);
    }
    const blocked = await postJson(hub.httpUrl + '/api/admin/login', { credential: 'bad' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, 'rate_limited');
  } finally {
    await hub.cleanup();
  }
});

test('register endpoint rate-limits per IP after 10 attempts', async () => {
  const hub = await bootHub();
  try {
    // Make 10 attempts with bad PINs (all fail with 401)
    for (let i = 0; i < 10; i++) {
      const r = await postJson(hub.httpUrl + '/api/register', {
        pin: '000000', name: 'x', os: 'l',
        public_key: Buffer.from('pk').toString('base64'),
      });
      assert.equal(r.status, 401);
    }
    // 11th hits the IP rate limit
    const blocked = await postJson(hub.httpUrl + '/api/register', {
      pin: '000000', name: 'x', os: 'l',
      public_key: Buffer.from('pk').toString('base64'),
    });
    assert.equal(blocked.status, 429);
  } finally {
    await hub.cleanup();
  }
});

test('CSP headers set on HTML responses', async () => {
  const hub = await bootHub();
  try {
    const r = await new Promise((resolve, reject) => {
      http.get(hub.httpUrl + '/admin', (res) => resolve(res)).on('error', reject);
    });
    r.resume();
    assert.match(r.headers['content-security-policy'] || '', /default-src 'self'/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  } finally {
    await hub.cleanup();
  }
});

test('foreign origin rejected by CORS', async () => {
  const hub = await bootHub();
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'GET', host: '127.0.0.1', port: new URL(hub.httpUrl).port,
        path: '/api/status', headers: { origin: 'https://evil.example.com' },
      }, (res) => { res.resume(); resolve(res); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(r.statusCode, 403);
  } finally {
    await hub.cleanup();
  }
});
