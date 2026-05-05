# ClipSync en Linux — guía paso a paso

> **Antes de empezar:** lee el [README principal](./README.md). Esta guía asume que ya entiendes qué es ClipSync.

---

## ¿Qué vas a lograr?

Que cuando hagas `Ctrl+C` en tu Linux, ese contenido aparezca al hacer `Cmd+V` (o `Ctrl+V`) en tus otros dispositivos. Sin abrir ninguna página, sin enviar nada manualmente.

---

## Requisitos previos

- [ ] Distro con **systemd** (Ubuntu, Debian, Fedora, Arch, Mint, etc.)
- [ ] **Node.js 18+** (`node -v` para verificar). Si no:
  ```bash
  # Ubuntu/Debian
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install nodejs
  ```
- [ ] Para imágenes/archivos: `xclip` (X11) o `wl-clipboard` (Wayland). El instalador los baja solo si faltan.
- [ ] **El hub corriendo** en alguna máquina de tu red local
- [ ] **Token de admin** del hub
- [ ] **IP del hub** en tu red

---

## Paso 1 — Clonar e instalar

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync
bash scripts/install-linux.sh client
```

El instalador:
1. Instala xclip / wl-clipboard si faltan (pide sudo)
2. Instala dependencias Node
3. Te pregunta el modo:
   ```
   Cómo quieres correr ClipSync?
     1) Tray app (recomendado)
     2) Daemon en background (systemd)
   Modo [1]:
   ```
   → Si tienes escritorio gráfico: **1 (Tray)**.
   Si es un servidor headless: **2 (Daemon)**.
4. Pregunta si registrar ahora → **N** (lo haremos desde el dashboard, más fácil).

---

## Paso 2 — Conseguir un PIN desde el dashboard

Abre el browser (en este Linux o cualquier otro dispositivo de la red):
```
https://<IP-del-hub>:5679/admin
```

Acepta el cert self-signed. Login con el token del admin.

Click **"+ register new device"**. Aparece un QR + un PIN + un comando completo.

**Copia el comando completo** (lo más fácil), algo como:
```bash
node client-desktop/src/register.js --qr '{"v":2,"hub":"wss://192.168.x.x:5678","pin":"690119","fp":"04:72:..."}'
```

---

## Paso 3 — Registrar este Linux

En la terminal donde está el repo:
```bash
cd ~/clipsync
node client-desktop/src/register.js --qr '<el-comando-que-copiaste>'
```

Salida:
```
ClipSync registration

Hub: wss://192.168.100.28:5678
Cert FP: 04:72:C5:5F:BA:A3:B5:F8:7D:CF:BC...
Device name [tu-hostname]:
[Enter para aceptar]

OK — device a3f1b2c4 registered.
```

✅ **Linux registrado.**

---

## Paso 4 — Arrancar el cliente

```bash
node bin/clipsync switch tray
```

Si elegiste tray, aparece un ícono **clipboard** en la system tray (esquina inferior derecha en GNOME, KDE, XFCE, Cinnamon).

> **Nota GNOME 45+:** las nuevas versiones de GNOME esconden los íconos de system tray. Instala la extensión **AppIndicator and KStatusNotifierItem Support** desde [extensions.gnome.org](https://extensions.gnome.org/extension/615/appindicator-support/) para verlos.

Click en el ícono → menú con estado, peers, recent clips, pause/resume.

---

## Cómo se usa diariamente

```
Linux:    Ctrl+C  (sobre cualquier cosa)
            ↓ ~100 ms
Mac:      Cmd+V   → ahí está
Windows:  Ctrl+V  → ahí está
iPhone:   ↑ → "Pegar" → ahí está
```

**Nunca abres el dashboard** en el día a día. La sincronización es invisible.

### Pausar temporalmente
Si vas a copiar algo sensible (contraseña, etc.):
- Click ícono → "Pause sync"
- Cuando termines: → "Resume sync"

---

## Auto-start al iniciar sesión

**Tray mode**: marca "Auto-start at login" en el menú del tray.

**Daemon mode**: el instalador ya configura systemd. Para verificar:
```bash
systemctl --user status clipsync-client
journalctl --user -u clipsync-client -f    # ver logs en vivo
```

Para que corra incluso sin sesión activa (servidor):
```bash
loginctl enable-linger $USER
```

---

## Solución de problemas

| Síntoma | Causa | Solución |
|---------|-------|----------|
| Wayland: imágenes no se copian | `wl-clipboard` no instalado | `sudo apt install wl-clipboard` |
| Daemon: "Failed to connect to bus" | DBUS sin sesión | Activa `loginctl enable-linger $USER` |
| `cert_mismatch` en logs | Cert del hub cambió | Edita `~/.config/clipsync/client/state.json`, borra línea `hub_cert_fp`, reinicia |
| GNOME 45+: ícono no se ve | Extensión faltante | Instala AppIndicator Support |
| `auth failed: device_revoked` | Admin te revocó | Re-registra con un PIN nuevo |

### Re-registrar desde cero

```bash
node bin/clipsync stop
rm -rf ~/.config/clipsync/client
# Genera nuevo PIN en dashboard, después:
node client-desktop/src/register.js --qr '<...>'
node bin/clipsync switch tray
```

---

## Cambiar entre tray y daemon

```bash
node bin/clipsync switch daemon    # sin UI, corre como servicio
node bin/clipsync switch tray      # con ícono
node bin/clipsync status           # qué modo está activo
node bin/clipsync stop             # detener todo
node bin/clipsync logs             # tail logs
```

---

## Desinstalar

```bash
node bin/clipsync stop
systemctl --user disable --now clipsync-client.service 2>/dev/null
rm -f ~/.config/systemd/user/clipsync-client.service
systemctl --user daemon-reload
rm -rf ~/.config/clipsync
rm -rf ~/clipsync
```

---

## ──── Referencia técnica ────

### Detección Wayland vs X11

`clipboard.js` detecta automáticamente:
- Wayland: usa `wl-paste` y `wl-copy`
- X11: fallback a `xclip`

Para imágenes el patrón es el mismo. Para texto usa `clipboardy` (npm).

### Logs
```bash
journalctl --user -u clipsync-client -f
# o
tail -f ~/.config/clipsync/client/daemon.log
```

### Variables

| Variable | Default |
|----------|---------|
| `CLIPSYNC_CLIENT_DIR` | `~/.config/clipsync/client` |
| `DISPLAY` | heredado de la sesión |
| `WAYLAND_DISPLAY` | heredado |

### Estado local
`~/.config/clipsync/client/state.json` con permisos `0o600`. Contiene JWT, claves X25519, hub URL y cert fingerprint pinned.

---

Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
