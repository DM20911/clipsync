import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB } from '../db.js';

function tmpDb() {
  return path.join(os.tmpdir(), `clipsync-test-${Date.now()}-${Math.random()}.db`);
}

test('insertDevice with public_key', () => {
  const p = tmpDb();
  const db = new DB(p);
  db.insertDevice({
    id: 'd1', name: 'a', os: 'linux', token: 't', fingerprint: null,
    created_at: 1, last_seen: null, public_key: Buffer.from('pk'),
  });
  const d = db.getDevice('d1');
  assert.equal(d.id, 'd1');
  assert.deepEqual(d.public_key, Buffer.from('pk'));
  db.close();
  fs.unlinkSync(p);
});

test('JTI tracking and revocation cascade', () => {
  const p = tmpDb();
  const db = new DB(p);
  db.insertDevice({ id: 'd1', name: 'a', os: '', token: 't', fingerprint: null, created_at: 1, last_seen: null, public_key: Buffer.from('pk') });
  db.recordJti('jti-1', 'd1', 1, Date.now() + 100000);
  db.recordJti('jti-2', 'd1', 1, Date.now() + 100000);
  db.revokeAllJtisForDevice('d1');
  assert.equal(db.isJtiRevoked('jti-1'), true);
  assert.equal(db.isJtiRevoked('jti-2'), true);
  db.close();
  fs.unlinkSync(p);
});

test('insertHistory rejects duplicate id', () => {
  const p = tmpDb();
  const db = new DB(p);
  const r1 = db.insertHistory({
    id: 'c1', type: 'text', mime: null, size: 1, source_id: 'd1',
    timestamp: 1, checksum: null, payload_b64: 'p', meta_json: '{}',
  });
  const r2 = db.insertHistory({
    id: 'c1', type: 'text', mime: null, size: 2, source_id: 'd1',
    timestamp: 2, checksum: null, payload_b64: 'q', meta_json: '{}',
  });
  assert.equal(r1, true);
  assert.equal(r2, false);
  db.close();
  fs.unlinkSync(p);
});

test('listDevicePublicKeys excludes revoked and self', () => {
  const p = tmpDb();
  const db = new DB(p);
  db.insertDevice({ id: 'd1', name: 'a', os: '', token: 't', fingerprint: null, created_at: 1, last_seen: null, public_key: Buffer.from('pk1') });
  db.insertDevice({ id: 'd2', name: 'b', os: '', token: 't', fingerprint: null, created_at: 1, last_seen: null, public_key: Buffer.from('pk2') });
  db.insertDevice({ id: 'd3', name: 'c', os: '', token: 't', fingerprint: null, created_at: 1, last_seen: null, public_key: Buffer.from('pk3') });
  db.revokeDevice('d3');
  const peers = db.listDevicePublicKeys('d1');
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, 'd2');
  db.close();
  fs.unlinkSync(p);
});

test('hasAnyAdmin reflects is_admin column', () => {
  const p = tmpDb();
  const db = new DB(p);
  assert.equal(db.hasAnyAdmin(), false);
  db.insertDevice({ id: 'd1', name: 'a', os: '', token: 't', fingerprint: null, created_at: 1, last_seen: null, public_key: Buffer.from('pk'), is_admin: 1 });
  assert.equal(db.hasAnyAdmin(), true);
  db.close();
  fs.unlinkSync(p);
});
