// AES-256-GCM payload encryption + PBKDF2 key derivation.
// Key is derived per-device from the shared token.
import crypto from 'node:crypto';

const PBKDF2_ITER = 100_000;
const KEY_LEN = 32;          // 256-bit
const SALT_LEN = 16;
const IV_LEN = 12;           // GCM standard
const TAG_LEN = 16;

export function deriveKey(token, salt) {
  return crypto.pbkdf2Sync(token, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
}

export function newSalt() {
  return crypto.randomBytes(SALT_LEN);
}

// payload: Buffer | string. Returns a single base64 string.
// Layout: [salt:16][iv:12][tag:16][ciphertext]
export function encrypt(payload, token) {
  const salt = newSalt();
  const key = deriveKey(token, salt);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

export function decrypt(b64, token) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < SALT_LEN + IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const salt = buf.subarray(0, SALT_LEN);
  const iv   = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag  = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const enc  = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);
  const key = deriveKey(token, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export function sha256Hex(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomPin(digits = 6) {
  // Cryptographically secure 6-digit PIN, zero-padded.
  const max = 10 ** digits;
  const buf = crypto.randomBytes(4);
  const n = buf.readUInt32BE(0) % max;
  return String(n).padStart(digits, '0');
}
