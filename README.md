<div align="center">

<img src="assets/logo.png" alt="ClipSync" width="120" />

# ClipSync

**Sincronización de portapapeles entre dispositivos en red local**

`Cmd+C` en una máquina · `Cmd+V` en otra · cifrado de extremo a extremo · sin nube

</div>

---

## Qué hace

Cuando copias texto, una imagen o un link en cualquier dispositivo registrado, aparece automáticamente en el portapapeles de los demás.

```
Mac:           Cmd+C  (copias un link)
                  ↓ ~100 ms
PC Windows:    Ctrl+V → ahí está
iPhone:        ↑ tap "Pegar" → ahí está
```

No abres ninguna página, no envías nada manualmente. El cliente de cada dispositivo monitorea el portapapeles del sistema operativo y propaga los cambios al instante a través de un hub local.

## Características

- **Multi-plataforma**: macOS, Linux, Windows, iOS y Android (vía PWA)
- **Solo LAN**: nunca sale de tu red Wi-Fi. Sin cuentas, sin tracking, sin nube
- **Cifrado E2E**: AES-256-GCM con claves derivadas vía X25519 + HKDF. El hub nunca ve el contenido en claro
- **Auto-discovery**: mDNS para encontrar el hub sin configurar IPs
- **TOFU TLS pinning**: el cliente fija la huella digital del certificado del hub en el primer pairing y rechaza cambios
- **Modos**: tray app (con ícono en la barra de menú) o daemon (servicio sin UI)
- **Texto, URLs, imágenes y archivos** hasta 50 MB

## Arquitectura

```
                    ┌──────────────┐
                    │     HUB      │
                    │  Node.js +   │
              ┌────▶│  SQLite +    │◀────┐
              │     │  WSS broker  │     │
              │     └──────────────┘     │
              │            ▲             │
              │            │             │
        ┌─────┴─┐    ┌─────┴─┐    ┌─────┴─┐
        │ macOS │    │ Linux │    │ Wind. │
        │ Tray  │    │ Tray  │    │ Tray  │
        └───────┘    └───────┘    └───────┘
                            │
                            ▼
                     ┌──────────┐
                     │   PWA    │ ← iOS / Android
                     │ (browser)│
                     └──────────┘
```

| Componente | Qué hace |
|------------|----------|
| `hub/` | Servidor central. WSS broker + mDNS + dashboard admin + sirve la PWA |
| `client-desktop/` | Núcleo del cliente (motor de sync, monitor de portapapeles, registro) |
| `client-tray/` | App Electron — ícono en menu bar / system tray con menú |
| `client-pwa/` | PWA para móvil/tablet (Safari iOS 17.4+, Chrome 113+) |
| `shared/` | Constantes de protocolo + helpers de crypto compartidos |
| `bin/clipsync` | CLI unificado (`status`, `switch tray\|daemon`, `register`, `logs`) |

## Quick start

Una sola máquina hace de **hub** (donde corre el servidor). El resto son clientes que se conectan.

### 1) Levantar el hub

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync/hub
npm install
npm start
```

A la primera ejecución imprime un **token de admin** (cópialo, se muestra una sola vez):

```
[clipsync] Admin token (save — shown once):
[clipsync]   M24CYQAFDxJJD_GagzXtkXlY9Hnl4Zlq_Pt9gRgB-GA
```

Anota también la IP local del hub (`ifconfig` o `ipconfig`).

### 2) Abrir el dashboard

```
https://<ip-hub>:5679/admin
```

Acepta el certificado self-signed. Login con el token. Click **"+ register new device"** para generar un PIN o QR.

### 3) Instalar el cliente en cada dispositivo

| Dispositivo | Comando | Tutorial |
|-------------|---------|----------|
| macOS | `bash scripts/install-mac.sh client` | [docs/tutorials/macos.md](docs/tutorials/macos.md) |
| Linux | `bash scripts/install-linux.sh client` | [docs/tutorials/linux.md](docs/tutorials/linux.md) |
| Windows | `.\scripts\install-win.ps1 -Role client` (admin) | [docs/tutorials/windows.md](docs/tutorials/windows.md) |
| Móvil / Browser | abre `https://<ip-hub>:5679/` | [docs/tutorials/pwa.md](docs/tutorials/pwa.md) |

### 4) Usarlo

`Cmd+C` (Mac/Linux) o `Ctrl+C` (Win) → aparece en los demás dispositivos en ~100ms.

> 📖 **[Manual completo paso a paso](docs/tutorials/README.md)** — qué es, cómo funciona, conceptos, FAQ, troubleshooting

## Modos del cliente desktop

| Modo | Cuándo |
|------|--------|
| **Tray** (recomendado) | Equipo personal. Ícono en menu bar, click → estado, peers, recent clips, pause |
| **Daemon** | Servidor headless (NAS, Raspberry Pi). Servicio del sistema sin UI |

Cambias cuando quieras sin re-registrar:

```bash
node bin/clipsync switch tray
node bin/clipsync switch daemon
node bin/clipsync status
```

## Modelo de seguridad

- **Cifrado per-device**: cada dispositivo genera un keypair X25519 al registrarse. Para enviar un clip, el emisor genera una clave de contenido aleatoria, cifra el payload con AES-256-GCM, y envuelve esa clave por destinatario usando ECDH(X25519) → HKDF-SHA256 → AES-GCM-wrap. El hub almacena el bundle pero no puede descifrar nada.
- **Revocación real**: revocar un dispositivo elimina su pubkey de la lista de destinatarios. Clips futuros nunca se cifran para él.
- **Admin auth**: token aleatorio impreso en consola (default), `CLIPSYNC_ADMIN_PASSWORD` con scrypt, o "primer dispositivo registrado = admin"
- **Rate limiting**: token-bucket en `PUSH` y `HISTORY_REQ`, attempt counter por IP en login y registro
- **TOFU pinning** del cert TLS del hub en clientes desktop
- **CSP estricto** en HTML servido por el hub
- **JTI revocation cascade** al revocar un dispositivo

Ver [docs/superpowers/specs/2026-05-04-security-mitigations-and-tutorials-design.md](docs/superpowers/specs/2026-05-04-security-mitigations-and-tutorials-design.md) para el modelo completo.

## Requisitos

- Node.js ≥ 18 (recomendado 20 LTS) en hub y clientes desktop
- macOS 12+, Linux con systemd, Windows 10+
- Browser moderno con Web Crypto X25519 + IndexedDB para PWA (Chrome 113+, Firefox 119+, Safari 17.4+)
- Todas las máquinas en la misma red privada (RFC1918 — `192.168/16`, `10/8`, `172.16/12`)

## Stack técnico

- **Hub**: Node.js, `ws`, `better-sqlite3`, `node-forge` (TLS), `qrcode`, mDNS via `multicast-dns`
- **Cliente desktop**: Node.js, `clipboardy`, `ws`, helpers de OS para imágenes (osascript / wl-clipboard / xclip / PowerShell)
- **Tray**: Electron + `auto-launch`
- **PWA**: HTML/JS vanilla + Web Crypto API + IndexedDB + Tailwind CDN
- **Crypto**: `node:crypto` (X25519 nativo), HKDF-SHA256, AES-256-GCM

## Licencia

MIT

---

Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
