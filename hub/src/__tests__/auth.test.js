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
function freshAuth() {
  const { db, path: p } = tmpDb();
  return { db, auth: new Auth(db), cleanup: () => { db.close(); fs.unlinkSync(p); } };
}

test('issuePin returns valid 6-digit pin', () => {
  const { auth, cleanup } = freshAuth();
  const { pin, expiresAt } = auth.issuePin();
  assert.match(pin, /^\d{6}$/);
  assert.ok(expiresAt > Date.now());
  cleanup();
});

test('consumePin succeeds once, then fails', () => {
  const { auth, cleanup } = freshAuth();
  const { pin } = auth.issuePin();
  assert.ok(auth.consumePin(pin));
  assert.ok(!auth.consumePin(pin));
  cleanup();
});

test('PIN invalidated after 5 failures', () => {
  const { auth, cleanup } = freshAuth();
  const { pin } = auth.issuePin();
  for (let i = 0; i < 5; i++) auth.consumePin('000000');
  assert.equal(auth.consumePin(pin), false);
  cleanup();
});

test('registerDevice rejects oversize name', () => {
  const { auth, cleanup } = freshAuth();
  assert.throws(
    () => auth.registerDevice({ name: 'x'.repeat(100), os: 'l', publicKey: Buffer.from('pk') }),
    /invalid_name/
  );
  cleanup();
});

test('registerDevice rejects missing public key', () => {
  const { auth, cleanup } = freshAuth();
  assert.throws(
    () => auth.registerDevice({ name: 'A', os: 'l', publicKey: null }),
    /invalid_public_key/
  );
  cleanup();
});

test('register → verifyToken roundtrip', () => {
  const { auth, cleanup } = freshAuth();
  const reg = auth.registerDevice({ name: 'TestBox', os: 'darwin', publicKey: Buffer.from('pk') });
  assert.ok(reg.id);
  assert.ok(reg.jwt);
  const v = auth.verifyToken(reg.jwt);
  assert.ok(v.ok);
  assert.equal(v.device.id, reg.id);
  cleanup();
});

test('JTI revocation cascade closes JWTs', () => {
  const { auth, cleanup } = freshAuth();
  const reg = auth.registerDevice({ name: 'a', os: 'l', publicKey: Buffer.from('pk') });
  assert.equal(auth.verifyToken(reg.jwt).ok, true);
  auth.revokeDevice(reg.id);
  const v = auth.verifyToken(reg.jwt);
  assert.equal(v.ok, false);
  cleanup();
});

test('rotateSecret invalidates old tokens', () => {
  const { auth, cleanup } = freshAuth();
  const reg = auth.registerDevice({ name: 'X', os: 'l', publicKey: Buffer.from('pk') });
  auth.rotateSecret();
  const v = auth.verifyToken(reg.jwt);
  assert.equal(v.ok, false);
  cleanup();
});
