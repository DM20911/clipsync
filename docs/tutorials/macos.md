# ClipSync en macOS — guía paso a paso

> **Antes de empezar:** lee el [README principal](./README.md) si no entiendes qué es ClipSync. Esta guía asume que ya leíste eso.

---

## ¿Qué vas a lograr con esta guía?

Al terminar, tu Mac va a:
1. Tener un **ícono de portapapeles** en la barra de menú (esquina superior derecha)
2. Sincronizar automáticamente cualquier `Cmd+C` con tus otros dispositivos
3. Arrancar solo cada vez que enciendes el Mac
4. Mostrarte estado, peers conectados y últimas copias en un menú simple

Tiempo estimado: **5 minutos** si ya tienes el hub corriendo.

---

## ¿Qué necesitas antes?

Antes de empezar, asegúrate de tener:

- [ ] **macOS 12** (Monterey) o más nuevo
- [ ] **Node.js 18+** instalado. Verifica con `node -v` en la terminal.
  Si no lo tienes: `brew install node`
- [ ] **El hub corriendo** en alguna máquina de tu red (puede ser este mismo Mac u otra). Mira el [README](./README.md) para levantar el hub.
- [ ] **El token de admin** del hub (te lo dio el `npm start` del hub) — necesario para entrar al dashboard.
- [ ] **La IP del hub** en tu red — algo como `192.168.x.x`.

---

## Paso 1 — Clonar el repo en tu Mac

Abre la app **Terminal** (Spotlight: `Cmd+Espacio` → escribe "terminal").

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync
```

Esto descarga todo el código del proyecto a tu carpeta `~/clipsync`.

---

## Paso 2 — Instalar el cliente

Desde la carpeta `clipsync` que acabas de clonar:

```bash
bash scripts/install-mac.sh client
```

Esto va a hacer **3 cosas**:

1. Instalar las dependencias de Node (toma 1-2 min)
2. **Preguntarte qué modo quieres**:
   ```
   Cómo quieres correr ClipSync?
     1) Tray app (recomendado — ícono en menu bar)
     2) Daemon en background (sin UI)
   Modo [1]:
   ```
   → Aprieta **Enter** (elige 1, el recomendado).
3. **Preguntarte si quieres registrar ahora**:
   ```
   Registrar dispositivo ahora? [Y/n]
   ```
   → **Decir N** por ahora (vamos a hacerlo desde el dashboard, es más fácil).

### ¿Qué hace cada modo?

| Modo | Qué pasa |
|------|----------|
| **Tray** | Instala una app pequeña con ícono en la barra de menú. Click → ves estado, recent clips, pause. |
| **Daemon** | Instala un servicio del sistema (`launchd`) que corre sin UI. Mira logs con `tail -f`. |

Tray es más fácil para un Mac de uso personal. Daemon es para cuando tu Mac es un "servidor" sin pantalla.

---

## Paso 3 — Conseguir un código de registro desde el dashboard

Necesitamos darle al cliente del Mac una "credencial" para que el hub lo reconozca. Esa credencial es un **PIN de 6 dígitos** que dura 5 minutos.

### 3.1 — Abre el dashboard del hub

En el browser de tu Mac, ve a:
```
https://<IP-del-hub>:5679/admin
```
*(Si el hub corre en este mismo Mac, la IP es la de la red local — averígualo con `ifconfig | grep "inet 192"` en la terminal.)*

Vas a ver un warning de "conexión no segura" → **click en "Avanzado" → "Continuar a localhost (no seguro)"**. Esto es normal: el hub usa un certificado self-signed (no tiene un dominio público).

### 3.2 — Login con el token

El dashboard te pide el **token de admin**. Lo pegas (el largo que copiaste del `npm start` del hub).

### 3.3 — Genera el código

En la sección "CONNECTED DEVICES", abajo verás un botón naranja:
**"+ register new device"**

Click. Aparece:
- Un **QR** grande
- Un **PIN** (6 dígitos, ej. `690119`)
- Un **link** para escanear desde móvil
- Un **comando completo** para pegar en terminal

**Copia el comando completo** que dice algo como:
```bash
node client-desktop/src/register.js --qr '{"v":2,"hub":"wss://...","pin":"690119","fp":"04:72:..."}'
```

Tienes 5 minutos antes de que expire.

---

## Paso 4 — Registrar este Mac

Vuelve a la **Terminal** en la carpeta `clipsync`. Pega el comando que copiaste y dale enter:

```bash
cd ~/clipsync
node client-desktop/src/register.js --qr '{"v":2,"hub":"wss://192.168.100.28:5678","pin":"690119","fp":"04:72:..."}'
```

Vas a ver:
```
ClipSync registration

