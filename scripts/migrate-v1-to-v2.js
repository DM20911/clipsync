#!/usr/bin/env node
// ClipSync v1 → v2 migration.
// v2 introduces envelope encryption (X25519 per device). The shared `networkKey`
// from v1 is removed and history is unreadable under the new scheme. This script:
//   1. Backs up the v1 DB (clipsync.db → clipsync.db.v1.bak)
//   2. Drops the history table (clips were encrypted with the old shared key)
//   3. Marks all v1 devices as revoked so they must re-register
//   4. Removes the legacy network_key meta entry
//
// Hub keeps running. All clients must re-run `register.js` with a fresh PIN.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const dataDir = process.env.CLIPSYNC_DATA_DIR
  || path.join(os.homedir(), '.config', 'clipsync', 'hub');
const dbPath = path.join(dataDir, 'clipsync.db');

if (!fs.existsSync(dbPath)) {
  console.log(`No DB at ${dbPath} — nothing to migrate.`);
  process.exit(0);
}

const backup = `${dbPath}.v1.bak`;
console.log(`Backing up ${dbPath} → ${backup}`);
fs.copyFileSync(dbPath, backup);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const cols = db.prepare("PRAGMA table_info(devices)").all().map(c => c.name);
const isV1 = !cols.includes('public_key');

if (!isV1) {
  console.log('Schema is already v2. No migration needed.');
  db.close();
  process.exit(0);
}

console.log('Migrating v1 → v2:');

const tx = db.transaction(() => {
  console.log('  - dropping history (old encryption scheme)');
  db.exec('DELETE FROM history');

  console.log('  - revoking all v1 devices (force re-registration)');
  db.exec('UPDATE devices SET revoked = 1');

  console.log('  - removing legacy network_key');
  db.prepare('DELETE FROM meta WHERE key = ?').run('network_key');

  // The new schema is created by db.js#migrate when the hub next starts
  // (it ALTERs to add public_key + is_admin columns). Nothing to do here.
});
tx();

db.close();
console.log('\nMigration complete.');
console.log('Next steps:');
console.log('  1. Restart the hub: npm start');
console.log('  2. Generate fresh PINs for each device');
console.log('  3. Re-register every client (desktop + PWA)');
console.log(`\nBackup at: ${backup} (delete after you confirm v2 works)`);
