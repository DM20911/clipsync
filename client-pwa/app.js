// ClipSync PWA — connects to hub via WSS, encrypts/decrypts via Web Crypto.

const STATE_KEY = 'clipsync_state_v1';

const $ = (id) => document.getElementById(id);

// ─── State ───────────────────────────────────────────
function loadState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); }
  catch { return {}; }
}
function saveState(s) { localStorage.setItem(STATE_KEY, JSON.stringify(s)); }
function clearState() { localStorage.removeItem(STATE_KEY); }

let state = loadState();
let ws = null;
let connected = false;
let latest = null;
let history = [];
let reconnectMs = 1000;

// ─── UI helpers ──────────────────────────────────────
function setStatus(text, ok = true) {
  const dotColor = ok ? 'text-emerald-400' : 'text-rose-400';
  $('status').innerHTML =
    `<span class="${dotColor} pulse-dot inline-block">●</span> ${text}`;
}

function showRegister() {
  $('register').classList.remove('hidden');
  $('compose').classList.add('hidden');
  $('latest').classList.add('hidden');
  $('history-sec').classList.add('hidden');
}

function showMain() {
  $('register').classList.add('hidden');
  $('compose').classList.remove('hidden');
  $('history-sec').classList.remove('hidden');
}

function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B','KB','MB','GB']; let i=0; let n=b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

// ─── Crypto (matches hub/desktop AES-256-GCM + PBKDF2) ──
const PBKDF2_ITER = 100_000;

async function deriveKey(token, salt) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(token), { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptBuf(buf, token) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveKey(token, salt);
  const enc  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf);
  // enc already includes the 16-byte tag at the end. Layout: salt|iv|ct+tag
  // To match the Node.js layout (salt|iv|tag|ct), we have to split tag and ct:
  const encArr = new Uint8Array(enc);
  const tag = encArr.subarray(encArr.length - 16);
  const ct  = encArr.subarray(0, encArr.length - 16);
  const out = new Uint8Array(salt.length + iv.length + tag.length + ct.length);
  out.set(salt, 0);
  out.set(iv,   salt.length);
  out.set(tag,  salt.length + iv.length);
  out.set(ct,   salt.length + iv.length + tag.length);
  let binary = '';
  for (let i = 0; i < out.length; i += 8192) {
    binary += String.fromCharCode(...out.subarray(i, i + 8192));
  }
  return btoa(binary);
}

async function decryptB64(b64, token) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const salt = raw.subarray(0, 16);
  const iv   = raw.subarray(16, 28);
  const tag  = raw.subarray(28, 44);
  const ct   = raw.subarray(44);
  // Web Crypto expects ct+tag concatenated:
  const ctTag = new Uint8Array(ct.length + tag.length);
  ctTag.set(ct, 0); ctTag.set(tag, ct.length);
  const key = await deriveKey(token, salt);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctTag)
  );
}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2,'0')).join('');
}

// ─── Registration ────────────────────────────────────
async function registerDevice() {
  const url  = $('hub-url').value.trim();
  const pin  = $('pin-input').value.trim();
  const name = $('device-name').value.trim() || (navigator.userAgent.includes('iPhone') ? 'iPhone' :
                navigator.userAgent.includes('Android') ? 'Android' : 'Browser');

  if (!url || !pin) {
    $('register-msg').textContent = 'hub URL and PIN are required';
    return;
  }
  // Convert wss:// to https:// for HTTP register endpoint
  const httpsBase = url.replace(/^wss:/, 'https:').replace(/:\d+$/, ':' + (state.http_port || 5679));

  try {
    const r = await fetch(httpsBase + '/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pin,
        name,
        os: navigator.platform || 'browser',
        fingerprint: null,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      $('register-msg').textContent = 'failed: ' + (j.error || r.status);
      return;
    }
    const reg = await r.json();
    state = {
      hub_url: url,
      http_base: httpsBase,
      device_id: reg.id,
      token: reg.token,
      jwt: reg.jwt,
    };
    saveState(state);
    showMain();
    connect();
  } catch (e) {
    $('register-msg').textContent = 'error: ' + e.message;
  }
}

// ─── WebSocket connection ────────────────────────────
function connect() {
  if (!state.jwt) return showRegister();
  setStatus('connecting…');

  ws = new WebSocket(state.hub_url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ op: 'auth', token: state.jwt }));
  };

  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }

    if (m.op === 'auth_ok') {
      connected = true;
      reconnectMs = 1000;
      setStatus(`connected · ${(m.devices || []).length} peer${(m.devices||[]).length === 1 ? '' : 's'}`);
      ws.send(JSON.stringify({ op: 'history_request', limit: 20 }));
      return;
    }
    if (m.op === 'auth_fail') {
      setStatus('auth failed: ' + m.reason, false);
      if (m.reason === 'revoked' || m.reason === 'device_revoked') {
        clearState(); state = {}; showRegister();
      }
      return;
    }
    if (m.op === 'broadcast' && m.clip) {
      if (m.clip.source_device === state.device_id) return;
      await ingestClip(m.clip);
    }
    if (m.op === 'history' && m.items) {
      for (const c of m.items.reverse()) await ingestClip(c, /*silent=*/true);
    }
    if (m.op === 'device_joined' || m.op === 'device_left') {
      // Could refresh peer count here.
    }
  };

  ws.onclose = () => {
    connected = false;
    setStatus('disconnected — reconnecting…', false);
    setTimeout(() => { reconnectMs = Math.min(reconnectMs*2, 30000); connect(); }, reconnectMs);
  };
  ws.onerror = () => { /* close handler reconnects */ };
}

