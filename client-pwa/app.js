// ClipSync PWA — envelope encryption (X25519 + HKDF + AES-GCM) with non-extractable keys.

const STATE_KEY = 'clipsync_state_v2';
const DB_NAME = 'clipsync';
const DB_STORE = 'keys';
const $ = (id) => document.getElementById(id);

let state = {};
let ws = null;
let connected = false;
let latest = null;
let history = [];
let reconnectMs = 1000;
let myKeyPair = null;     // { privateKey: CryptoKey, publicKeyB64 }
let peers = new Map();    // deviceId -> CryptoKey (x25519 public)

function loadState() { try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch { return {}; } }
function saveState(s) { localStorage.setItem(STATE_KEY, JSON.stringify(s)); }
function clearState() { localStorage.removeItem(STATE_KEY); }

// ─── IndexedDB for non-extractable keys ───
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, val) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const r = tx.objectStore(DB_STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}
async function idbClear() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

// ─── UI helpers ───
function setStatus(text, ok = true) {
  const c = ok ? 'text-emerald-400' : 'text-rose-400';
  $('status').innerHTML = `<span class="${c} pulse-dot inline-block">●</span> ${text}`;
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

// ─── Crypto ───
async function ensureKeypair() {
  let priv = await idbGet('x25519_private');
  let pubB64 = (await idbGet('x25519_public_b64')) || null;
  if (!priv) {
    const kp = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    priv = kp.privateKey;
    const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
    pubB64 = bytesToB64(new Uint8Array(pubRaw));
    await idbPut('x25519_private', priv);
    await idbPut('x25519_public_b64', pubB64);
  }
  myKeyPair = { privateKey: priv, publicKeyB64: pubB64 };
}

async function importPublicKey(b64) {
  const raw = b64ToBytes(b64);
  return crypto.subtle.importKey('raw', raw, { name: 'X25519' }, false, []);
}

async function deriveAesKey(myPriv, peerPub, salt, info) {
  const shared = await crypto.subtle.deriveBits(
    { name: 'X25519', public: peerPub }, myPriv, 256
  );
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// Layout: [iv:12][tag:16][ct]
async function aesGcmEncrypt(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
  const tag = ctTag.subarray(ctTag.length - 16);
  const ct  = ctTag.subarray(0, ctTag.length - 16);
  const out = new Uint8Array(iv.length + tag.length + ct.length);
  out.set(iv, 0); out.set(tag, iv.length); out.set(ct, iv.length + tag.length);
  return out;
}
async function aesGcmDecrypt(key, buf) {
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const ctTag = new Uint8Array(ct.length + tag.length);
  ctTag.set(ct, 0); ctTag.set(tag, ct.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctTag));
}

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return btoa(s);
}
function b64ToBytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2,'0')).join('');
}

// ─── Registration ───
async function registerDevice() {
  await ensureKeypair();
  const url  = $('hub-url').value.trim();
  const pin  = $('pin-input').value.trim();
  const name = $('device-name').value.trim() || 'Browser';
  if (!url || !pin) { $('register-msg').textContent = 'hub URL and PIN required'; return; }

  const httpsBase = url.replace(/^wss:/, 'https:').replace(/:(\d+)$/, ':5679');

  try {
    const r = await fetch(httpsBase + '/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pin, name, os: navigator.platform || 'browser', fingerprint: null,
        public_key: myKeyPair.publicKeyB64,
      }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      $('register-msg').textContent = 'failed: ' + (j.error || r.status);
      return;
    }
    const reg = await r.json();
    state = { hub_url: url, http_base: httpsBase, device_id: reg.id, jwt: reg.jwt };
    saveState(state);
    showMain(); connect();
  } catch (e) { $('register-msg').textContent = 'error: ' + e.message; }
}

// ─── WS ───
function connect() {
  if (!state.jwt) return showRegister();
  setStatus('connecting…');
  ws = new WebSocket(state.hub_url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => ws.send(JSON.stringify({ op: 'auth', token: state.jwt }));
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.op === 'auth_ok') {
      connected = true; reconnectMs = 1000;
      setStatus(`connected · ${(m.peers || []).length} peer(s)`);
      peers.clear();
      for (const p of (m.peers || [])) peers.set(p.id, await importPublicKey(p.public_key));
      ws.send(JSON.stringify({ op: 'history_request', limit: 20 }));
      return;
    }
    if (m.op === 'peers') {
      peers.clear();
      for (const p of (m.peers || [])) {
        if (p.id !== state.device_id) peers.set(p.id, await importPublicKey(p.public_key));
      }
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
    if (m.op === 'history' && m.items) for (const c of m.items.reverse()) await ingestClip(c, true);
  };
  ws.onclose = () => {
    connected = false;
    setStatus('disconnected — reconnecting…', false);
    setTimeout(() => { reconnectMs = Math.min(reconnectMs * 2, 30000); connect(); }, reconnectMs);
  };
  ws.onerror = () => {};
}

