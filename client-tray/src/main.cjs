// Electron entry — boots SyncEngine and renders system tray icon + menu.
const { app, Tray, Menu, nativeImage, shell, dialog, clipboard, BrowserWindow, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const AutoLaunch = require('auto-launch');

// Path to the lockfile so we can clear stale ones during restart
const LOCK_PATH = path.join(os.homedir(), '.config', 'clipsync', 'client', '.lock');

let tray = null;
let engine = null;
let lockMod = null;
let storeMod = null;
let lastStatus = { connected: false, paused: false, peer_count: 0, registered: false };

const ICON_DIR = path.join(__dirname, '..', 'icons');
function iconFor(state) {
  const file = state === 'connected' ? 'connected.png'
             : state === 'paused'    ? 'paused.png'
             : state === 'error'     ? 'error.png'
             : 'disconnected.png';
  return nativeImage.createFromPath(path.join(ICON_DIR, file)).resize({ width: 18, height: 18 });
}

const autoLauncher = new AutoLaunch({ name: 'ClipSync', isHidden: true });

async function loadEngine() {
  // SyncEngine is ESM; use dynamic import from CJS.
  const enginePath = path.join(__dirname, '..', '..', 'client-desktop', 'src', 'engine.js');
  const lockPath   = path.join(__dirname, '..', '..', 'client-desktop', 'src', 'lock.js');
  const storePath  = path.join(__dirname, '..', '..', 'client-desktop', 'src', 'store.js');
  const { SyncEngine } = await import(`file://${enginePath}`);
  lockMod  = await import(`file://${lockPath}`);
  storeMod = await import(`file://${storePath}`);
  return new SyncEngine();
}

function setIcon() {
  if (!tray) return;
  let state = 'disconnected';
  if (!lastStatus.registered) state = 'error';
  else if (lastStatus.paused) state = 'paused';
  else if (lastStatus.connected) state = 'connected';
  tray.setImage(iconFor(state));
  const tip = lastStatus.registered
    ? `ClipSync — ${lastStatus.connected ? 'connected' : 'disconnected'} · ${lastStatus.peer_count} peer(s)${lastStatus.paused ? ' · paused' : ''}`
    : 'ClipSync — not registered';
  tray.setToolTip(tip);
}

function buildMenu() {
  const recent = (lastStatus.recent || []).slice(0, 8).map(r => ({
    label: `${r.direction === 'sent' ? '→' : '←'} ${r.type}${r.preview ? ': ' + r.preview.slice(0, 50) : ` (${r.size}B)`}`,
    click: () => { if (r.preview) clipboard.writeText(r.preview); },
  }));

  return Menu.buildFromTemplate([
    { label: lastStatus.registered
        ? `${lastStatus.connected ? '🟢' : '🔴'} ${lastStatus.connected ? 'Connected' : 'Disconnected'} · ${lastStatus.peer_count} peer(s)`
        : '⚠️  Not registered',
      enabled: false,
    },
    { type: 'separator' },
    ...(recent.length
        ? [{ label: 'Recent clips', submenu: recent }, { type: 'separator' }]
        : []),
    {
      label: lastStatus.paused ? 'Resume sync' : 'Pause sync',
      enabled: lastStatus.registered && lastStatus.connected,
      click: () => { lastStatus.paused ? engine.resume() : engine.pause(); },
    },
    {
      label: 'Open admin dashboard',
      enabled: lastStatus.registered,
      click: () => {
        const url = (lastStatus.hub_url || '').replace(/^wss:/, 'https:').replace(/:(\d+)$/, ':5679') + '/admin';
        if (url) shell.openExternal(url);
      },
    },
    { type: 'separator' },
    {
      label: 'Restart',
      enabled: lastStatus.registered,
      click: () => doRestart({ clearClipboard: false }),
    },
    {
      label: 'Restart + clear clipboard',
      enabled: lastStatus.registered,
      click: () => doRestart({ clearClipboard: true }),
    },
    { type: 'separator' },
    {
      label: 'Auto-start at login',
      type: 'checkbox',
      checked: false,
      click: async (item) => {
        if (item.checked) await autoLauncher.enable();
        else await autoLauncher.disable();
      },
    },
    {
      label: 'Re-register…',
      click: async () => {
        const r = await dialog.showMessageBox({
          type: 'warning',
          message: 'Forget this device and re-register?',
          buttons: ['Cancel', 'Forget'], defaultId: 0, cancelId: 0,
        });
        if (r.response === 1) { engine.forget(); app.quit(); }
      },
    },
    { type: 'separator' },
    { label: 'Quit ClipSync', click: () => app.quit() },
  ]);
}

function refreshTray() {
  setIcon();
  tray.setContextMenu(buildMenu());
}

// One-click restart — stops engine, releases lockfile, optionally clears
// the OS clipboard, then relaunches the whole Electron process clean.
async function doRestart({ clearClipboard = false } = {}) {
  try {
    if (clearClipboard) {
      // Replace whatever's in the clipboard with a tiny string so any
      // stuck image/text from a previous session gets evicted.
      try { clipboard.writeText(''); } catch {}
    }
    try { engine?.stop(); } catch {}
    try { lockMod?.release(); } catch {}
    // Defensive: nuke the lockfile in case a previous instance crashed
    // without releasing it.
    try { fs.unlinkSync(LOCK_PATH); } catch {}

    if (Notification.isSupported()) {
      new Notification({
        title: 'ClipSync',
        body: clearClipboard ? 'Reiniciando y limpiando portapapeles…' : 'Reiniciando…',
        silent: true,
      }).show();
    }

    // Relaunch the app. Brief delay so the notification has time to fire.
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 250);
  } catch (e) {
    dialog.showErrorBox('Restart failed', e.message);
  }
}

