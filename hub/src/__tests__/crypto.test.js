import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, sha256Hex, randomToken, randomPin } from '../crypto.js';

test('encrypt → decrypt roundtrip (text)', () => {
  const tok = randomToken(32);
  const ct = encrypt('hello, clipsync', tok);
  const pt = decrypt(ct, tok).toString('utf8');
  assert.equal(pt, 'hello, clipsync');
});

test('encrypt → decrypt roundtrip (binary)', () => {
  const tok = randomToken(32);
  const buf = Buffer.from([0, 1, 2, 3, 254, 255, 0, 128]);
  const ct = encrypt(buf, tok);
  const pt = decrypt(ct, tok);
  assert.deepEqual([...pt], [...buf]);
});

test('decrypt with wrong token throws', () => {
  const ct = encrypt('secret', 'token-A-xxxxxxxxxxxxxxx');
  assert.throws(() => decrypt(ct, 'token-B-yyyyyyyyyyyyyyy'));
});

test('decrypt with tampered ciphertext throws (auth tag check)', () => {
  const tok = randomToken(32);
  const ct = encrypt('secret', tok);
  const buf = Buffer.from(ct, 'base64');
  buf[buf.length - 1] ^= 0x01;
  assert.throws(() => decrypt(buf.toString('base64'), tok));
});

test('sha256Hex returns 64-char hex', () => {
  const h = sha256Hex('abc');
  assert.equal(h.length, 64);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('two encryptions of same plaintext differ (random salt+iv)', () => {
  const tok = randomToken(32);
  const a = encrypt('same', tok);
  const b = encrypt('same', tok);
  assert.notEqual(a, b);
});

test('randomPin produces 6-digit zero-padded strings', () => {
  for (let i = 0; i < 50; i++) {
    const pin = randomPin(6);
    assert.match(pin, /^\d{6}$/);
  }
});
