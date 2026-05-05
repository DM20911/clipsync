#!/usr/bin/env node
// Generate clipboard-shaped tray icons. Pure Node, no deps.
// Output: client-tray/icons/{connected,disconnected,paused,error}.png + @2x + icon.png
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
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Clipboard icon. All coords in normalized [0,1] then scaled to size.
// Layout:
//   - clip (top tab):   rect 0.30..0.70 × 0.05..0.22 with rounded top
//   - body:             rect 0.15..0.85 × 0.18..0.92, rounded corners 0.08
//   - lines (faux content): three short horizontal strokes inside body
// Rendering uses signed-distance to rounded rect with smooth alpha.
function clipboardDraw(size, color, accent) {
  const N = size;
  const px = (a) => a * N;
  const sdRoundedBox = (x, y, x0, y0, x1, y1, r) => {
    // distance to a rounded box (negative = inside)
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2;
    const dx = Math.max(Math.abs(x - cx) - hx + r, 0);
    const dy = Math.max(Math.abs(y - cy) - hy + r, 0);
    const out = Math.sqrt(dx*dx + dy*dy) - r;
    const inX = Math.max(Math.abs(x - cx) - hx, 0);
    const inY = Math.max(Math.abs(y - cy) - hy, 0);
    if (inX === 0 && inY === 0) {
      // inside the bounding box
      const ix = Math.min(hx - Math.abs(x - cx), hy - Math.abs(y - cy));
      return -ix;
    }
    return out;
  };
  const cover = (d) => {
    // antialiased coverage: 1 inside, 0 outside, smooth in [-0.5, 0.5]
    if (d <= -0.5) return 1;
    if (d >= 0.5)  return 0;
    return 0.5 - d;
  };
  return (x, y) => {
    // body
    const bodyD = sdRoundedBox(x, y,
      px(0.15), px(0.20), px(0.85), px(0.92), px(0.10) * (N / 36));
    const bodyA = cover(bodyD);
    // clip tab on top
    const tabD = sdRoundedBox(x, y,
      px(0.32), px(0.06), px(0.68), px(0.24), px(0.05) * (N / 36));
    const tabA = cover(tabD);
    // inner lines (faux text) — 3 horizontal strokes
    let lineA = 0;
    for (const ly of [0.42, 0.55, 0.68]) {
      const lD = sdRoundedBox(x, y,
        px(0.28), px(ly - 0.025), px(0.72), px(ly + 0.025), px(0.025) * (N / 36));
      lineA = Math.max(lineA, cover(lD));
    }
    // Compose: body filled with color, tab darker, lines lighter accent
    const a = Math.max(bodyA, tabA);
    if (a <= 0) return [0, 0, 0, 0];
    const dim = (c, f) => Math.max(0, Math.min(255, Math.round(c * f)));
    if (lineA > 0 && bodyA > 0) {
      // accent line over body
      const t = lineA;
      return [
        Math.round(color[0] * (1 - t) + accent[0] * t),
        Math.round(color[1] * (1 - t) + accent[1] * t),
        Math.round(color[2] * (1 - t) + accent[2] * t),
        Math.round(255 * a),
      ];
    }
    if (tabA > bodyA) {
      // darker tab
      return [dim(color[0], 0.7), dim(color[1], 0.7), dim(color[2], 0.7), Math.round(255 * a)];
    }
    return [color[0], color[1], color[2], Math.round(255 * a)];
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, '..', 'client-tray', 'icons');
fs.mkdirSync(out, { recursive: true });

// Color palette — each state = (clipboard color, line accent)
const states = {
  connected:    { color: [0x10, 0xb9, 0x81], accent: [0xff, 0xff, 0xff] }, // emerald
  disconnected: { color: [0x64, 0x74, 0x8b], accent: [0xcb, 0xd5, 0xe1] }, // slate
  paused:       { color: [0xf5, 0x9e, 0x0b], accent: [0xff, 0xf7, 0xed] }, // amber
  error:        { color: [0xef, 0x44, 0x44], accent: [0xff, 0xff, 0xff] }, // red
};

for (const [name, cfg] of Object.entries(states)) {
  for (const size of [18, 36]) {
    const png = makePng(size, clipboardDraw(size, cfg.color, cfg.accent));
    const fname = size === 18 ? `${name}.png` : `${name}@2x.png`;
    fs.writeFileSync(path.join(out, fname), png);
  }
}

// 512×512 app icon — amber clipboard
const big = makePng(512, clipboardDraw(512, [0xf5, 0x9e, 0x0b], [0xff, 0xff, 0xff]));
fs.writeFileSync(path.join(out, 'icon.png'), big);

console.log('Generated clipboard icons in ' + out);
