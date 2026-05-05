// TLS cert provisioning for the hub. Three modes:
//   - external  : user-provided cert.pem + key.pem in TLS_DIR (any CA, including their own ACME / mkcert / corp)
//   - mkcert    : invoke mkcert binary to issue a locally-trusted cert (CLIPSYNC_TLS_MODE=mkcert)
//   - self-signed (default): generate via node-forge, paired with TOFU pinning client-side
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import forge from 'node-forge';

export function fingerprintOf(certPem) {
  const der = Buffer.from(
    String(certPem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64'
  );
  return crypto.createHash('sha256').update(der).digest('hex').match(/../g).join(':').toUpperCase();
}

function localIps() {
  const ips = [];
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

function readCertPair(tlsDir) {
  const keyPath  = path.join(tlsDir, 'key.pem');
  const certPath = path.join(tlsDir, 'cert.pem');
  return { keyPath, certPath };
}

// ── Mode: external ───────────────────────────────────────────────────────────
// User dropped their own key.pem + cert.pem in TLS_DIR (from certbot, mkcert,
// corp CA, whatever). Hub uses them as-is and never overwrites.
function tryExternal(tlsDir) {
  const { keyPath, certPath } = readCertPair(tlsDir);
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
  return {
    key:  fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    mode: 'external',
  };
}

// ── Mode: mkcert ─────────────────────────────────────────────────────────────
// Requires `mkcert` binary in PATH. Runs `mkcert -install` once (no-op on
// subsequent runs) to add the local CA to the user's trust store, then issues
// a cert covering all local IPs + hostnames. Result is browser-trusted on the
// machine that ran mkcert install (and any other where the user installed it).
function tryMkcert(tlsDir) {
  let mkcertBin;
  try {
    mkcertBin = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['mkcert'])
      .toString().trim().split(/\r?\n/)[0];
  } catch {
    throw new Error('CLIPSYNC_TLS_MODE=mkcert requested but mkcert is not in PATH. ' +
                    'Install: https://github.com/FiloSottile/mkcert');
  }

  // Install the local CA into the user trust store (idempotent)
  try { execFileSync(mkcertBin, ['-install'], { stdio: 'inherit' }); }
  catch (e) { throw new Error('mkcert -install failed: ' + e.message); }

  const { keyPath, certPath } = readCertPair(tlsDir);
  const hostnames = [
    'clipsync.local',
    'localhost',
    os.hostname(),
    '127.0.0.1',
    ...localIps(),
  ];
  fs.mkdirSync(tlsDir, { recursive: true });
  execFileSync(mkcertBin, ['-key-file', keyPath, '-cert-file', certPath, ...hostnames],
    { stdio: 'inherit' });
  return {
    key:  fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    mode: 'mkcert',
  };
}

// ── Mode: self-signed (default) ──────────────────────────────────────────────
// Generated on first run. Paired with TOFU pinning on clients.
function generateSelfSigned(tlsDir) {
  const { keyPath, certPath } = readCertPair(tlsDir);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

  const attrs = [
    { name: 'commonName',  value: 'clipsync.local' },
    { name: 'countryName', value: 'US' },
    { shortName: 'O',      value: 'ClipSync' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  const sans = [
    { type: 2, value: 'clipsync.local' },
    { type: 2, value: 'localhost' },
    { type: 2, value: os.hostname() },
    { type: 7, ip: '127.0.0.1' },
  ];
  for (const ip of localIps()) sans.push({ type: 7, ip });

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    { name: 'subjectAltName', altNames: sans },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  fs.mkdirSync(tlsDir, { recursive: true });
  const keyPem  = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, certPem);
  return {
    key:  Buffer.from(keyPem),
    cert: Buffer.from(certPem),
    mode: 'self-signed',
  };
}

export function ensureTlsCert(tlsDir) {
  fs.mkdirSync(tlsDir, { recursive: true });

  // 1) External cert always wins if present (lets users provide their own).
  const ext = tryExternal(tlsDir);
  if (ext) return ext;

  // 2) Explicit mkcert mode
  if ((process.env.CLIPSYNC_TLS_MODE || '').toLowerCase() === 'mkcert') {
    return tryMkcert(tlsDir);
  }

  // 3) Default: self-signed + TOFU
  return generateSelfSigned(tlsDir);
}
