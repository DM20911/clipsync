// ClipSync Hub — HTTPS + WSS + mDNS + SQLite.
// Entry point.
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

import { CONFIG } from './config.js';
import { DB } from './db.js';
import { Auth } from './auth.js';
import { ensureTlsCert } from './tls.js';
import { announceService } from './mdns.js';
import { Routes } from './routes.js';
import { log } from './logger.js';
import { OP, isPrivateIp, isValidClip, isUrlClip, LIMITS } from '../../shared/protocol.js';

// ── Boot
const db   = new DB(CONFIG.DB_PATH);
const auth = new Auth(db);
const events = new EventEmitter();
events.setMaxListeners(50);

if (auth.shouldRotate()) {
  log.info('rotating server secret (>30d old)');
  auth.rotateSecret();
}

const tls = ensureTlsCert(CONFIG.TLS_DIR);

// ── Connected sockets registry. Map<deviceId, ws>
const sockets = new Map();
const meta    = new WeakMap();   // ws -> { deviceId, name, os, lastPong }

function listConnected() {
  const out = [];
  for (const [id, ws] of sockets) {
    const m = meta.get(ws) || {};
    out.push({ id, name: m.name, os: m.os, last_seen: m.lastPong || Date.now() });
  }
  return out;
}

// ── HTTPS / Routes
const routes = new Routes({
  db, auth, eventBus: events,
  getDevices: listConnected,
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

// ── WebSocket Secure on a separate HTTPS listener
const wssHttp = https.createServer({ key: tls.key, cert: tls.cert });
const wss = new WebSocketServer({ server: wssHttp, maxPayload: LIMITS.FILE_MAX + (1 << 20) });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || '';
  if (!isPrivateIp(ip)) {
    log.warn('rejecting non-private ws connection', { ip });
    ws.close(1008, 'forbidden_ip');
    return;
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

// ── Heartbeat
setInterval(() => {
  for (const ws of wss.clients) {
    try { ws.ping(); } catch (_) {}
  }
}, CONFIG.PING_INTERVAL_MS);

// ── History pruning
setInterval(() => {
  db.pruneHistory(CONFIG.HISTORY_MAX, CONFIG.HISTORY_TTL_MS);
  auth.cleanExpiredPins();
}, 5 * 60 * 1000);

// ── Message handling
function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (_) {}
}

function onMessage(ws, raw, ip) {
  let msg;
  try { msg = JSON.parse(raw.toString('utf8')); }
  catch { return send(ws, { op: OP.AUTH_FAIL, reason: 'malformed_json' }); }

  const m = meta.get(ws) || {};

  // Registration via PIN — initial connection from a new device
  if (msg.op === OP.REGISTER) {
    const { pin, name, os: osName, fingerprint } = msg;
    if (!auth.consumePin(String(pin || ''))) {
      send(ws, { op: OP.AUTH_FAIL, reason: 'invalid_or_expired_pin' });
      return ws.close(1008, 'pin_failed');
    }
    const reg = auth.registerDevice({ name, os: osName, fingerprint });
    log.event('device_registered', { id: reg.id, name, ip });
    events.emit('event', { kind: 'device_registered', id: reg.id, name });
    send(ws, { op: OP.REGISTER_OK, device_id: reg.id, token: reg.token, jwt: reg.jwt });
    // Force re-connect with the new JWT — simpler than promoting in place.
    return ws.close(1000, 'registered');
  }

  // Auth handshake (every other op requires this)
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
    // Replace any existing socket for this device (single-session).
    const prev = sockets.get(dev.id);
    if (prev && prev !== ws) {
      try { prev.close(1000, 'replaced'); } catch {}
    }
    sockets.set(dev.id, ws);
    meta.set(ws, { authed: true, deviceId: dev.id, name: dev.name, os: dev.os, lastPong: Date.now() });
    db.touchDevice(dev.id);

    send(ws, {
      op: OP.AUTH_OK,
      device_id: dev.id,
      devices: listConnected().filter((d) => d.id !== dev.id),
    });
    broadcastAll({ op: OP.DEVICE_JOINED, device: { id: dev.id, name: dev.name, os: dev.os } }, dev.id);
    log.event('device_connected', { id: dev.id, name: dev.name, ip });
    events.emit('event', { kind: 'device_connected', id: dev.id, name: dev.name });
    return;
  }

  // Authenticated ops
  switch (msg.op) {
    case OP.PING:
      return send(ws, { op: OP.PONG, t: Date.now() });

    case OP.PUSH: {
      const clip = msg.clip;
      if (!isValidClip(clip)) return send(ws, { op: OP.ERROR, reason: 'invalid_clip' });
      if (typeof clip.payload_b64 !== 'string') return send(ws, { op: OP.ERROR, reason: 'no_payload' });
      const sizeLimit = { text: LIMITS.TEXT_MAX, url: LIMITS.TEXT_MAX, image: LIMITS.IMAGE_MAX, file: LIMITS.FILE_MAX };
      if (clip.size && clip.size > (sizeLimit[clip.type] ?? LIMITS.FILE_MAX)) {
        return send(ws, { op: OP.ERROR, reason: 'too_large' });
      }
      // Persist (encrypted payload as-received)
      db.insertHistory({
        id: clip.id,
        type: clip.type,
        mime: clip.mime || null,
        size: clip.size || 0,
        source_id: m.deviceId,
        timestamp: clip.timestamp || Date.now(),
        checksum: clip.checksum || null,
        payload_b64: clip.payload_b64,
        meta_json: JSON.stringify({ name: clip.name || null }),
      });
      // Re-broadcast (without source — peers ignore their own)
      const broadcast = {
        op: OP.BROADCAST,
        clip: {
          id: clip.id, type: clip.type, mime: clip.mime,
          size: clip.size, source_device: m.deviceId,
          timestamp: clip.timestamp, checksum: clip.checksum,
          payload_b64: clip.payload_b64,
          name: clip.name || null,
        },
      };
      broadcastAll(broadcast, m.deviceId);
      log.event('clip_pushed', {
        id: clip.id, type: clip.type, size: clip.size,
        from: m.deviceId, mime: clip.mime,
      });
      events.emit('event', {
        kind: 'clip', id: clip.id, type: clip.type, size: clip.size,
        from: m.deviceId, mime: clip.mime, timestamp: clip.timestamp,
      });
      return;
    }

    case OP.HISTORY_REQ: {
      const limit = Math.min(parseInt(msg.limit ?? 10, 10), 50);
      const rows = db.recentHistory(limit).map((r) => ({
        id: r.id, type: r.type, mime: r.mime, size: r.size,
        source_device: r.source_id, timestamp: r.timestamp,
        checksum: r.checksum, payload_b64: r.payload_b64,
      }));
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
    try { ws.send(json); } catch (_) {}
  }
}

function onClose(ws) {
  const m = meta.get(ws);
  if (m && m.deviceId) {
    if (sockets.get(m.deviceId) === ws) sockets.delete(m.deviceId);
    broadcastAll({ op: OP.DEVICE_LEFT, device_id: m.deviceId });
    log.event('device_disconnected', { id: m.deviceId });
    events.emit('event', { kind: 'device_disconnected', id: m.deviceId });
  }
}

// ── mDNS announce
const mdns = announceService({
  port: CONFIG.PORT_WSS,
  name: CONFIG.HUB_NAME,
  txt: { v: '1', http: String(CONFIG.PORT_HTTP) },
});

log.info('clipsync hub started', {
  hub: CONFIG.HUB_NAME, wss: CONFIG.PORT_WSS, http: CONFIG.PORT_HTTP, dataDir: CONFIG.DATA_DIR,
});
console.log('\nClipSync Hub running.');
console.log(`  Dashboard:  https://localhost:${CONFIG.PORT_HTTP}/admin`);
console.log(`  PWA:        https://localhost:${CONFIG.PORT_HTTP}/`);
console.log(`  WSS:        wss://localhost:${CONFIG.PORT_WSS}\n`);

// ── Graceful shutdown
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
