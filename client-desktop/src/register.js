#!/usr/bin/env node
// CLI registration: prompts for PIN, connects to hub, persists JWT + token.
import readline from 'node:readline/promises';
import os from 'node:os';
import WebSocket from 'ws';
import { findHub } from './discovery.js';
import { load, save } from './store.js';
import { OP } from '../../shared/protocol.js';

async function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

async function main() {
  console.log('ClipSync — device registration');
  console.log('  Searching the LAN for a hub via mDNS …');

  let hub = await findHub({ timeoutMs: 6000 });
  let url;
  if (hub) {
    console.log(`  Found hub: ${hub.name} at ${hub.url}`);
    url = hub.url;
  } else {
    const manual = await prompt('  No hub found via mDNS.\n  Enter hub URL (e.g. wss://192.168.1.10:5678): ');
    if (!manual) process.exit(1);
    url = manual;
  }

  const pin = await prompt('  Enter the 6-digit PIN shown on the hub: ');
  if (!/^\d{6}$/.test(pin)) {
    console.error('  invalid PIN format');
    process.exit(1);
  }

  const ws = new WebSocket(url, { rejectUnauthorized: false });
  ws.on('open', () => {
    ws.send(JSON.stringify({
      op: OP.REGISTER,
      pin,
      name: os.hostname(),
      os: `${process.platform}-${process.arch}`,
      fingerprint: null,
    }));
  });

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString('utf8'));
    if (m.op === OP.REGISTER_OK) {
      save({
        hub_url: url,
        device_id: m.device_id,
        token: m.token,
        jwt: m.jwt,
        registered_at: Date.now(),
      });
      console.log('\n  ✓ registered. Device id:', m.device_id);
      console.log('  Run `clipsync` (or `npm start`) to start syncing.');
      ws.close(1000, 'done');
      process.exit(0);
    }
    if (m.op === OP.AUTH_FAIL) {
      console.error('  registration failed:', m.reason);
      process.exit(2);
    }
  });

  ws.on('error', (e) => {
    console.error('  connection error:', e.message);
    process.exit(3);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
