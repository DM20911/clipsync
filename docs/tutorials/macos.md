# ClipSync — macOS

## Requisitos

- macOS 12 (Monterey) o superior
- Node.js 18+ (`brew install node`)
- Permiso de **Accesibilidad** para tu terminal/Node (Settings → Privacy & Security → Accessibility) — necesario para leer/escribir clipboard

## Instalación

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync
bash scripts/install-mac.sh client
```

El instalador pregunta:

```
Cómo quieres correr ClipSync?
  1) Tray app (recomendado — ícono en menu bar)
  2) Daemon en background (sin UI)
Modo [1]:
```

- **Tray** instala el motor + Electron (~80 MB primera vez), arranca con ícono en la barra de menú. Activa "Auto-start at login" desde el menú del tray.
- **Daemon** crea un LaunchAgent en `~/Library/LaunchAgents/com.clipsync.daemon.plist`, sin UI.

> El instalador no requiere `sudo`: ambos modos corren con tu usuario. Si quieres correr el daemon como servicio del sistema (`/Library/LaunchDaemons`), eso sí pediría sudo.

### Cambiar de modo después

```bash
bin/clipsync switch tray     # de daemon a tray
bin/clipsync switch daemon   # de tray a daemon
bin/clipsync status          # ver modo activo
```

No hay que re-registrar — el `state.json` se mantiene.

## Registro inicial

1. En el equipo del hub, abre `https://<ip-hub>:5679/admin` y haz login con el token de admin.
2. Click en "Generar PIN" o muestra el QR.
3. En tu Mac:
   ```bash
   cd /path/to/clipsync/client-desktop
   node src/register.js
   ```
4. Introduce el PIN cuando se solicite. El cliente:
   - Genera tu keypair X25519 (privada nunca sale del disco)
   - Envía la pública al hub
   - Recibe y guarda el JWT

## Uso diario

ClipSync corre en background. Copia algo en cualquier dispositivo y aparece en los demás. Logs:

```bash
tail -f ~/Library/Logs/clipsync-client.log
```

## Auto-start

**Tray mode**: en el menú del tray, marca "Auto-start at login" (gestionado por `auto-launch` npm).

**Daemon mode**: ya configurado por el instalador. Para verificar:

```bash
launchctl list | grep clipsync
```

Para detener temporalmente:

```bash
bin/clipsync stop                                              # cualquiera
launchctl unload ~/Library/LaunchAgents/com.clipsync.daemon.plist   # solo daemon
```

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| `cert_mismatch` en logs | Certificado del hub cambió | Borra `hub_cert_fp` de `~/.config/clipsync/client/state.json` y reinicia |
| `auth failed: device_revoked` | Admin te revocó | `node src/register.js` con un nuevo PIN |
| No copia imágenes | Falta permiso Accesibilidad | Settings → Privacy & Security → Accessibility |
| Daemon no arranca | Node fuera de PATH | Edita el plist y pon ruta absoluta a `node` |
| `rate_limited` en logs | Estás generando clips muy rápido | Es un límite normal: 5 PUSH/s por dispositivo |

---

## ──── Notas técnicas ────

### Arquitectura del cliente

```
client-desktop/src/
├── engine.js        ← SyncEngine (núcleo compartido tray ↔ daemon)
├── main.js          ← entry daemon (CLI thin wrapper)
├── ws-client.js     ← WSS + TOFU cert pinning + jittered reconnect
├── clipboard.js     ← clipboardy (texto) + osascript (imagen)
├── store.js         ← state.json en ~/.config/clipsync/client
├── lock.js          ← lockfile mutex daemon ↔ tray
├── discovery.js     ← mDNS para encontrar el hub
└── register.js      ← registro inicial vía PIN (--qr opcional)

client-tray/         ← Electron menu bar app
├── src/main.cjs     ← Tray icon + menu, importa engine.js
└── icons/           ← PNG por estado (connected/disconnected/paused/error)

bin/clipsync         ← CLI unificado (status, switch, register, logs, stop)

shared/
├── crypto-node.js   ← X25519, HKDF, AES-256-GCM, randomPin
└── protocol.js      ← OP codes y validadores
```

### Variables de entorno

| Variable | Default | Función |
|----------|---------|---------|
| `CLIPSYNC_CLIENT_DIR` | `~/.config/clipsync/client` | Directorio de estado |
| `CLIPSYNC_POLL_MS` | `300` | Intervalo de polling del clipboard |

### Logs y debugging

```bash
tail -f ~/Library/Logs/clipsync-client.log
tail -f ~/Library/Logs/clipsync-client.err

# Detener el agente y ejecutar manualmente para ver todo el output
launchctl unload ~/Library/LaunchAgents/com.clipsync.client.plist
node /path/to/clipsync/client-desktop/src/main.js
```

### Estado local (`state.json`)

```json
{
  "hub_url": "wss://192.168.1.10:5678",
  "hub_cert_fp": "AB:CD:...",
  "device_id": "...",
  "jwt": "...",
  "x25519_private_b64": "...",
  "x25519_public_b64": "..."
}
```

Permisos `0o600`. La clave X25519 privada nunca se transmite; solo se usa localmente para derivar shared keys vía ECDH.

### Desinstalar

```bash
bin/clipsync stop
launchctl unload ~/Library/LaunchAgents/com.clipsync.daemon.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.clipsync.daemon.plist
rm -f ~/Library/LaunchAgents/com.clipsync.client.plist     # legacy
rm -rf ~/.config/clipsync
rm -f ~/Library/Logs/clipsync-*.log ~/Library/Logs/clipsync-*.err
```

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
