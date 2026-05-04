// SQLite layer — devices, history, revoked tokens, JTI tracking, public keys.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export class DB {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY, value TEXT
      );
      CREATE TABLE IF NOT EXISTS devices (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        os          TEXT,
        token       TEXT NOT NULL,
        fingerprint TEXT,
        public_key  BLOB,
        is_admin    INTEGER DEFAULT 0,
        created_at  INTEGER NOT NULL,
        last_seen   INTEGER,
        revoked     INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, mime TEXT, size INTEGER,
        source_id TEXT, timestamp INTEGER NOT NULL, checksum TEXT,
        payload_b64 TEXT NOT NULL, meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp DESC);
      CREATE TABLE IF NOT EXISTS revoked_jti (
        jti TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_jtis (
        jti TEXT PRIMARY KEY, device_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_jtis_device ON device_jtis(device_id);
    `);
    const cols = this.db.prepare("PRAGMA table_info(devices)").all().map(c => c.name);
    if (!cols.includes('public_key')) this.db.exec('ALTER TABLE devices ADD COLUMN public_key BLOB');
    if (!cols.includes('is_admin'))   this.db.exec('ALTER TABLE devices ADD COLUMN is_admin INTEGER DEFAULT 0');
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? null;
  }
  setMeta(key, value) {
    this.db.prepare(
      'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ).run(key, value);
  }

  insertDevice(d) {
    this.db.prepare(`
      INSERT INTO devices(id,name,os,token,fingerprint,public_key,created_at,last_seen,revoked,is_admin)
      VALUES(@id,@name,@os,@token,@fingerprint,@public_key,@created_at,@last_seen,0,@is_admin)
    `).run({ is_admin: 0, ...d });
  }
  getDevice(id) {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  }
  listDevices() {
    return this.db.prepare('SELECT id,name,os,fingerprint,is_admin,created_at,last_seen,revoked FROM devices').all();
  }
  listDevicePublicKeys(excludeId) {
    return this.db.prepare(
      'SELECT id, public_key FROM devices WHERE revoked = 0 AND public_key IS NOT NULL AND id != ?'
    ).all(excludeId || '');
  }
  touchDevice(id, ts = Date.now()) {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(ts, id);
  }
  revokeDevice(id) {
    this.db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(id);
  }
  deleteDevice(id) {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }
  setDeviceAdmin(id, isAdmin) {
    this.db.prepare('UPDATE devices SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
  }
  hasAnyAdmin() {
    return this.db.prepare('SELECT COUNT(*) as n FROM devices WHERE is_admin = 1 AND revoked = 0').get().n > 0;
  }

  insertHistory(item) {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO history(id,type,mime,size,source_id,timestamp,checksum,payload_b64,meta_json)
      VALUES(@id,@type,@mime,@size,@source_id,@timestamp,@checksum,@payload_b64,@meta_json)
    `).run(item);
    return r.changes === 1;
  }
  recentHistory(limit = 20) {
    return this.db.prepare('SELECT * FROM history ORDER BY timestamp DESC LIMIT ?').all(limit);
  }
  countHistory() {
    return this.db.prepare('SELECT COUNT(*) as n FROM history').get().n;
  }
  pruneHistory(maxItems, ttlMs) {
    const cutoff = Date.now() - ttlMs;
    this.db.prepare('DELETE FROM history WHERE timestamp < ?').run(cutoff);
    this.db.prepare(`
      DELETE FROM history WHERE id NOT IN (
        SELECT id FROM history ORDER BY timestamp DESC LIMIT ?
      )
    `).run(maxItems);
  }
  clearHistory() {
    this.db.prepare('DELETE FROM history').run();
  }

  recordJti(jti, deviceId, issuedAt, expiresAt) {
    this.db.prepare(
      'INSERT OR IGNORE INTO device_jtis(jti,device_id,issued_at,expires_at) VALUES(?,?,?,?)'
    ).run(jti, deviceId, issuedAt, expiresAt);
  }
  revokeJti(jti, ts = Date.now()) {
    this.db.prepare(
      'INSERT OR IGNORE INTO revoked_jti(jti,revoked_at) VALUES(?,?)'
    ).run(jti, ts);
  }
  isJtiRevoked(jti) {
    return !!this.db.prepare('SELECT 1 FROM revoked_jti WHERE jti = ?').get(jti);
  }
  revokeAllJtisForDevice(deviceId) {
    const now = Date.now();
    const rows = this.db.prepare(
      'SELECT jti FROM device_jtis WHERE device_id = ? AND expires_at > ?'
    ).all(deviceId, now);
    const stmt = this.db.prepare('INSERT OR IGNORE INTO revoked_jti(jti,revoked_at) VALUES(?,?)');
    const tx = this.db.transaction((items) => { for (const r of items) stmt.run(r.jti, now); });
    tx(rows);
  }

  close() { this.db.close(); }
}
