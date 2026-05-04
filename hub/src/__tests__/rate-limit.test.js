import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, AttemptCounter } from '../rate-limit.js';

test('TokenBucket allows up to capacity then blocks', () => {
  const tb = new TokenBucket({ capacity: 3, refillPerSec: 0 });
  assert.equal(tb.consume('k', 1), true);
  assert.equal(tb.consume('k', 1), true);
  assert.equal(tb.consume('k', 1), true);
  assert.equal(tb.consume('k', 1), false);
});

test('TokenBucket refills over time', async () => {
  const tb = new TokenBucket({ capacity: 1, refillPerSec: 1000 });
  tb.consume('k', 1);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(tb.consume('k', 1), true);
});

test('AttemptCounter blocks after maxAttempts', () => {
  const ac = new AttemptCounter({ maxAttempts: 3, windowMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    const r = ac.hit('ip');
    assert.equal(r.allowed, true);
  }
  assert.equal(ac.hit('ip').allowed, false);
});
