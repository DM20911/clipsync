// WebSocket client with auto-reconnect (jittered backoff) and TOFU TLS pinning.
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
      if (!this.expectedFp && fp) {
        this.onPinFp(fp);
        this.expectedFp = fp;
      }
      certVerified = true;
    });
    ws.on('open', () => {
      if (!certVerified) return;
      this.send({ op: OP.AUTH, token: this.jwt });
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (m.op === OP.AUTH_OK) {
        this.alive = true; this.reconnectMs = 1000;
        this.onOpen(m); return;
      }
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
