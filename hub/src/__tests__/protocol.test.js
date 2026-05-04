import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidClip, ipInCidr, isPrivateIp, OP } from '../../../shared/protocol.js';

test('isValidClip accepts well-formed clip', () => {
  assert.ok(isValidClip({
    id: 'a-1', type: 'text', size: 5, timestamp: Date.now(),
  }));
});

test('isValidClip rejects missing fields', () => {
  assert.equal(isValidClip(null), false);
  assert.equal(isValidClip({}), false);
  assert.equal(isValidClip({ id: 'a', type: 'text' }), false);
  assert.equal(isValidClip({ id: 'a', type: 'foo', size: 1, timestamp: 1 }), false);
  assert.equal(isValidClip({ id: 'a', type: 'text', size: -1, timestamp: 1 }), false);
});

test('ipInCidr basic matches', () => {
  assert.ok(ipInCidr('192.168.1.5', '192.168.0.0/16'));
  assert.ok(ipInCidr('10.20.30.40', '10.0.0.0/8'));
  assert.ok(ipInCidr('172.20.5.1', '172.16.0.0/12'));
  assert.ok(!ipInCidr('8.8.8.8', '192.168.0.0/16'));
});

test('isPrivateIp', () => {
  assert.ok(isPrivateIp('192.168.10.20'));
  assert.ok(isPrivateIp('10.0.0.1'));
  assert.ok(isPrivateIp('172.16.5.5'));
  assert.ok(isPrivateIp('::ffff:192.168.1.1'));
  assert.ok(!isPrivateIp('8.8.8.8'));
  assert.ok(!isPrivateIp('203.0.113.5'));
});

test('OP constants are unique strings', () => {
  const vals = Object.values(OP);
  assert.equal(new Set(vals).size, vals.length);
});
