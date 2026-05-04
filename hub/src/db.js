// SQLite layer — devices, history, revoked tokens.
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
        key   TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS devices (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        os          TEXT,
        token       TEXT NOT NULL,        -- shared secret used for AES key derivation
        fingerprint TEXT,
        created_at  INTEGER NOT NULL,
        last_seen   INTEGER,
        revoked     INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS history (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        mime        TEXT,
        size        INTEGER,
        source_id   TEXT,
        timestamp   INTEGER NOT NULL,
        checksum    TEXT,
        payload_b64 TEXT NOT NULL,        -- already-encrypted payload
        meta_json   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp DESC);
      CREATE TABLE IF NOT EXISTS revoked_jti (
        jti        TEXT PRIMARY KEY,
        revoked_at INTEGER NOT NULL
      );
    `);
  }

  // ── meta (server secret, etc.)
  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value ?? null;
  }
  setMeta(key, value) {
    this.db.prepare(
      'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ).run(key, value);
  }

  // ── devices
  insertDevice(d) {
    this.db.prepare(`
      INSERT INTO devices(id,name,os,token,fingerprint,created_at,last_seen,revoked)
      VALUES(@id,@name,@os,@token,@fingerprint,@created_at,@last_seen,0)
    `).run(d);
  }
  getDevice(id) {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  }
  listDevices() {
    return this.db.prepare('SELECT id,name,os,fingerprint,created_at,last_seen,revoked FROM devices').all();
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

  // ── history
  insertHistory(item) {
    this.db.prepare(`
      INSERT OR REPLACE INTO history(id,type,mime,size,source_id,timestamp,checksum,payload_b64,meta_json)
      VALUES(@id,@type,@mime,@size,@source_id,@timestamp,@checksum,@payload_b64,@meta_json)
    `).run(item);
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

  // ── revoked JTI list
  revokeJti(jti, ts = Date.now()) {
    this.db.prepare(
      'INSERT OR IGNORE INTO revoked_jti(jti,revoked_at) VALUES(?,?)'
    ).run(jti, ts);
  }
  isJtiRevoked(jti) {
    return !!this.db.prepare('SELECT 1 FROM revoked_jti WHERE jti = ?').get(jti);
  }

  close() { this.db.close(); }
}