async function ingestClip(c, silent = false) {
  try {
    const senderPub = await importPublicKey(c.sender_ephemeral_public);
    const wrapSalt  = b64ToBytes(c.wrap_salt);
    const wrapKey   = await deriveAesKey(myKeyPair.privateKey, senderPub, wrapSalt, 'clipsync-v1');
    const contentKeyBytes = await aesGcmDecrypt(wrapKey, b64ToBytes(c.wrapped_key));
    const contentKey = await crypto.subtle.importKey('raw', contentKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const buf = await aesGcmDecrypt(contentKey, b64ToBytes(c.encrypted_payload));
    const item = {
      id: c.id, type: c.type, mime: c.mime, size: c.size,
      timestamp: c.timestamp, source: c.source_device, buf,
      text: (c.type === 'text' || c.type === 'url') ? new TextDecoder().decode(buf) : null,
    };
    history.unshift(item);
    if (history.length > 30) history.pop();
    latest = item;
    renderLatest(); renderHistory();
    if (!silent) flash();
  } catch (e) { console.warn('ingest failed:', e.message); }
}

function flash() {
  document.body.style.boxShadow = 'inset 0 0 0 2px rgba(244,162,45,.55)';
  setTimeout(() => document.body.style.boxShadow = '', 350);
}
function renderLatest() {
  if (!latest) return;
  $('latest').classList.remove('hidden');
  const c = $('latest-content'); c.innerHTML = '';
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
  const ul = $('history-list'); ul.innerHTML = '';
  for (const it of history.slice(0, 20)) {
    const li = document.createElement('li');
    li.className = 'bg-slate-900/50 border border-slate-800 rounded p-2 cursor-pointer hover:border-amber-500/40';
    const head = document.createElement('div');
    head.className = 'flex justify-between items-center';
    const typeSpan = document.createElement('span');
    typeSpan.className = 'mono text-xs uppercase text-amber-400';
    typeSpan.textContent = it.type;
    const tsSpan = document.createElement('span');
    tsSpan.className = 'mono text-xs text-slate-500';
    tsSpan.textContent = new Date(it.timestamp).toLocaleTimeString();
    head.appendChild(typeSpan); head.appendChild(tsSpan);
    const body = document.createElement('div');
    body.className = 'mt-1 text-sm truncate text-slate-300';
    body.textContent = it.type === 'image'
      ? `image · ${fmtSize(it.size)}`
      : (it.text || '').slice(0, 80);
    li.appendChild(head); li.appendChild(body);
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
  } catch (e) { alert('clipboard write failed: ' + e.message + '\n(iOS may require manual copy)'); }
}

async function sendText() {
  const txt = $('compose-text').value;
  if (!txt) return;
  if (peers.size === 0) { alert('no peers connected'); return; }
  const buf = new TextEncoder().encode(txt);
  const checksum = await sha256Hex(buf);

  const contentKeyRaw = crypto.getRandomValues(new Uint8Array(32));
  const contentKey = await crypto.subtle.importKey('raw', contentKeyRaw, { name: 'AES-GCM' }, false, ['encrypt']);
  const encryptedPayload = await aesGcmEncrypt(contentKey, buf);

  const eph = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const wrapSalt = crypto.getRandomValues(new Uint8Array(16));
  const wrappedKeys = {};
  for (const [pid, pub] of peers) {
    const wk = await deriveAesKey(eph.privateKey, pub, wrapSalt, 'clipsync-v1');
    const wrapped = await aesGcmEncrypt(wk, contentKeyRaw);
    wrappedKeys[pid] = bytesToB64(wrapped);
  }

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
      encrypted_payload: bytesToB64(encryptedPayload),
      sender_ephemeral_public: bytesToB64(ephPubRaw),
      wrap_salt: bytesToB64(wrapSalt),
      wrapped_keys: wrappedKeys,
    },
  }));
  $('compose-text').value = '';
  flash();
}

async function pasteFromClipboard() {
  try { const txt = await navigator.clipboard.readText(); if (txt) $('compose-text').value = txt; }
  catch (e) { alert('clipboard read failed: ' + e.message); }
}
async function copyLatest() { if (!latest) return; await copyItem(latest); flash(); }

// ─── Wire up ───
$('btn-register').addEventListener('click', registerDevice);
$('btn-send').addEventListener('click', sendText);
$('btn-paste').addEventListener('click', pasteFromClipboard);
$('btn-copy').addEventListener('click', copyLatest);
$('btn-config').addEventListener('click', async () => {
  if (confirm('Forget this device and re-register?')) {
    clearState(); await idbClear(); location.reload();
  }
});

const params = new URLSearchParams(location.search);
if (params.has('share')) {
  const t = params.get('text') || params.get('url') || params.get('title') || '';
  if (t) $('compose-text').value = t;
}

state = loadState();
const guessedUrl = `wss://${location.hostname}:5678`;
if (!state.jwt) $('hub-url').value = guessedUrl;

(async () => {
  await ensureKeypair();
  if (state.jwt) { showMain(); connect(); }
  else { showRegister(); setStatus('not registered', false); }
})();
