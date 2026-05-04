#!/usr/bin/env node
// ClipSync desktop daemon — clipboard ↔ hub sync loop.
import os from 'node:os';
import crypto from 'node:crypto';

import { load, save, clear } from './store.js';
import { findHub } from './discovery.js';
import { WsClient } from './ws-client.js';
import { ClipboardMonitor } from './clipboard.js';
import { encrypt, decrypt, sha256Hex } from './crypto-bridge.js';
import { OP, LIMITS } from '../../shared/protocol.js';

async function main() {
  const state = load();

  if (!state.jwt || !state.token) {
    console.log('No registration found. Run `npm run register` first.');
    process.exit(1);
  }

  let hubUrl = state.hub_url;
  // Try mDNS for a fresh URL each boot (handles IP changes).
  const fresh = await findHub({ timeoutMs: 4000 });
  if (fresh && fresh.url) hubUrl = fresh.url;

  console.log(`[clipsync] connecting to ${hubUrl}`);

  const monitor = new ClipboardMonitor({
    onChange: (item) => publishLocal(item),
  });

  const client = new WsClient({
    url: hubUrl,
    jwt: state.jwt,
    onOpen: (msg) => {
      console.log(`[clipsync] connected — device ${msg.device_id.slice(0, 8)} | peers: ${msg.devices.length}`);
      monitor.start();
      // Request recent history so we sync to current state.
      client.send({ op: OP.HISTORY_REQ, limit: 5 });
    },
    onMessage: (m) => handleMessage(m),
    onClose: ({ code, reason }) => {
      console.log(`[clipsync] disconnected (${code}) ${reason || ''} — will reconnect`);
      monitor.stop();
    },
  });

  client.start();

  // ── Outbound: encrypt + push
  function publishLocal({ type, mime, data, checksum }) {
    if (data.length > LIMITS.FILE_MAX) {
      console.warn(`[clipsync] payload too large (${data.length}b), skipping`);
      return;
    }
    const id = crypto.randomUUID();
    const payload_b64 = encrypt(data, state.token);
    client.send({
      op: OP.PUSH,
      clip: {
        id, type, mime,
        size: data.length,
        timestamp: Date.now(),
        checksum,
        payload_b64,
      },
    });
  }

  // ── Inbound: decrypt + write to OS clipboard
  function handleMessage(m) {
    if (m.op === OP.BROADCAST) {
      const c = m.clip;
      if (c.source_device === state.device_id) return;     // own echo
      try {
        const buf = decrypt(c.payload_b64, state.token);
        // Verify checksum
        if (c.checksum && sha256Hex(buf) !== c.checksum) {
          console.warn('[clipsync] checksum mismatch — dropped');
          return;
        }
        monitor.write({ type: c.type, mime: c.mime, data: buf })
          .then(() => console.log(`[clipsync] ← ${c.type} (${buf.length}b) from ${c.source_device.slice(0,8)}`))
          .catch((e) => console.warn('[clipsync] write failed:', e.message));
      } catch (e) {
        console.warn('[clipsync] decrypt failed:', e.message);
      }
    }
    if (m.op === OP.HISTORY) {
      // Optionally seed last clip — we just log for now.
      console.log(`[clipsync] history sync: ${m.items.length} items`);
    }
    if (m.op === OP.AUTH_FAIL) {
      console.error('[clipsync] auth failed:', m.reason);
      if (m.reason === 'revoked' || m.reason === 'device_revoked') {
        clear();
        console.error('[clipsync] this device was revoked. cleared local state.');
        process.exit(2);
      }
    }
  }

  process.on('SIGINT',  () => { client.stop(); monitor.stop(); process.exit(0); });
  process.on('SIGTERM', () => { client.stop(); monitor.stop(); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
