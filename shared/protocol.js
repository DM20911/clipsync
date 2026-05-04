// Shared protocol constants and helpers for ClipSync
// Used by both hub and clients.

export const PROTOCOL_VERSION = 1;
export const SERVICE_TYPE = '_clipsync._tcp';
export const DEFAULT_PORT_WSS = 5678;
export const DEFAULT_PORT_HTTP = 5679;

// Limits
export const LIMITS = {
  TEXT_MAX:  1 * 1024 * 1024,      // 1 MB
  IMAGE_MAX: 10 * 1024 * 1024,     // 10 MB
  FILE_MAX:  50 * 1024 * 1024,     // 50 MB
  CHUNK_SIZE: 64 * 1024,           // 64 KB
  HISTORY_MAX_ITEMS: 50,
  HISTORY_TTL_MS: 24 * 60 * 60 * 1000,
};

// Allowed subnets (private LANs only)
export const ALLOWED_SUBNETS = [
  { cidr: '192.168.0.0/16' },
  { cidr: '10.0.0.0/8' },
  { cidr: '172.16.0.0/12' },
  { cidr: '127.0.0.0/8' },
];

// Op codes
export const OP = {
  AUTH:        'auth',
  AUTH_OK:     'auth_ok',
  AUTH_FAIL:   'auth_fail',
  ERROR:       'error',
  PUSH:        'push',
  BROADCAST:   'broadcast',
  PING:        'ping',
  PONG:        'pong',
  HISTORY_REQ: 'history_request',
  HISTORY:     'history',
  DEVICE_JOINED: 'device_joined',
  DEVICE_LEFT:   'device_left',
  REVOKED:     'revoked',
  REGISTER:    'register',
  REGISTER_OK: 'register_ok',
};

export const CLIP_TYPES = ['text', 'image', 'url', 'file'];

export function isUrlClip(text) {
  const t = text.trim();
  return /^https?:\/\//.test(t) && t.length < 2048;
}

export function isValidClip(clip) {
  if (!clip || typeof clip !== 'object') return false;
  if (!clip.id || !clip.type || !clip.timestamp) return false;
  if (!CLIP_TYPES.includes(clip.type)) return false;
  if (typeof clip.size !== 'number' || clip.size < 0) return false;
  return true;
}

export function ipInCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits ? parseInt(bits, 10) : 32;
  const toInt = (a) => a.split('.').reduce((acc, o) => (acc << 8) | parseInt(o, 10), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const ipi = toInt(ip);
  const basei = toInt(base);
  if (mask === 0) return true;
  const m = mask === 32 ? 0xffffffff : (~((1 << (32 - mask)) - 1)) >>> 0;
  return (ipi & m) === (basei & m);
}

export function isPrivateIp(ip) {
  // strip IPv6-mapped prefix
  const v4 = ip.replace(/^::ffff:/, '');
  return ALLOWED_SUBNETS.some((s) => ipInCidr(v4, s.cidr));
}
