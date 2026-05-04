// Persistent local store. Fields:
//   device_id, jwt, hub_url, hub_cert_fp,
//   x25519_private_b64, x25519_public_b64
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = process.env.CLIPSYNC_CLIENT_DIR
  || path.join(os.homedir(), '.config', 'clipsync', 'client');
const FILE = path.join(dir, 'state.json');

export function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}
export function save(state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}
export function clear() {
  try { fs.unlinkSync(FILE); } catch {}
}
export const STATE_DIR = dir;
