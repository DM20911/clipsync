# ClipSync — Guías por dispositivo

Sincroniza el portapapeles entre tus dispositivos en la red local. Sin nube, sin servidores externos. Cifrado de extremo a extremo con clave por dispositivo (X25519 + AES-256-GCM).

## Cómo levantar el hub

El hub es un servidor Node.js que corre en cualquier equipo de la red local (idealmente uno siempre encendido — Mac, NAS, servidor casero, Raspberry Pi).

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync/hub
npm install
npm start
```

Al primer arranque, el hub muestra en consola un **token de admin** (solo una vez):

```
[clipsync] Admin token (save — shown once):
[clipsync]   AbCd1234EfGh5678IjKl9012MnOp3456...
```

Guárdalo. Lo necesitarás para entrar al dashboard en `https://<ip-hub>:5679/admin`.

### Modos de admin auth

| Modo | `CLIPSYNC_ADMIN_MODE` | Cómo se autentica |
|------|----------------------|-------------------|
| Token (default) | `token` | Token aleatorio mostrado en consola la primera vez |
| Password | `password` | Define `CLIPSYNC_ADMIN_PASSWORD` en env, login con esa contraseña |
| Primer dispositivo | `first-device` | El primero en registrarse se convierte en admin (Bearer JWT) |

**Ejemplo password mode:**

```bash
CLIPSYNC_ADMIN_MODE=password \
CLIPSYNC_ADMIN_PASSWORD='mi-clave-segura' \
npm start
```

**Ejemplo first-device mode:**

```bash
CLIPSYNC_ADMIN_MODE=first-device npm start
```

## Diagrama del sistema

```
┌──────────────┐                ┌─────────────┐
│  macOS       │ ◄── WSS ──►    │             │
└──────────────┘                │             │
┌──────────────┐                │     HUB     │
│  Linux       │ ◄── WSS ──►    │  (Node.js)  │
└──────────────┘                │  + SQLite   │
┌──────────────┐                │  + mDNS     │
│  Windows     │ ◄── WSS ──►    │             │
└──────────────┘                │             │
┌──────────────┐                │             │
│  PWA/móvil   │ ◄── WSS ──►    │             │
└──────────────┘                └─────────────┘
```

Cada dispositivo genera su propio keypair X25519 al registrarse. El hub almacena la clave pública. Al enviar un clip, el dispositivo emisor cifra el contenido con una clave de contenido aleatoria, y envuelve esa clave por destinatario usando ECDH(X25519) + HKDF. **El hub nunca tiene acceso al texto plano.**

## Dos modos de ejecutar el cliente desktop

ClipSync soporta dos modos de funcionamiento que **coexisten** y comparten el mismo registro:

| Modo | Cómo se ve | Cuándo elegir |
|------|------------|---------------|
| **Tray** (recomendado) | Ícono en menu bar (macOS) o system tray (Windows/Linux), click → menú con estado, peers, recent clips, pause/resume | Tienes una sesión gráfica y quieres ver qué pasa |
| **Daemon** | Sin UI, corre como servicio del sistema (launchd/systemd/Task Scheduler) | Servidor headless, NAS, Raspberry Pi |

El instalador pregunta cuál quieres al inicio. Puedes cambiar después sin re-registrar:

```bash
clipsync switch tray     # cierra daemon, abre tray app
clipsync switch daemon   # cierra tray, instala servicio
clipsync status          # qué modo está activo
clipsync stop            # detener cualquiera
```

Ambos modos:
- Comparten `~/.config/clipsync/client/state.json` (JWT, claves X25519, cert FP)
- Mutual exclusion vía lockfile + single-session enforcement del hub
- Auto-start al boot (tray usa `auto-launch` npm; daemon usa servicio del SO)

## Tutoriales por dispositivo

- [macOS](./macos.md)
- [Linux](./linux.md)
- [Windows](./windows.md)
- [PWA / móvil / browser](./pwa.md)

## Mitigaciones de seguridad activas

| Vulnerabilidad | Mitigación |
|----------------|------------|
| Clave AES compartida | Envelope encryption por dispositivo (X25519) |
| HTTP API sin auth | Admin token / password / first-device |
| CORS `*` | Allowlist de origen + Vary: Origin |
| Brute force PIN | Invalidación tras 5 fallos + rate limit IP |
| MITM (cert no validado) | TOFU certificate pinning en cliente desktop |
| JWT no revocado | JTI cascade + cierre WS en revocación |
| WS sin rate limit | Token bucket 5 PUSH/s por dispositivo |
| SSE sin auth | Cookie de sesión admin |
| Keys en localStorage | CryptoKey non-extractable en IndexedDB (PWA) |

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
