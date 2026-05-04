// WebSocket client with auto-reconnect (exponential backoff).
import WebSocket from 'ws';
import { OP } from '../../shared/protocol.js';

export class WsClient {
  constructor({ url, jwt, onOpen, onMessage, onClose }) {
    this.url = url;
    this.jwt = jwt;
    this.onOpen = onOpen || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});
    this.ws = null;
    this.reconnectMs = 1000;
    this.maxReconnectMs = 30_000;
    this.shouldRun = false;
    this.alive = false;
  }

  start() {
    this.shouldRun = true;
    this.connect();
  }

  stop() {
    this.shouldRun = false;
    try { this.ws?.close(1000, 'stopping'); } catch {}
  }

  connect() {
    if (!this.shouldRun) return;
    const ws = new WebSocket(this.url, { rejectUnauthorized: false });
    this.ws = ws;
    ws.on('open', () => {
      this.send({ op: OP.AUTH, token: this.jwt });
    });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (m.op === OP.AUTH_OK) {
        this.alive = true;
        this.reconnectMs = 1000;
        this.onOpen(m);
        return;
      }
      if (m.op === OP.AUTH_FAIL) {
        this.alive = false;
        this.onMessage(m);
        return;
      }
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
    ws.on('error', () => { /* close handler will reconnect */ });
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; }
    catch { return false; }
  }

  ping() { this.send({ op: OP.PING }); }
}