async function ingestClip(c, silent = false) {
  try {
    const buf = await decryptB64(c.payload_b64, state.token);
    const item = {
      id: c.id, type: c.type, mime: c.mime, size: c.size,
      timestamp: c.timestamp, source: c.source_device,
      buf,
      text: (c.type === 'text' || c.type === 'url') ? new TextDecoder().decode(buf) : null,
    };
    history.unshift(item);
    if (history.length > 30) history.pop();
    latest = item;
    renderLatest();
    renderHistory();
    if (!silent) flash();
  } catch (e) {
    console.warn('ingest failed:', e.message);
  }
}

function flash() {
  document.body.style.boxShadow = 'inset 0 0 0 2px rgba(244,162,45,.55)';
  setTimeout(() => document.body.style.boxShadow = '', 350);
}

function renderLatest() {
  if (!latest) return;
  $('latest').classList.remove('hidden');
  const c = $('latest-content');
  c.innerHTML = '';
  if (latest.type === 'image') {
    const blob = new Blob([latest.buf], { type: latest.mime || 'image/png' });
    const img = document.createElement('img');
    img.src = URL.createObjectURL(blob);
    img.className = 'max-w-full rounded';
    c.appendChild(img);
  } else {
    const pre = document.createElement('div');
    pre.className = 'whitespace-pre-wrap break-all text-sm font-mono text-slate-300';
    pre.textContent = latest.text || '';
    c.appendChild(pre);
  }
  const meta = document.createElement('div');
  meta.className = 'mt-2 mono text-xs text-slate-500';
  meta.textContent = `${latest.type} · ${fmtSize(latest.size)} · ${new Date(latest.timestamp).toLocaleTimeString()}`;
  c.appendChild(meta);
}

function renderHistory() {
  $('history-sec').classList.remove('hidden');
  const ul = $('history-list');
  ul.innerHTML = '';
  for (const it of history.slice(0, 20)) {
    const li = document.createElement('li');
    li.className = 'bg-slate-900/50 border border-slate-800 rounded p-2 cursor-pointer hover:border-amber-500/40';
    li.innerHTML = `
      <div class="flex justify-between items-center">
        <span class="mono text-xs uppercase text-amber-400">${it.type}</span>
        <span class="mono text-xs text-slate-500">${new Date(it.timestamp).toLocaleTimeString()}</span>
      </div>
      <div class="mt-1 text-sm truncate text-slate-300">${
        it.type === 'image' ? `image · ${fmtSize(it.size)}`
                            : (it.text || '').slice(0, 80).replace(/</g, '&lt;')
      }</div>
    `;
    li.onclick = async () => { await copyItem(it); flash(); };
    ul.appendChild(li);
  }
}

async function copyItem(item) {
  try {
    if (item.type === 'image' && navigator.clipboard?.write) {
      const blob = new Blob([item.buf], { type: item.mime || 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } else {
      await navigator.clipboard.writeText(item.text || '');
    }
  } catch (e) {
    alert('clipboard write failed: ' + e.message + '\n(iOS may require manual copy)');
  }
}

// ─── Compose / send ──────────────────────────────────
async function sendText() {
  const txt = $('compose-text').value;
  if (!txt) return;
  const buf = new TextEncoder().encode(txt);
  const checksum = await sha256Hex(buf);
  const payload_b64 = await encryptBuf(buf, state.token);
  const isUrl = /^https?:\/\//.test(txt.trim()) && txt.trim().length < 2048;
  ws.send(JSON.stringify({
    op: 'push',
    clip: {
      id: crypto.randomUUID(),
      type: isUrl ? 'url' : 'text',
      mime: isUrl ? 'text/uri-list' : 'text/plain',
      size: buf.byteLength,
      timestamp: Date.now(),
      checksum,
      payload_b64,
    },
  }));
  $('compose-text').value = '';
  flash();
}

async function pasteFromClipboard() {
  try {
    const txt = await navigator.clipboard.readText();
    if (txt) $('compose-text').value = txt;
  } catch (e) {
    alert('clipboard read failed: ' + e.message);
  }
}

async function copyLatest() {
  if (!latest) return;
  await copyItem(latest);
  flash();
}

// ─── Wire up ─────────────────────────────────────────
$('btn-register').addEventListener('click', registerDevice);
$('btn-send').addEventListener('click', sendText);
$('btn-paste').addEventListener('click', pasteFromClipboard);
$('btn-copy').addEventListener('click', copyLatest);
$('btn-config').addEventListener('click', () => {
  if (confirm('Forget this device and re-register?')) { clearState(); location.reload(); }
});

// ─── Share-target intake ─────────────────────────────
const params = new URLSearchParams(location.search);
if (params.has('share')) {
  const t = params.get('text') || params.get('url') || params.get('title') || '';
  if (t) $('compose-text').value = t;
}

// ─── Auto-fill hub URL based on current host ────────
const guessedUrl = `wss://${location.hostname}:5678`;
if (!state.jwt) $('hub-url').value = guessedUrl;

// ─── Boot ────────────────────────────────────────────
if (state.jwt) {
  showMain();
  connect();
} else {
  showRegister();
  setStatus('not registered', false);
}
