// Same AES-256-GCM scheme as hub/src/crypto.js — duplicated so the client has zero hub-side imports.
import crypto from 'node:crypto';

const PBKDF2_ITER = 100_000;
const KEY_LEN  = 32;
const SALT_LEN = 16;
const IV_LEN   = 12;
const TAG_LEN  = 16;

function deriveKey(token, salt) {
  return crypto.pbkdf2Sync(token, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
}

export function encrypt(payload, token) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key  = deriveKey(token, salt);
  const iv   = crypto.randomBytes(IV_LEN);
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
  const key  = deriveKey(token, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export function sha256Hex(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return crypto.createHash('sha256').update(data).digest('hex');
}
