#!/usr/bin/env node
// Interactive PIN-based registration. Generates X25519 keypair on first run.
import readline from 'node:readline/promises';
import https from 'node:https';
import os from 'node:os';
import { load, save } from './store.js';
import { findHub } from './discovery.js';
import { generateX25519 } from '../../shared/crypto-node.js';

async function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      method: 'POST',
      host: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      rejectUnauthorized: false,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('ClipSync registration\n');

  let state = load();
  if (!state.x25519_private_b64) {
    const kp = generateX25519();
    state.x25519_private_b64 = kp.privateKey.toString('base64');
    state.x25519_public_b64  = kp.publicKey.toString('base64');
  }

  let hubUrl = state.hub_url;
  if (!hubUrl) {
    console.log('Searching hub via mDNS (5s)...');
    const found = await findHub({ timeoutMs: 5000 });
    if (found) hubUrl = found.url;
  }
  if (!hubUrl) hubUrl = await rl.question('Hub WSS URL (e.g. wss://192.168.1.10:5678): ');
  hubUrl = hubUrl.trim();
  const httpBase = hubUrl.replace(/^wss:/, 'https:').replace(/:(\d+)$/, ':5679');

  const pin  = (await rl.question('PIN: ')).trim();
  const name = (await rl.question(`Device name [${os.hostname()}]: `)).trim() || os.hostname();

  const r = await postJson(httpBase + '/api/register', {
    pin, name, os: process.platform, fingerprint: null,
    public_key: state.x25519_public_b64,
  });
  if (r.status !== 200) {
    console.error('Registration failed:', r.body);
    process.exit(1);
  }

  state.hub_url = hubUrl;
  state.device_id = r.body.id;
  state.jwt = r.body.jwt;
  save(state);
  console.log(`\nOK — device ${r.body.id.slice(0,8)} registered.`);
  console.log('Start the daemon: node client-desktop/src/main.js');
  rl.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
