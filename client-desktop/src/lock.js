// Single-instance lockfile. Used by both daemon and tray modes to ensure
// only one ClipSync process talks to the hub at a time.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = process.env.CLIPSYNC_CLIENT_DIR
  || path.join(os.homedir(), '.config', 'clipsync', 'client');
const LOCK = path.join(dir, '.lock');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

export function acquire(mode) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(LOCK)) {
    try {
      const data = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      if (data.pid && isAlive(data.pid) && data.pid !== process.pid) {
        return { ok: false, holder: data };
      }
    } catch {}
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, mode, started: Date.now() }), { mode: 0o600 });
  return { ok: true };
}

export function release() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (data.pid === process.pid) fs.unlinkSync(LOCK);
  } catch {}
}

export function inspect() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (data.pid && isAlive(data.pid)) return data;
  } catch {}
  return null;
}
