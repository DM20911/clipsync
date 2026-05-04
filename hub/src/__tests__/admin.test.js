import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Admin, parseCookie } from '../admin.js';

function fakeDb() {
  const store = new Map();
  return {
    getMeta: (k) => store.get(k) ?? null,
    setMeta: (k, v) => store.set(k, v),
    getDevice: () => null,
    hasAnyAdmin: () => false,
  };
}

test('token mode generates and verifies', () => {
  const a = new Admin({ db: fakeDb(), mode: 'token' });
  const token = a.bootstrap();
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(a.verifyCredential(token), true);
  assert.equal(a.verifyCredential('wrong'), false);
});

test('token mode reuses persisted token', () => {
  const db = fakeDb();
  const a1 = new Admin({ db, mode: 'token' });
  const t1 = a1.bootstrap();
  const a2 = new Admin({ db, mode: 'token' });
  const t2 = a2.bootstrap();
  assert.equal(t2, null);  // already existed, not reprinted
  assert.equal(a2.verifyCredential(t1), true);
});

test('password mode requires password', () => {
  assert.throws(() => new Admin({ db: fakeDb(), mode: 'password' }).bootstrap(), /required/);
  const a = new Admin({ db: fakeDb(), mode: 'password', password: 'secret' });
  a.bootstrap();
  assert.equal(a.verifyCredential('secret'), true);
  assert.equal(a.verifyCredential('wrong'), false);
});

test('session cookie issuance and verification', () => {
  const a = new Admin({ db: fakeDb(), mode: 'token' });
  a.bootstrap();
  const sid = a.issueSession();
  assert.equal(a.verifySession(sid), true);
  assert.equal(a.verifySession('nope'), false);
  a.revokeSession(sid);
  assert.equal(a.verifySession(sid), false);
});

test('parseCookie extracts named cookie', () => {
  assert.equal(parseCookie('a=1; b=hello; c=3', 'b'), 'hello');
  assert.equal(parseCookie('admin_session=abc', 'admin_session'), 'abc');
  assert.equal(parseCookie('', 'x'), null);
  assert.equal(parseCookie(null, 'x'), null);
});
