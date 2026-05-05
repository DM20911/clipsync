#!/usr/bin/env node
// Generate ClipSync tray icons as 36x36 PNGs (Retina-ready). Pure Node, no deps.
// Output: client-tray/icons/{connected,disconnected,paused,error}.png
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ TABLE[(c ^ buf[i]) & 0xff];
  return ((-1 ^ c) >>> 0);
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(size, draw) {
  const rowBytes = size * 4;
  const raw = Buffer.alloc((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowBytes + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y);
      const i = y * (rowBytes + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function dot(size, fillRgb, ringRgb = null) {
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const rOuter = size / 2 - 1;
  const rInner = ringRgb ? rOuter * 0.55 : rOuter;
  return (x, y) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= rInner - 0.5) return [...fillRgb, 255];
    if (d <= rInner + 0.5) {
      const a = Math.round(255 * (rInner + 0.5 - d));
      return [...fillRgb, a];
    }
    if (ringRgb && d <= rOuter - 0.5) return [...ringRgb, 200];
    if (ringRgb && d <= rOuter + 0.5) {
      const a = Math.round(200 * (rOuter + 0.5 - d));
      return [...ringRgb, a];
    }
    return [0, 0, 0, 0];
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, '..', 'client-tray', 'icons');
fs.mkdirSync(out, { recursive: true });

const states = {
  connected:    { fill: [0x10, 0xb9, 0x81] },                     // emerald
  disconnected: { fill: [0x64, 0x74, 0x8b] },                     // slate
  paused:       { fill: [0xf5, 0x9e, 0x0b] },                     // amber
  error:        { fill: [0xef, 0x44, 0x44], ring: [0xef, 0x44, 0x44] }, // red w/ ring
};

for (const [name, cfg] of Object.entries(states)) {
  for (const size of [18, 36]) {  // 1x and 2x
    const png = makePng(size, dot(size, cfg.fill, cfg.ring));
    const fname = size === 18 ? `${name}.png` : `${name}@2x.png`;
    fs.writeFileSync(path.join(out, fname), png);
  }
}

// Generic 512x512 app icon (just the connected state, larger)
const big = makePng(512, dot(512, [0xf5, 0x9e, 0x0b]));
fs.writeFileSync(path.join(out, 'icon.png'), big);

console.log('Generated tray icons in ' + out);
console.log('  states: connected, disconnected, paused, error (18px + 36px @2x)');
console.log('  app:    icon.png (512px)');
