// Lightweight metadata-only logger with rotation. Never logs payload contents.
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 3;
const LOG_PATH  = path.join(CONFIG.DATA_DIR, 'hub.log');

function rotate() {
  if (!fs.existsSync(LOG_PATH)) return;
  const { size } = fs.statSync(LOG_PATH);
  if (size < MAX_BYTES) return;
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const src = `${LOG_PATH}.${i}`;
    const dst = `${LOG_PATH}.${i + 1}`;
    if (fs.existsSync(src)) fs.renameSync(src, dst);
  }
  fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
}

function write(level, msg, extra) {
  rotate();
  const line = JSON.stringify({
    t: new Date().toISOString(), level, msg, ...extra,
  }) + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line);
  } catch (_) { /* ignore */ }
  const printer = level === 'error' ? console.error : console.log;
  printer(`[${level}] ${msg}`, extra ?? '');
}

export const log = {
  info:  (msg, extra) => write('info',  msg, extra),
  warn:  (msg, extra) => write('warn',  msg, extra),
  error: (msg, extra) => write('error', msg, extra),
  event: (msg, extra) => write('event', msg, extra),
};
