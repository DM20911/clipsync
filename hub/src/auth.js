// PIN-based registration → JWT issuance, verification, revocation cascade.
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
  if (fingerprint != null && fingerprint !== '' && !FP_RE.test(String(fingerprint))) {
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
    const expiresAt = Date.now() + CONFIG.PIN_TTL_MS;
    this.activePins.set(hash, { salt, expiresAt, failures: 0 });
    return { pin, expiresAt };
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
    // Wrong — bump failure counter on all unexpired (we can't tell which PIN was targeted)
    for (const [hash, entry] of this.activePins) {
      if (now > entry.expiresAt) continue;
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
