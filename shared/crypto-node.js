// AES-256-GCM + X25519 + HKDF + helpers. Used by hub and Node clients.
import crypto from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

export function generateX25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
  };
}

export function importX25519Private(der) {
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}
export function importX25519Public(der) {
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function deriveSharedKey(privDer, pubDer, salt, info) {
  const priv = importX25519Private(privDer);
  const pub  = importX25519Public(pubDer);
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(info, 'utf8'), 32));
}

// Layout: [iv:12][tag:16][ciphertext]
export function encryptAesGcm(key, payload) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decryptAesGcm(key, buf) {
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export function randomBytes(n) { return crypto.randomBytes(n); }
export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
export function randomPin(digits = 6) {
  const max = 10 ** digits;
  return String(crypto.randomInt(0, max)).padStart(digits, '0');
}
export function sha256Hex(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return crypto.createHash('sha256').update(data).digest('hex');
}
export function timingSafeEqualBuf(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
