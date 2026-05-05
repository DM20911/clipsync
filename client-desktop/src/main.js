#!/usr/bin/env node
// ClipSync daemon entry — uses SyncEngine in headless mode.
import { SyncEngine } from './engine.js';
import { acquire, release, inspect } from './lock.js';

const lock = acquire('daemon');
if (!lock.ok) {
  console.error(`[clipsync] another instance is running (pid=${lock.holder.pid}, mode=${lock.holder.mode}).`);
  console.error('[clipsync] use `clipsync switch daemon` to swap modes.');
  process.exit(1);
}

const engine = new SyncEngine();
if (!engine.isRegistered()) {
  console.log('Not registered. Run `npm run register`.');
  release(); process.exit(1);
}

engine.on('connected', (s) => console.log(`[clipsync] connected — device ${s.device_id?.slice(0,8)} | peers: ${s.peer_count}`));
engine.on('disconnected', ({ code, reason }) => console.log(`[clipsync] disconnected (${code}) ${reason || ''} — will reconnect`));
engine.on('cert-pinned', (fp) => console.log(`[clipsync] pinned hub cert ${fp.slice(0,16)}…`));
engine.on('cert-mismatch', ({ expected, got }) => {
  console.error(`[clipsync] CERT MISMATCH — expected ${expected}, got ${got}`);
  console.error('[clipsync] refusing to connect. Manual review required.');
  release(); process.exit(3);
});
engine.on('clip', (c) => {
  if (c.direction === 'received') console.log(`[clipsync] ← ${c.type} (${c.size}b)`);
  else console.log(`[clipsync] → ${c.type} (${c.size}b)`);
});
engine.on('warn', (msg) => console.warn(`[clipsync] ${msg}`));
engine.on('auth-fail', (reason) => {
  console.error(`[clipsync] auth failed: ${reason}`);
  if (reason === 'revoked' || reason === 'device_revoked') {
    console.error('[clipsync] device revoked. cleared local state.');
    release(); process.exit(2);
  }
});
engine.on('forgotten', () => { release(); process.exit(2); });

await engine.start();

const shutdown = () => { engine.stop(); release(); process.exit(0); };
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
process.on('exit',    () => release());
