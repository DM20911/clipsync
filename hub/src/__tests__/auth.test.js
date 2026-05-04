import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DB } from '../db.js';
import { Auth } from '../auth.js';

function tmpDb() {
  const p = path.join(os.tmpdir(), `clipsync-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return { db: new DB(p), path: p };
}

test('issuePin returns valid 6-digit pin and stores it', () => {
  const { db, path: p } = tmpDb();
  const auth = new Auth(db);
  const { pin, expiresAt } = auth.issuePin();
  assert.match(pin, /^\d{6}$/);
  assert.ok(expiresAt > Date.now());
  db.close(); fs.unlinkSync(p);
});

test('consumePin succeeds once, then fails', () => {
  const { db, path: p } = tmpDb();
  const auth = new Auth(db);
  const { pin } = auth.issuePin();
  assert.ok(auth.consumePin(pin));
  assert.ok(!auth.consumePin(pin));
  db.close(); fs.unlinkSync(p);
});

test('register → verifyToken roundtrip', () => {
  const { db, path: p } = tmpDb();
  const auth = new Auth(db);
  const reg = auth.registerDevice({ name: 'TestBox', os: 'darwin' });
  assert.ok(reg.id);
  assert.ok(reg.jwt);
  // token returned is the network key (shared); verify it matches Auth.networkKey
  assert.equal(reg.token, auth.getNetworkKey());

  const v = auth.verifyToken(reg.jwt);
  assert.ok(v.ok);
  assert.equal(v.device.id, reg.id);
  db.close(); fs.unlinkSync(p);
});

test('revoked device fails verifyToken', () => {
  const { db, path: p } = tmpDb();
  const auth = new Auth(db);
  const reg = auth.registerDevice({ name: 'X' });
  auth.revokeDevice(reg.id);
  const v = auth.verifyToken(reg.jwt);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'device_revoked');
  db.close(); fs.unlinkSync(p);
});

test('rotateSecret invalidates old tokens', () => {
  const { db, path: p } = tmpDb();
  const auth = new Auth(db);
  const reg = auth.registerDevice({ name: 'X' });
  auth.rotateSecret();
  const v = auth.verifyToken(reg.jwt);
  assert.equal(v.ok, false);
  db.close(); fs.unlinkSync(p);
});

test('all devices share the same network key', () => {
  const { db, path: p } = tmpDb();
  const auth = new Auth(db);
  const a = auth.registerDevice({ name: 'A' });
  const b = auth.registerDevice({ name: 'B' });
  assert.equal(a.token, b.token);
  db.close(); fs.unlinkSync(p);
});