Hub: wss://192.168.100.28:5678
Cert FP: 04:72:C5:5F:BA:A3:B5:F8:7D:CF:BC...
Device name [MacBook-Pro-de-Diego.local]:
```

Solo aprieta **Enter** para aceptar el nombre por defecto, o escribe otro.

```
OK — device d0590229 registered.
Start the daemon: node client-desktop/src/main.js
```

✅ **Tu Mac está registrado.**

### ¿Qué pasó técnicamente?

Tu Mac:
1. Generó un **par de claves X25519** (criptografía de curva elíptica). La privada se queda en tu Mac, nunca sale.
2. Le mandó la pública al hub junto con el PIN.
3. El hub validó el PIN (correcto, no expirado) y le emitió un **JWT** (token de sesión).
4. Todo eso se guardó en `~/.config/clipsync/client/state.json`.

Ahora tu Mac puede cifrar clips para los demás dispositivos y descifrar los que le manden ellos.

---

## Paso 5 — Arrancar el cliente

```bash
node bin/clipsync switch tray
```

Esto:
1. Instala Electron si es la primera vez (~80 MB, toma 1-2 min)
2. Lanza la app del tray

**Mira la barra de menú de tu Mac** (esquina superior derecha, donde están el reloj, Wi-Fi, Bluetooth). Aparece un **ícono con forma de clipboard** (rectángulo con clip arriba).

- Verde = conectado al hub, sincronizando
- Naranja = pausado
- Gris = desconectado, intentando reconectar
- Rojo = error (cert mismatch, problema de red)

### Click en el ícono — qué ves

```
🟢 Connected · 2 peer(s)
─────────────────────
Recent clips     ▶
─────────────────────
Pause sync
Open admin dashboard
─────────────────────
☐ Auto-start at login
Re-register…
─────────────────────
Quit ClipSync
```

**Activa "Auto-start at login"** para que ClipSync arranque solo cada vez que prendes el Mac.

---

## Cómo se usa en el día a día

Una vez todo está conectado, **es invisible**.

- Copias texto, una imagen, un link, lo que sea (`Cmd+C`)
- En menos de 1 segundo aparece en los demás dispositivos registrados
- Pegas allá (`Cmd+V`)

No hay que abrir nada, ni confirmar, ni hacer click en notificaciones.

### Casos especiales

**¿Quieres pausar la sync temporalmente?** (ej. estás a punto de copiar una contraseña que NO quieres en el móvil)
- Click en el ícono → "Pause sync"
- Después: → "Resume sync"

**¿Quieres ver qué se sincronizó recientemente?**
- Click en el ícono → "Recent clips" → submenu con los últimos 8

**¿Quieres revocar un dispositivo?** (perdiste el iPhone, ex-empleado se va, etc.)
- Abre el dashboard del hub
- Click "revoke" en el dispositivo → el JWT se invalida y el dispositivo no puede volver a conectar

---

## Solución de problemas comunes

### El ícono no aparece en la barra de menú

macOS Sonoma tiene **muchos íconos escondidos**. Comprueba:
- Si tienes Bartender o iStat Menus → revisa la sección de hidden items
- Mira cerca del reloj. Si no cabe, macOS lo oculta. Borra otros íconos del menu bar (System Settings → Control Center) o instala Bartender.

Verifica que sí está corriendo:
```bash
node bin/clipsync status
```
Si dice `Active mode: tray (pid XXXX)`, el ícono está, solo escondido.

### "auth failed: device_revoked"

El admin del hub te revocó. Re-registra:
```bash
node bin/clipsync stop
node client-desktop/src/register.js     # con un PIN nuevo del dashboard
node bin/clipsync switch tray
```

### "CERT MISMATCH"

El certificado del hub cambió (ej. reinstalaron el hub, se borró la DB del hub).
```bash
# Edita state.json y borra la línea hub_cert_fp
nano ~/.config/clipsync/client/state.json
# Reinicia
node bin/clipsync stop && node bin/clipsync switch tray
```

### No copia imágenes

macOS necesita permiso de **Accesibilidad** para leer/escribir imágenes del clipboard:
1. System Settings → Privacy & Security → Accessibility
2. Activa el switch para tu Terminal (o Electron, o cualquier app desde donde corras ClipSync)

---

## Cambiar entre tray y daemon

Sin re-registrar, cuando quieras:

```bash
node bin/clipsync switch daemon    # cambia a modo daemon (sin UI)
node bin/clipsync switch tray      # cambia a modo tray (con ícono)
node bin/clipsync status           # ver qué está activo ahora
```

---

## Desinstalar todo

```bash
node bin/clipsync stop                                          # detiene cualquier modo
launchctl unload ~/Library/LaunchAgents/com.clipsync.daemon.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.clipsync.daemon.plist
rm -f ~/Library/LaunchAgents/com.clipsync.client.plist          # legacy si existía
rm -rf ~/.config/clipsync                                       # borra estado y registro
rm -rf ~/clipsync                                               # borra el código
```

---

## ──── Referencia técnica ────

### Archivos importantes

| Ruta | Qué guarda |
|------|------------|
| `~/.config/clipsync/client/state.json` | JWT, claves X25519, IP del hub, cert fingerprint |
| `~/.config/clipsync/client/.lock` | Lockfile (qué modo está activo) |
| `~/.config/clipsync/client/daemon.log` | Logs del daemon |
| `~/Library/LaunchAgents/com.clipsync.daemon.plist` | LaunchAgent del modo daemon |
| `~/clipsync/` | Código fuente |

### Comandos útiles

```bash
# Ver el estado actual
node bin/clipsync status

