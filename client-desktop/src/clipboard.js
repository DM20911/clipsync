// Cross-platform clipboard monitor.
// Text via clipboardy. Images via OS-native helpers (osascript/xclip/PowerShell).
import clipboardy from 'clipboardy';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isUrlClip } from '../../shared/protocol.js';

const exec = promisify(execFile);
const platform = process.platform;

const POLL_MS = parseInt(process.env.CLIPSYNC_POLL_MS || '150', 10);
// Skip clipboard images entirely — useful when image sync causes problems
// (Windows re-encodes PNGs each write, leading to echo loops on big binaries).
// Text and URLs continue to sync.
const TEXT_ONLY = process.env.CLIPSYNC_TEXT_ONLY === '1' ||
                  process.env.CLIPSYNC_TEXT_ONLY === 'true';

export class ClipboardMonitor {
  constructor({ onChange }) {
    this.onChange = onChange;
    this.lastHash = null;
    this.timer = null;
    this.suppressedHashes = new Set();
    this.pollPausedUntil = 0;   // Skip polling while OS settles after our write
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), POLL_MS);
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  // Hash-based suppression — backup defense for OS re-encoding edge cases.
  suppress(hash) {
    this.suppressedHashes.add(hash);
    setTimeout(() => this.suppressedHashes.delete(hash), 5000);
  }

  async tick() {
    // After a write, give the OS ~2.5s to settle before resuming reads.
    // This is the primary defense against echo loops: the OS may take a moment
    // to re-encode the bytes we wrote (especially PNG on Windows) and we don't
    // want to read that intermediate state and ship it back.
    if (Date.now() < this.pollPausedUntil) return;

    // Try image first (a screenshot is also "text" of nothing in many OSes).
    // Skip entirely if TEXT_ONLY is enabled.
    if (!TEXT_ONLY) {
      const img = await readImage().catch(() => null);
      if (img) {
        const hash = sha256(img);
        if (hash !== this.lastHash && !this.suppressedHashes.has(hash)) {
          this.lastHash = hash;
          this.onChange({ type: 'image', mime: 'image/png', data: img, checksum: hash });
        }
        return;
      }
    }

    let text = '';
    try { text = await clipboardy.read(); } catch { return; }
    if (!text) return;
    const buf = Buffer.from(text, 'utf8');
    const hash = sha256(buf);
    if (hash === this.lastHash || this.suppressedHashes.has(hash)) return;
    this.lastHash = hash;
    const type = isUrlClip(text) ? 'url' : 'text';
    this.onChange({
      type,
      mime: type === 'url' ? 'text/uri-list' : 'text/plain',
      data: buf,
      checksum: hash,
    });
  }

  async write({ type, mime, data }) {
    // In text-only mode, ignore incoming image clips — don't write them to
    // the OS clipboard so they can't pollute later text reads.
    if (TEXT_ONLY && type === 'image') return;

    // Pause polling for 2.5s — primary defense against echo loops.
    // While paused, the OS finishes re-encoding (PNG metadata on Windows,
    // tiff↔png conversions on macOS, etc.) without us reading intermediate state.
    this.pollPausedUntil = Date.now() + 2500;

    const originalHash = sha256(data);
    this.suppress(originalHash);
    this.lastHash = originalHash;

    if (type === 'image') {
      await writeImage(data);
    } else {
      await clipboardy.write(data.toString('utf8'));
    }

    // After write completes, re-read once and store the OS-canonical hash.
    // This is a backup: if the OS settles BEFORE the 2.5s pause expires,
    // suppression by storedHash catches the race.
    try {
      let storedBytes;
      if (type === 'image') {
        storedBytes = await readImage();
      } else {
        const txt = await clipboardy.read();
        storedBytes = Buffer.from(txt || '', 'utf8');
      }
      if (storedBytes && storedBytes.length) {
        const storedHash = sha256(storedBytes);
        if (storedHash !== originalHash) {
          this.suppress(storedHash);
          this.lastHash = storedHash;
        }
      }
    } catch { /* re-read failed; suppression + pause still apply */ }
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── OS-specific image clipboard helpers
async function readImage() {
  if (platform === 'darwin') {
    const tmp = path.join(os.tmpdir(), `clipsync-${crypto.randomUUID()}.png`);
    const script = `
on run argv
  set p to item 1 of argv
  try
    set png to (the clipboard as «class PNGf»)
    set fh to open for access POSIX file p with write permission
    set eof of fh to 0
    write png to fh
    close access fh
    return "ok"
  on error errMsg
    try
      close access POSIX file p
    end try
    return "no"
  end try
end run`;
    try {
      const { stdout } = await exec('osascript', ['-e', script, tmp]);
      if (!stdout.trim().startsWith('ok')) return null;
      const buf = await fs.promises.readFile(tmp);
      await fs.promises.unlink(tmp).catch(() => {});
      return buf.length ? buf : null;
    } catch { return null; }
  }

  if (platform === 'linux') {
    try {
      // Wayland first
      const { stdout, stderr } = await execBuf('wl-paste', ['-t', 'image/png']);
      if (stdout && stdout.length) return stdout;
    } catch {}
    try {
      const { stdout } = await execBuf('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']);
      if (stdout && stdout.length) return stdout;
    } catch {}
    return null;
  }

  if (platform === 'win32') {
    const ps = `
$img = Get-Clipboard -Format Image
if ($img -eq $null) { exit 1 }
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::OpenStandardOutput().Write($ms.ToArray(), 0, $ms.Length)`;
    try {
      const { stdout } = await execBuf('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps]);
      return stdout && stdout.length ? stdout : null;
    } catch { return null; }
  }

  return null;
}

async function writeImage(buf) {
  if (platform === 'darwin') {
    const tmp = path.join(os.tmpdir(), `clipsync-w-${crypto.randomUUID()}.png`);
    await fs.promises.writeFile(tmp, buf);
    const script = `set the clipboard to (read (POSIX file "${tmp}") as «class PNGf»)`;
    try { await exec('osascript', ['-e', script]); }
    finally { await fs.promises.unlink(tmp).catch(() => {}); }
    return;
  }
  if (platform === 'linux') {
    const tmp = path.join(os.tmpdir(), `clipsync-w-${crypto.randomUUID()}.png`);
    await fs.promises.writeFile(tmp, buf);
    try {
      try {
        await new Promise((resolve, reject) => {
          const cp = spawn('wl-copy', ['-t', 'image/png']);
          cp.on('error', reject);
          cp.on('close', (code) => code === 0 ? resolve() : reject(new Error(`wl-copy exit ${code}`)));
          cp.stdin.end(buf);
        });
        return;
      } catch {}
      await exec('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', tmp]);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
    return;
  }
  if (platform === 'win32') {
    const tmp = path.join(os.tmpdir(), `clipsync-w-${crypto.randomUUID()}.png`);
    await fs.promises.writeFile(tmp, buf);
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${tmp.replace(/'/g, "''")}')
[System.Windows.Forms.Clipboard]::SetImage($img)`;
    try {
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    } finally { await fs.promises.unlink(tmp).catch(() => {}); }
  }
}

// execFile that returns binary stdout
function execBuf(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, opts);
    const chunks = [];
    cp.stdout.on('data', (c) => chunks.push(c));
    cp.on('error', reject);
    cp.on('close', (code) => {
      if (code !== 0 && !chunks.length) reject(new Error(`${cmd} exit ${code}`));
      else resolve({ stdout: Buffer.concat(chunks) });
    });
  });
}