app.whenReady().then(async () => {
  // Mac: hide dock icon, app lives in menu bar only
  if (process.platform === 'darwin') app.dock?.hide();

  engine = await loadEngine();

  const lock = lockMod.acquire('tray');
  if (!lock.ok) {
    dialog.showErrorBox(
      'ClipSync already running',
      `Another instance is active (pid ${lock.holder.pid}, mode ${lock.holder.mode}). Close it first or use \`clipsync switch tray\`.`
    );
    app.quit();
    return;
  }

  tray = new Tray(iconFor('disconnected'));
  refreshTray();

  // Auto-launch state on first tick
  autoLauncher.isEnabled().then((on) => {
    const items = tray.contextMenu?.items;
    if (items) {
      const idx = items.findIndex((i) => i.label === 'Auto-start at login');
      if (idx >= 0) items[idx].checked = on;
    }
  }).catch(() => {});

  if (engine.isRegistered()) {
    engine.start().catch((e) => dialog.showErrorBox('ClipSync', e.message));
  } else {
    dialog.showMessageBox({
      type: 'info',
      message: 'ClipSync is not registered yet.',
      detail: 'Run `clipsync register` from a terminal to pair this device with the hub.',
      buttons: ['OK'],
    });
  }

  const sync = () => { lastStatus = { ...lastStatus, ...engine.status() }; refreshTray(); };
  engine.on('connected', sync);
  engine.on('disconnected', sync);
  engine.on('peers', sync);
  engine.on('clip', sync);
  engine.on('status', sync);
  engine.on('cert-mismatch', ({ expected, got }) => {
    dialog.showErrorBox('TLS fingerprint mismatch',
      `Hub cert changed.\nExpected: ${expected}\nGot:      ${got}\n\nNot connecting. Re-register if this is intentional.`);
    sync();
  });
  engine.on('auth-fail', (reason) => {
    if (reason === 'revoked' || reason === 'device_revoked') {
      dialog.showErrorBox('Device revoked', 'The hub admin revoked this device. Re-register to continue.');
      app.quit();
    }
  });

  // Periodic status refresh
  setInterval(sync, 5000);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  try { engine?.stop(); } catch {}
  try { lockMod?.release(); } catch {}
});
