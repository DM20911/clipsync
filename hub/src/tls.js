// Self-signed TLS cert generation for local-only use.
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import os from 'node:os';
import crypto from 'node:crypto';

export function fingerprintOf(certPem) {
  const der = Buffer.from(
    String(certPem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    'base64'
  );
  return crypto.createHash('sha256').update(der).digest('hex').match(/../g).join(':').toUpperCase();
}

export function ensureTlsCert(tlsDir) {
  fs.mkdirSync(tlsDir, { recursive: true });
  const keyPath  = path.join(tlsDir, 'key.pem');
  const certPath = path.join(tlsDir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key:  fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

  const attrs = [
    { name: 'commonName',         value: 'clipsync.local' },
    { name: 'countryName',        value: 'US' },
    { shortName: 'O',             value: 'ClipSync' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  // Add SAN entries: hostname + all local IPs + clipsync.local
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

  const keyPem  = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, certPem);
  return { key: Buffer.from(keyPem), cert: Buffer.from(certPem) };
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