# Ver logs en vivo
node bin/clipsync logs

# Detener
node bin/clipsync stop

# Cambiar modo
node bin/clipsync switch tray|daemon

# Re-registrar (pidiendo nuevo PIN al dashboard)
node bin/clipsync register

# Verificar que ClipSync está corriendo
ps aux | grep clipsync | grep -v grep
```

### Variables de entorno

| Variable | Default | Función |
|----------|---------|---------|
| `CLIPSYNC_CLIENT_DIR` | `~/.config/clipsync/client` | Directorio del state.json |
| `CLIPSYNC_POLL_MS` | `150` | Intervalo de polling del clipboard (baja a 80 para más responsive) |

### Arquitectura del cliente

```
client-desktop/src/
├── engine.js        ← núcleo: WS + crypto + clipboard monitor
├── main.js          ← entry del modo daemon
├── ws-client.js     ← WebSocket con TOFU pinning del cert TLS
├── clipboard.js     ← lee/escribe portapapeles (clipboardy + osascript)
├── store.js         ← state.json
├── lock.js          ← mutex daemon ↔ tray
├── discovery.js     ← mDNS para encontrar el hub
└── register.js      ← CLI de registro inicial

client-tray/         ← app Electron que importa engine.js
bin/clipsync         ← CLI unificado
```

---

Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
