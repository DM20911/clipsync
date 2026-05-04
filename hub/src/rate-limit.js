// Token bucket and attempt counter — used for WS PUSH and PIN brute-force defense.

export class TokenBucket {
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
  }
  consume(key, n = 1) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, last: now }; this.buckets.set(key, b); }
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.last = now;
    if (b.tokens < n) return false;
    b.tokens -= n;
    return true;
  }
  reset(key) { this.buckets.delete(key); }
  cleanup(maxIdleMs = 600_000) {
    const cutoff = Date.now() - maxIdleMs;
    for (const [k, b] of this.buckets) if (b.last < cutoff) this.buckets.delete(k);
  }
}

export class AttemptCounter {
  constructor({ maxAttempts, windowMs }) {
    this.max = maxAttempts;
    this.windowMs = windowMs;
    this.counts = new Map();
  }
  hit(key) {
    const now = Date.now();
    let e = this.counts.get(key);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + this.windowMs }; this.counts.set(key, e); }
    e.count++;
    return { allowed: e.count <= this.max, remaining: Math.max(0, this.max - e.count), resetAt: e.resetAt };
  }
  reset(key) { this.counts.delete(key); }
  cleanup() {
    const now = Date.now();
    for (const [k, e] of this.counts) if (now > e.resetAt) this.counts.delete(k);
  }
}
