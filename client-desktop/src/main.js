#!/usr/bin/env node
// ClipSync desktop daemon — clipboard ↔ hub sync loop with envelope encryption.
import crypto from 'node:crypto';
import {
  generateX25519, deriveSharedKey, encryptAesGcm, decryptAesGcm,
  randomBytes, sha256Hex,
} from '../../shared/crypto-node.js';
import { load, save, clear } from './store.js';
import { findHub } from './discovery.js';
import { WsClient } from './ws-client.js';
import { ClipboardMonitor } from './clipboard.js';
import { OP, LIMITS } from '../../shared/protocol.js';

async function main() {
  const state = load();
  if (!state.jwt || !state.x25519_private_b64) {
    console.log('Not registered. Run `npm run register`.');
    process.exit(1);
  }

  const myPriv = Buffer.from(state.x25519_private_b64, 'base64');

  let hubUrl = state.hub_url;
  const fresh = await findHub({ timeoutMs: 4000 });
  if (fresh && fresh.url) hubUrl = fresh.url;
  console.log(`[clipsync] connecting to ${hubUrl}`);

  // Map<deviceId, publicKeyBuffer>
  let peers = new Map();

  const monitor = new ClipboardMonitor({ onChange: (item) => publishLocal(item) });

  const client = new WsClient({
    url: hubUrl,
    jwt: state.jwt,
    expectedFp: state.hub_cert_fp || null,
    onPinFp: (fp) => {
      state.hub_cert_fp = fp; save(state);
      console.log('[clipsync] pinned hub cert fingerprint');
    },
    onCertMismatch: ({ expected, got }) => {
      console.error(`[clipsync] CERT MISMATCH — expected ${expected}, got ${got}`);
      console.error('[clipsync] refusing to connect. Manual review required.');
      process.exit(3);
    },
    onOpen: (msg) => {
      console.log(`[clipsync] connected — device ${msg.device_id.slice(0, 8)} | peers: ${(msg.peers || []).length}`);
      peers = new Map((msg.peers || []).map(p => [p.id, Buffer.from(p.public_key, 'base64')]));
      monitor.start();
      client.send({ op: OP.HISTORY_REQ, limit: 5 });
    },
    onMessage: handleMessage,
    onClose: ({ code, reason }) => {
      console.log(`[clipsync] disconnected (${code}) ${reason || ''} — will reconnect`);
      monitor.stop();
    },
  });
  client.start();

  function publishLocal({ type, mime, data, checksum }) {
    if (data.length > LIMITS.FILE_MAX) {
      console.warn(`[clipsync] payload too large (${data.length}b), skipping`);
      return;
    }
    if (peers.size === 0) return;

    const contentKey = randomBytes(32);
    const encryptedPayload = encryptAesGcm(contentKey, data);
    const eph = generateX25519();
    const wrapSalt = randomBytes(16);
    const wrappedKeys = {};
    for (const [pid, pub] of peers) {
      const wk = deriveSharedKey(eph.privateKey, pub, wrapSalt, 'clipsync-v1');
      wrappedKeys[pid] = encryptAesGcm(wk, contentKey).toString('base64');
    }

    client.send({
      op: OP.PUSH,
      clip: {
        id: crypto.randomUUID(), type, mime,
        size: data.length, timestamp: Date.now(), checksum,
        encrypted_payload: encryptedPayload.toString('base64'),
        sender_ephemeral_public: eph.publicKey.toString('base64'),
        wrap_salt: wrapSalt.toString('base64'),
        wrapped_keys: wrappedKeys,
      },
    });
  }

  function decryptIncoming(c) {
    const senderPub = Buffer.from(c.sender_ephemeral_public, 'base64');
    const wrapSalt  = Buffer.from(c.wrap_salt, 'base64');
    const wk = deriveSharedKey(myPriv, senderPub, wrapSalt, 'clipsync-v1');
    const contentKey = decryptAesGcm(wk, Buffer.from(c.wrapped_key, 'base64'));
    return decryptAesGcm(contentKey, Buffer.from(c.encrypted_payload, 'base64'));
  }

  function handleMessage(m) {
    if (m.op === OP.PEERS) {
      peers = new Map(
        (m.peers || [])
          .filter(p => p.id !== state.device_id)
          .map(p => [p.id, Buffer.from(p.public_key, 'base64')])
      );
      return;
    }
    if (m.op === OP.BROADCAST) {
      const c = m.clip;
      try {
        const buf = decryptIncoming(c);
        if (c.checksum && sha256Hex(buf) !== c.checksum) {
          console.warn('[clipsync] checksum mismatch'); return;
        }
        monitor.write({ type: c.type, mime: c.mime, data: buf })
          .then(() => console.log(`[clipsync] ← ${c.type} (${buf.length}b) from ${c.source_device.slice(0,8)}`))
          .catch((e) => console.warn('[clipsync] write failed:', e.message));
      } catch (e) {
        console.warn('[clipsync] decrypt failed:', e.message);
      }
      return;
    }
    if (m.op === OP.HISTORY) {
      console.log(`[clipsync] history sync: ${m.items.length} items`);
      return;
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
