import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPerRecipient, packageHistoryRow } from '../envelope.js';

test('buildPerRecipient picks correct wrapped key per device', () => {
  const clip = {
    id: 'c1', type: 'text', size: 5, timestamp: 1, checksum: 'h',
    encrypted_payload: 'EP', sender_ephemeral_public: 'SP', wrap_salt: 'WS',
    wrapped_keys: { d1: 'WK1', d2: 'WK2' },
  };
  const m1 = buildPerRecipient(clip, 'd1', 'sender');
  assert.equal(m1.clip.wrapped_key, 'WK1');
  assert.equal(m1.clip.wrapped_keys, undefined);
  assert.equal(m1.clip.source_device, 'sender');
  const m2 = buildPerRecipient(clip, 'd2', 'sender');
  assert.equal(m2.clip.wrapped_key, 'WK2');
});

test('buildPerRecipient returns null for excluded device', () => {
  const clip = { wrapped_keys: { d1: 'WK1' } };
  assert.equal(buildPerRecipient(clip, 'd2', 'sender'), null);
});

test('packageHistoryRow extracts recipient wrapped key from meta', () => {
  const row = {
    id: 'c1', type: 'text', mime: null, size: 5, source_id: 's', timestamp: 1, checksum: 'h',
    payload_b64: 'EP',
    meta_json: JSON.stringify({
      sender_ephemeral_public: 'SP', wrap_salt: 'WS',
      wrapped_keys: { d1: 'WK1' },
    }),
  };
  const out = packageHistoryRow(row, 'd1');
  assert.equal(out.encrypted_payload, 'EP');
  assert.equal(out.wrapped_key, 'WK1');
  assert.equal(out.sender_ephemeral_public, 'SP');
});

test('packageHistoryRow returns null when no key for recipient', () => {
  const row = { meta_json: JSON.stringify({ wrapped_keys: { d1: 'WK1' } }) };
  assert.equal(packageHistoryRow(row, 'd2'), null);
});
