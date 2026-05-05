# ClipSync — Linux

## Requisitos

- Distro con systemd (Ubuntu, Fedora, Arch, Debian, etc.)
- Node.js 18+
- Para imágenes: `xclip` (X11) o `wl-clipboard` (Wayland)

```bash
# Ubuntu/Debian
sudo apt install -y xclip wl-clipboard

# Fedora
sudo dnf install -y xclip wl-clipboard

# Arch
sudo pacman -S --noconfirm xclip wl-clipboard
```

## Instalación

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync
bash scripts/install-linux.sh client
```

El instalador pregunta:

```
Cómo quieres correr ClipSync?
  1) Tray app (recomendado)
  2) Daemon en background (systemd)
Modo [1]:
```

- **Tray** (Electron + StatusNotifier/AppIndicator): ícono en system tray. Auto-start vía `auto-launch` npm.
- **Daemon**: systemd user unit en `~/.config/systemd/user/clipsync-client.service`.

> En GNOME 45+ puede que necesites una extensión como AppIndicator Support para ver el ícono del tray. KDE / XFCE / Cinnamon lo soportan nativo.

### Cambiar de modo después

```bash
bin/clipsync switch tray
bin/clipsync switch daemon
bin/clipsync status
```

## Registro inicial

```bash
cd /path/to/clipsync/client-desktop
node src/register.js
# introduce el PIN del dashboard
systemctl --user start clipsync-client
```

## Uso diario

Sincronización transparente. Logs:

```bash
journalctl --user -u clipsync-client -f
```

## Auto-start

**Tray mode**: marca "Auto-start at login" en el menú del tray.

**Daemon mode**:
```bash
systemctl --user enable clipsync-client       # ya hecho por el instalador
loginctl enable-linger $USER                  # opcional: corre incluso sin sesión activa
```

Para detener cualquier modo:
```bash
bin/clipsync stop                             # mata el modo activo
systemctl --user disable --now clipsync-client    # desinstalar el daemon
```

## Solución de problemas

| Síntoma | Causa | Solución |
|---------|-------|----------|
| Wayland no copia imagen | `wl-clipboard` no instalado | `sudo apt install wl-clipboard` |
| Servicio no arranca con `Failed to connect to bus` | Falta DBUS_SESSION_BUS_ADDRESS | Usa `--user` mode con sesión activa, o `loginctl enable-linger` |
| `cert_mismatch` | Cert del hub cambió | Borra `hub_cert_fp` en `state.json` |
| No detecta cambios en clipboard | X11 sin DISPLAY en unit | Edita unit: `Environment=DISPLAY=:0` |

---

## ──── Notas técnicas ────

### Arquitectura

Misma que macOS, con detección automática Wayland-first → X11 fallback en `clipboard.js`. El polling es de 300ms (configurable).

### Variables

| Variable | Default | Función |
|----------|---------|---------|
| `CLIPSYNC_CLIENT_DIR` | `~/.config/clipsync/client` | Directorio de estado |
| `DISPLAY` | (heredado de la sesión) | X server display |
| `WAYLAND_DISPLAY` | (heredado) | Wayland display |

### Logs

```bash
journalctl --user -u clipsync-client -f --since "1 hour ago"
journalctl --user -u clipsync-client -p err   # solo errores
```

### Estado local

`~/.config/clipsync/client/state.json` con permisos `0o600`. Mismo formato que macOS:

```json
{
  "hub_url": "...", "hub_cert_fp": "...",
  "device_id": "...", "jwt": "...",
  "x25519_private_b64": "...", "x25519_public_b64": "..."
}
```

### Desinstalar

```bash
systemctl --user disable --now clipsync-client
rm ~/.config/systemd/user/clipsync-client.service
systemctl --user daemon-reload
rm -rf ~/.config/clipsync
```

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
