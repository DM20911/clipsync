// PIN-based registration → JWT issuance, verification, revocation.
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { randomPin, randomToken } from './crypto.js';
import { CONFIG } from './config.js';

export class Auth {
  constructor(db) {
    this.db = db;
    this.activePins = new Map();   // pin -> { expiresAt, consumedBy }
    this.serverSecret = this.#loadOrCreateSecret();
  }

  #loadOrCreateSecret() {
    let s = this.db.getMeta('server_secret');
    if (!s) {
      s = randomToken(48);
      this.db.setMeta('server_secret', s);
      this.db.setMeta('secret_created_at', String(Date.now()));
    }
    // Network key — shared by all registered devices for AES payload encryption.
    let nk = this.db.getMeta('network_key');
    if (!nk) {
      nk = randomToken(48);
      this.db.setMeta('network_key', nk);
    }
    this.networkKey = nk;
    return s;
  }

  getNetworkKey() { return this.networkKey; }

  // Rotate the server secret (invalidates all existing tokens).
  rotateSecret() {
    this.serverSecret = randomToken(48);
    this.db.setMeta('server_secret', this.serverSecret);
    this.db.setMeta('secret_created_at', String(Date.now()));
  }

  shouldRotate() {
    const created = parseInt(this.db.getMeta('secret_created_at') || '0', 10);
    return (Date.now() - created) > CONFIG.TOKEN_ROTATION_MS;
  }

  // ── PIN management
  issuePin() {
    const pin = randomPin(6);
    const expiresAt = Date.now() + CONFIG.PIN_TTL_MS;
    this.activePins.set(pin, { expiresAt });
    return { pin, expiresAt };
  }

  // Consume a PIN: returns true if valid + unused + not expired. Single-use.
  consumePin(pin) {
    const entry = this.activePins.get(pin);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.activePins.delete(pin);
      return false;
    }
    this.activePins.delete(pin);
    return true;
  }

  cleanExpiredPins() {
    const now = Date.now();
    for (const [pin, entry] of this.activePins) {
      if (now > entry.expiresAt) this.activePins.delete(pin);
    }
  }

  // ── Device registration
  // Called after PIN consumption succeeds.
  registerDevice({ name, os, fingerprint }) {
    const id = crypto.randomUUID();
    const deviceToken = randomToken(32);
    this.db.insertDevice({
      id, name: name || 'unnamed', os: os || 'unknown',
      token: deviceToken, fingerprint: fingerprint || null,
      created_at: Date.now(),
      last_seen: null,
    });
    const jwtToken = this.signToken({ device_id: id });
    // We return the shared NETWORK key as `token` to the client; that's what
    // it must use for AES payload encryption so peers can decrypt.
    return { id, token: this.networkKey, jwt: jwtToken };
  }

  // ── JWT
  signToken(payload) {
    const jti = crypto.randomUUID();
    return jwt.sign(
      { ...payload, jti },
      this.serverSecret,
      { algorithm: 'HS256', expiresIn: '30d' }
    );
  }

  verifyToken(jwtStr) {
    try {
      const decoded = jwt.verify(jwtStr, this.serverSecret, { algorithms: ['HS256'] });
      if (decoded.jti && this.db.isJtiRevoked(decoded.jti)) {
        return { ok: false, reason: 'revoked' };
      }
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
  }
}
