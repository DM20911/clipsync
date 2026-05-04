// Admin authentication: token / password / first-device modes + session cookies.
import { randomToken, timingSafeEqualBuf, sha256Hex } from '../../shared/crypto-node.js';

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
      if (!this.password || !input) return false;
      const a = Buffer.from(sha256Hex(this.password), 'hex');
      const b = Buffer.from(sha256Hex(String(input)), 'hex');
      return timingSafeEqualBuf(a, b);
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
