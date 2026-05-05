#!/usr/bin/env node
// Generate ClipSync tray icons: Clippy on white circle with colored state ring.
// Output: client-tray/icons/{connected,disconnected,paused,error}.png + @2x + icon.png
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLIPPY_SRC = path.join(ROOT, 'assets', 'clippy-source.png');
const OUT_DIR    = path.join(ROOT, 'client-tray', 'icons');

// ── Minimal PNG reader (decode IHDR + IDAT for an RGBA8 image) ───────────────
function readPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('ascii', pos, pos + 4); pos += 4;
    const data = buf.subarray(pos, pos + len); pos += len + 4; // skip CRC
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idatChunks.push(data);
    else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  if (bitDepth !== 8) throw new Error('only 8-bit supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : -1;
  if (channels < 0) throw new Error('unsupported color type ' + colorType);

  // Apply PNG row filter reversal
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const i = y * (stride + 1) + 1 + x;
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = (y > 0 && x >= channels) ? pixels[(y - 1) * stride + x - channels] : 0;
      let v = raw[i];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + Math.floor((a + b) / 2)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          v = (v + pr) & 0xff; break;
        }
        default: throw new Error('unknown filter ' + filter);
      }
      pixels[y * stride + x] = v;
    }
  }
  // Convert to RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (channels === 4) { r = pixels[i*4]; g = pixels[i*4+1]; b = pixels[i*4+2]; a = pixels[i*4+3]; }
    else if (channels === 3) { r = pixels[i*3]; g = pixels[i*3+1]; b = pixels[i*3+2]; }
    else if (channels === 2) { r = g = b = pixels[i*2]; a = pixels[i*2+1]; }
    else { r = g = b = pixels[i]; }
    rgba[i*4] = r; rgba[i*4+1] = g; rgba[i*4+2] = b; rgba[i*4+3] = a;
  }
  return { width, height, rgba };
}

// ── Bilinear sample with chroma-key removal of white-ish background ──────────
function sampleClippy(img, u, v) {
  const fx = u * (img.width - 1);
  const fy = v * (img.height - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, img.width - 1), y1 = Math.min(y0 + 1, img.height - 1);
  const tx = fx - x0, ty = fy - y0;
  const get = (x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.rgba[i], img.rgba[i+1], img.rgba[i+2], img.rgba[i+3]];
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const p00 = get(x0, y0), p10 = get(x1, y0), p01 = get(x0, y1), p11 = get(x1, y1);
  const r = lerp(lerp(p00[0], p10[0], tx), lerp(p01[0], p11[0], tx), ty);
  const g = lerp(lerp(p00[1], p10[1], tx), lerp(p01[1], p11[1], tx), ty);
  const b = lerp(lerp(p00[2], p10[2], tx), lerp(p01[2], p11[2], tx), ty);
  return [r | 0, g | 0, b | 0];
}

// ── PNG writer (RGBA8) ───────────────────────────────────────────────────────
const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return ((-1 ^ c) >>> 0);
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function writePng(size, draw) {
  const rowBytes = size * 4;
  const raw = Buffer.alloc((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowBytes + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y);
      const i = y * (rowBytes + 1) + 1 + x * 4;
      raw[i] = r; raw[i+1] = g; raw[i+2] = b; raw[i+3] = a;
    }
  }
  const compressed = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const clippy = readPng(fs.readFileSync(CLIPPY_SRC));

function makeIcon(size, ringColor) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size / 2 - 0.5;
  const rRing  = rOuter - Math.max(2, size * 0.06);   // colored state ring
  const rDisc  = rRing  - Math.max(1, size * 0.025);  // white background
  // Clippy occupies ~70% of the disc
  const clippyRadius = rDisc * 0.78;

  return (x, y) => {
    const dx = x - cx, dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);

    if (d > rOuter + 0.5) return [0, 0, 0, 0];

    // Inside the white disc
    if (d <= rDisc) {
      // Map to clippy texture coords (centered, with margin so he doesn't touch the edge)
      const u = (dx / clippyRadius + 1) / 2;
      const v = (dy / clippyRadius + 1) / 2;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        const [r, g, b] = sampleClippy(clippy, u, v);
        // Treat near-white pixels as the disc background (chroma-key)
        const isBg = r > 230 && g > 230 && b > 230;
        if (isBg) return [255, 255, 255, 255];
        return [r, g, b, 255];
      }
      return [255, 255, 255, 255];
    }

    // Inside the colored ring
    if (d <= rRing + 0.5) {
      const a = d <= rRing - 0.5 ? 255 : Math.round(255 * (rRing + 0.5 - d));
      return [...ringColor, a];
    }

    // Outer anti-aliased edge
    if (d <= rOuter + 0.5) {
      const a = Math.round(255 * (rOuter + 0.5 - d));
      return [...ringColor, a];
    }

    return [0, 0, 0, 0];
  };
}

const states = {
  connected:    [0x10, 0xb9, 0x81], // emerald
  disconnected: [0x64, 0x74, 0x8b], // slate
  paused:       [0xf5, 0x9e, 0x0b], // amber
  error:        [0xef, 0x44, 0x44], // red
};

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, color] of Object.entries(states)) {
  for (const size of [18, 36]) {
    const png = writePng(size, makeIcon(size, color));
    const fname = size === 18 ? `${name}.png` : `${name}@2x.png`;
    fs.writeFileSync(path.join(OUT_DIR, fname), png);
  }
}

// Larger app icon (512×512) — connected state
const big = writePng(512, makeIcon(512, [0xf5, 0x9e, 0x0b]));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), big);
fs.writeFileSync(path.join(ROOT, 'assets', 'logo.png'), big);

console.log('Generated Clippy tray icons:');
console.log('  client-tray/icons/{connected,disconnected,paused,error}.png  (18px + @2x)');
console.log('  client-tray/icons/icon.png  (512px)');
console.log('  assets/logo.png  (512px — README hero)');
