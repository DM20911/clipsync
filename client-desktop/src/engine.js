// SyncEngine — shared core used by both daemon mode and tray mode.
// Provides start/stop/pause/resume + event emitter for UI consumers.
import { EventEmitter } from 'node:events';
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

export class SyncEngine extends EventEmitter {
  constructor() {
    super();
    this.state = load();
    this.peers = new Map();
    this.client = null;
    this.monitor = null;
    this.paused = false;
    this.recent = [];   // last N clips (for tray UI)
  }

  isRegistered() {
    return !!(this.state.jwt && this.state.x25519_private_b64);
  }

  status() {
    return {
      registered: this.isRegistered(),
      connected: this.client?.alive ?? false,
      paused: this.paused,
      hub_url: this.state.hub_url || null,
      device_id: this.state.device_id || null,
      peer_count: this.peers.size,
      recent: this.recent.slice(0, 10),
    };
  }

  pause() { this.paused = true;  this.monitor?.stop();  this.emit('status', this.status()); }
  resume() { this.paused = false; if (this.client?.alive) this.monitor?.start(); this.emit('status', this.status()); }

  async start() {
    if (!this.isRegistered()) {
      this.emit('error', new Error('not_registered'));
      return false;
    }
    const myPriv = Buffer.from(this.state.x25519_private_b64, 'base64');

    let hubUrl = this.state.hub_url;
    const fresh = await findHub({ timeoutMs: 4000 });
    if (fresh && fresh.url) hubUrl = fresh.url;

    this.monitor = new ClipboardMonitor({ onChange: (item) => this.#publishLocal(item) });

    this.client = new WsClient({
      url: hubUrl,
      jwt: this.state.jwt,
      expectedFp: this.state.hub_cert_fp || null,
      onPinFp: (fp) => {
        this.state.hub_cert_fp = fp; save(this.state);
        this.emit('cert-pinned', fp);
      },
      onCertMismatch: (info) => {
        this.emit('cert-mismatch', info);
      },
      onOpen: (msg) => {
        this.peers = new Map((msg.peers || []).map(p => [p.id, Buffer.from(p.public_key, 'base64')]));
        if (!this.paused) this.monitor.start();
        this.client.send({ op: OP.HISTORY_REQ, limit: 5 });
        this.emit('connected', this.status());
      },
      onMessage: (m) => this.#handleMessage(m, myPriv),
      onClose: ({ code, reason }) => {
        this.monitor.stop();
        this.emit('disconnected', { code, reason });
      },
    });
    this.client.start();
    return true;
  }

  stop() {
    this.client?.stop();
    this.monitor?.stop();
    this.client = null;
    this.monitor = null;
  }

  forget() {
    this.stop();
    clear();
    this.state = {};
    this.emit('forgotten');
  }

  #publishLocal({ type, mime, data, checksum }) {
    if (this.paused) return;
    if (data.length > LIMITS.FILE_MAX) return;
    if (this.peers.size === 0) return;

    const contentKey = randomBytes(32);
    const encryptedPayload = encryptAesGcm(contentKey, data);
    const eph = generateX25519();
    const wrapSalt = randomBytes(16);
    const wrappedKeys = {};
    for (const [pid, pub] of this.peers) {
      const wk = deriveSharedKey(eph.privateKey, pub, wrapSalt, 'clipsync-v1');
      wrappedKeys[pid] = encryptAesGcm(wk, contentKey).toString('base64');
    }

    this.client.send({
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
    this.#trackRecent({ type, mime, size: data.length, timestamp: Date.now(), direction: 'sent' });
  }

  #handleMessage(m, myPriv) {
    if (m.op === OP.PEERS) {
      this.peers = new Map(
        (m.peers || [])
          .filter(p => p.id !== this.state.device_id)
          .map(p => [p.id, Buffer.from(p.public_key, 'base64')])
      );
      this.emit('peers', this.peers.size);
      return;
    }
    if (m.op === OP.BROADCAST) {
      const c = m.clip;
      try {
        const senderPub = Buffer.from(c.sender_ephemeral_public, 'base64');
        const wrapSalt  = Buffer.from(c.wrap_salt, 'base64');
        const wk = deriveSharedKey(myPriv, senderPub, wrapSalt, 'clipsync-v1');
        const contentKey = decryptAesGcm(wk, Buffer.from(c.wrapped_key, 'base64'));
        const buf = decryptAesGcm(contentKey, Buffer.from(c.encrypted_payload, 'base64'));
        if (c.checksum && sha256Hex(buf) !== c.checksum) {
          this.emit('warn', 'checksum_mismatch'); return;
        }
        if (!this.paused) {
          this.monitor.write({ type: c.type, mime: c.mime, data: buf })
            .catch((e) => this.emit('warn', 'write_failed: ' + e.message));
        }
        this.#trackRecent({
          type: c.type, mime: c.mime, size: buf.length,
          timestamp: c.timestamp, direction: 'received',
          preview: c.type === 'text' || c.type === 'url'
            ? buf.toString('utf8').slice(0, 80)
            : null,
        });
      } catch (e) { this.emit('warn', 'decrypt_failed: ' + e.message); }
      return;
    }
    if (m.op === OP.AUTH_FAIL) {
      this.emit('auth-fail', m.reason);
      if (m.reason === 'revoked' || m.reason === 'device_revoked') {
        this.forget();
      }
    }
  }

  #trackRecent(item) {
    this.recent.unshift(item);
    if (this.recent.length > 20) this.recent.pop();
    this.emit('clip', item);
  }
}
