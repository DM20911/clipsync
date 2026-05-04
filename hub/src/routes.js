// HTTP/HTTPS routing — dashboard, REST endpoints, QR codes, SSE event stream.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { isPrivateIp } from '../../shared/protocol.js';
import { CONFIG } from './config.js';

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

export class Routes {
  constructor({ db, auth, eventBus, getDevices }) {
    this.db = db;
    this.auth = auth;
    this.events = eventBus;
    this.getDevices = getDevices;
    this.sseClients = new Set();
    eventBus.on('event', (ev) => this.#sseBroadcast(ev));
  }

  #sseBroadcast(ev) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(line); } catch (_) { this.sseClients.delete(res); }
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

  async handle(req, res) {
    if (!this.#checkPrivate(req, res)) return;
    const u = new URL(req.url, 'https://localhost');
    const pathname = u.pathname;

    // CORS for PWA on same host
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── PWA static
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

    // ── Admin dashboard
    if (pathname === '/admin') {
      return this.#sendFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    }
    if (pathname.startsWith('/admin/')) {
      const f = path.join(PUBLIC_DIR, pathname.replace(/^\/admin\//, ''));
      if (f.startsWith(PUBLIC_DIR)) return this.#sendFile(res, f);
    }

    // ── API
    if (pathname === '/api/status') {
      return this.#json(res, 200, {
        ok: true,
        hub: os.hostname(),
        devices: this.getDevices(),
        history_count: this.db.countHistory(),
        time: Date.now(),
      });
    }

    if (pathname === '/api/devices' && req.method === 'GET') {
      return this.#json(res, 200, { devices: this.db.listDevices() });
    }

    if (pathname.match(/^\/api\/devices\/[^/]+$/) && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      this.auth.revokeDevice(id);
      this.events.emit('event', { kind: 'device_revoked', id });
      return this.#json(res, 200, { ok: true });
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '20', 10), 50);
      const items = this.db.recentHistory(limit).map((r) => ({
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
      const payload = JSON.stringify({ v: 1, hub: wssUrl, pin });
      const dataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, scale: 8 });
      return this.#json(res, 200, { pin, expiresAt, qr: dataUrl, payload, hub: wssUrl });
    }

    // PIN-based registration over HTTP (used by PWA — WS uses register op).
    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await readJson(req).catch(() => null);
      if (!body) return this.#json(res, 400, { error: 'invalid_json' });
      const { pin, name, os: osName, fingerprint } = body;
      if (!this.auth.consumePin(String(pin || ''))) {
        return this.#json(res, 401, { error: 'invalid_or_expired_pin' });
      }
      const reg = this.auth.registerDevice({ name, os: osName, fingerprint });
      this.events.emit('event', { kind: 'device_registered', id: reg.id, name });
      return this.#json(res, 200, reg);
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

    if (pathname === '/api/config' && req.method === 'GET') {
      return this.#json(res, 200, {
        history_max: CONFIG.HISTORY_MAX,
        history_ttl_ms: CONFIG.HISTORY_TTL_MS,
      });
    }

    // 404
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
      } else {
        res.destroy();
      }
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
    const chunks = [];
    let size = 0;
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
