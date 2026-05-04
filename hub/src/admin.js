// Admin authentication: token / password / first-device modes + session cookies.
import { randomToken, timingSafeEqualBuf } from '../../shared/crypto-node.js';

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
      let tok = this.db.getMeta('admin_token');
      let printed = false;
      if (!tok) {
        tok = randomToken(32);
        this.db.setMeta('admin_token', tok);
        printed = true;
      }
      this.adminToken = tok;
      return printed ? tok : null;
    }
    if (this.mode === 'password') {
      if (!this.password) throw new Error('CLIPSYNC_ADMIN_PASSWORD required in password mode');
    }
    return null;
  }

  verifyCredential(input) {
    if (this.mode === 'token') {
      if (!this.adminToken || !input) return false;
      const a = Buffer.from(this.adminToken);
      const b = Buffer.from(String(input));
      return timingSafeEqualBuf(a, b);
    }
    if (this.mode === 'password') {
      if (!this.password || !input) return false;
      const a = Buffer.from(this.password);
      const b = Buffer.from(String(input));
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
  const m = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
