import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateX25519, deriveSharedKey, encryptAesGcm, decryptAesGcm,
  randomBytes, randomPin,
} from '../../../shared/crypto-node.js';

test('X25519 round trip via HKDF', () => {
  const a = generateX25519();
  const b = generateX25519();
  const salt = randomBytes(16);
  const k1 = deriveSharedKey(a.privateKey, b.publicKey, salt, 'test');
  const k2 = deriveSharedKey(b.privateKey, a.publicKey, salt, 'test');
  assert.deepEqual(k1, k2);
  assert.equal(k1.length, 32);
});

test('AES-GCM encrypt/decrypt', () => {
  const key = randomBytes(32);
  const ct = encryptAesGcm(key, Buffer.from('hello'));
  const pt = decryptAesGcm(key, ct);
  assert.equal(pt.toString(), 'hello');
});

test('randomPin always 6 digits', () => {
  for (let i = 0; i < 100; i++) {
    const p = randomPin(6);
    assert.match(p, /^\d{6}$/);
  }
});
