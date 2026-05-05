// ClipSync Hub — HTTPS + WSS + mDNS + SQLite + envelope encryption.
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

import { CONFIG } from './config.js';
import { DB } from './db.js';
import { Auth } from './auth.js';
import { Admin } from './admin.js';
import { ensureTlsCert, fingerprintOf } from './tls.js';
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

const adminTokenPrinted = admin.bootstrap();
if (adminTokenPrinted) {
  console.log('\n[clipsync] Admin token (save — shown once):');
  console.log(`[clipsync]   ${adminTokenPrinted}\n`);
}

const events = new EventEmitter();
events.setMaxListeners(50);

if (auth.shouldRotate()) {
  log.info('rotating server secret (>30d old)');
  auth.rotateSecret();
}

const tls = ensureTlsCert(CONFIG.TLS_DIR);
const certFp = fingerprintOf(tls.cert.toString());
db.setMeta('cert_fingerprint', certFp);
log.info('cert fingerprint', { fp: certFp });

const sockets = new Map();
const meta    = new WeakMap();

const pushBucket    = new TokenBucket({ capacity: 20, refillPerSec: 5 });
const historyBucket = new TokenBucket({ capacity: 5,  refillPerSec: 0.5 });
const pinIpCounter  = new AttemptCounter({ maxAttempts: 10, windowMs: 60_000 });

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
  historyBucket.cleanup();
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
    send(ws, {
      op: OP.AUTH_OK, device_id: dev.id,
      devices: listConnected().filter(d => d.id !== dev.id),
      peers,
    });
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
      if (!historyBucket.consume(m.deviceId, 1)) {
        return send(ws, { op: OP.ERROR, reason: 'rate_limited' });
      }
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
