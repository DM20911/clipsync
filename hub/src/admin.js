// Admin authentication: token / password / first-device modes + session cookies.
import crypto from 'node:crypto';
import { randomToken, timingSafeEqualBuf, sha256Hex } from '../../shared/crypto-node.js';

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 32;
function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export class Admin {
  constructor({ db, mode = 'token', password = null }) {
    this.db = db;
    this.mode = mode;
    this.password = password;
    this.sessions = new Map();
    this.adminToken = null;
  }

  bootstrap() {
    if (this.mode === 'token') {
      let hash = this.db.getMeta('admin_token_hash');
      if (!hash) {
        const tok = randomToken(32);
        hash = sha256Hex(tok);
        this.db.setMeta('admin_token_hash', hash);
        this.adminTokenHash = hash;
        return tok; // displayed once at creation
      }
      this.adminTokenHash = hash;
      return null;
    }
    if (this.mode === 'password') {
      if (!this.password) throw new Error('CLIPSYNC_ADMIN_PASSWORD required in password mode');
      let salt = this.db.getMeta('admin_pw_salt');
      if (!salt) {
        salt = crypto.randomBytes(16).toString('hex');
        this.db.setMeta('admin_pw_salt', salt);
      }
      this.passwordSalt = salt;
      this.passwordHash = scryptHash(this.password, salt);
    }
    return null;
  }

  verifyCredential(input) {
    if (this.mode === 'token') {
      if (!this.adminTokenHash || !input) return false;
      const a = Buffer.from(this.adminTokenHash, 'hex');
      const b = Buffer.from(sha256Hex(String(input)), 'hex');
      return timingSafeEqualBuf(a, b);
    }
    if (this.mode === 'password') {
      if (!this.passwordHash || !input) return false;
      const candidate = scryptHash(String(input), this.passwordSalt);
      return timingSafeEqualBuf(this.passwordHash, candidate);
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

  isAdminDevice(deviceId) {
    if (this.mode !== 'first-device') return false;
    return !!this.db.getDevice(deviceId)?.is_admin;
  }
}

export function parseCookie(header, name) {
  if (!header) return null;
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = header.match(new RegExp('(?:^|;\\s*)' + escaped + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
