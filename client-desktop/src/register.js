#!/usr/bin/env node
// Interactive PIN-based registration. Generates X25519 keypair on first run.
// Verifies hub TLS cert fingerprint when provided (from QR payload or --fp arg).
import readline from 'node:readline/promises';
import https from 'node:https';
import os from 'node:os';
import tls from 'node:tls';
import { load, save } from './store.js';
import { findHub } from './discovery.js';
import { generateX25519 } from '../../shared/crypto-node.js';

function normalizeFp(fp) {
  return String(fp || '').toUpperCase().replace(/[^0-9A-F]/g, '').match(/../g)?.join(':') || '';
}

async function postJson(url, body, expectedFp = null) {
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
      checkServerIdentity: (host, cert) => {
        if (!expectedFp) return;
        const got = normalizeFp(cert.fingerprint256);
        if (got !== expectedFp) {
          return new Error(`cert fingerprint mismatch: expected ${expectedFp}, got ${got}`);
        }
      },
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

  let qrPayload = null;
  // Accept --qr '<json>' or --fp <fingerprint> from CLI
  const argv = process.argv.slice(2);
  const qrIdx = argv.indexOf('--qr');
  const fpIdx = argv.indexOf('--fp');
  let providedFp = null;
  if (qrIdx >= 0 && argv[qrIdx + 1]) {
    try { qrPayload = JSON.parse(argv[qrIdx + 1]); } catch {}
  }
  if (fpIdx >= 0 && argv[fpIdx + 1]) providedFp = normalizeFp(argv[fpIdx + 1]);

  if (!qrPayload) {
    const raw = (await rl.question('QR payload JSON (or empty to enter manually): ')).trim();
    if (raw) {
      try { qrPayload = JSON.parse(raw); }
      catch { console.warn('invalid QR JSON, falling back to manual entry'); }
    }
  }

  let hubUrl, pin, expectedFp;
  if (qrPayload) {
    hubUrl = qrPayload.hub;
    pin = String(qrPayload.pin || '');
    expectedFp = normalizeFp(qrPayload.fp);
    console.log(`Hub: ${hubUrl}`);
    console.log(`Cert FP: ${expectedFp.slice(0, 32)}...`);
  } else {
    hubUrl = state.hub_url;
    if (!hubUrl) {
      console.log('Searching hub via mDNS (5s)...');
      const found = await findHub({ timeoutMs: 5000 });
      if (found) hubUrl = found.url;
    }
    if (!hubUrl) hubUrl = (await rl.question('Hub WSS URL: ')).trim();
    pin = (await rl.question('PIN: ')).trim();
    expectedFp = providedFp;
    if (!expectedFp) {
      console.warn('⚠ No cert fingerprint provided. First-contact MITM is possible.');
      console.warn('  Recommended: paste full QR JSON from the hub admin panel.');
    }
  }

  const name = (await rl.question(`Device name [${os.hostname()}]: `)).trim() || os.hostname();
  const httpBase = hubUrl.replace(/^wss:/, 'https:').replace(/:(\d+)$/, ':5679');

  let r;
  try {
    r = await postJson(httpBase + '/api/register', {
      pin, name, os: process.platform, fingerprint: null,
      public_key: state.x25519_public_b64,
    }, expectedFp);
  } catch (e) {
    console.error('Registration error:', e.message);
    process.exit(1);
  }
  if (r.status !== 200) {
    console.error('Registration failed:', r.body);
    process.exit(1);
  }

  state.hub_url = hubUrl;
  state.device_id = r.body.id;
  state.jwt = r.body.jwt;
  if (expectedFp) state.hub_cert_fp = expectedFp;
  save(state);
  console.log(`\nOK — device ${r.body.id.slice(0,8)} registered.`);
  console.log('Start the daemon: node client-desktop/src/main.js');
  rl.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
