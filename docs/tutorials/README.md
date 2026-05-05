# ClipSync — Manual completo

## ¿Qué es ClipSync y para qué sirve?

ClipSync hace que **lo que copias con `Cmd+C` (o `Ctrl+C`) en una máquina, se pegue con `Cmd+V` en otra**, automáticamente, sin abrir nada.

**Caso de uso real:**

```
Tu Mac:           Cmd+C  (copias un link)
                    ↓ (~100 ms)
Tu PC Windows:    Ctrl+V → aparece pegado el link
```

Eso es todo. **No abres ninguna página web ni mandas nada a ningún sitio.** Tu Mac y tu PC tienen instalado un programita pequeño que monitorea el portapapeles del sistema. Cuando uno cambia, los demás se enteran y reciben el contenido.

Funciona con **texto, links, imágenes, archivos**. Funciona en ambas direcciones (Mac → PC → Mac → móvil → etc).

> ⚠️ **Importante: la página web del dashboard NO es por donde envías cosas.**
>
> El dashboard `https://hub:5679/admin` solo sirve para tareas de **administración** (una sola vez al inicio): registrar un dispositivo nuevo, revocar uno, ver historial.
>
> En el día a día, nunca lo abres. Solo copias-pegas con tu teclado normal.

## ¿Por qué no usar AirDrop / Universal Clipboard / Google?

| Sistema | Limitaciones |
|---------|--------------|
| **AirDrop** | Solo Apple. No automático, hay que confirmar cada vez. |
| **Universal Clipboard** | Solo Apple. Lento, falla con frecuencia. |
| **Google clipboard** | Atado a Chrome/Android. Pasa por servidores de Google. |
| **Copiar y pegar entre máquinas** | Vía email/WhatsApp/AirDrop manual — lento, expone datos sensibles. |
| **ClipSync** | Funciona macOS + Linux + Windows + iPhone + Android, automático, **nunca sale de tu red local**, cifrado de extremo a extremo. |

## ¿Cómo funciona técnicamente? (en 30 segundos)

```
TU MAC                    HUB                    TU PC WINDOWS
┌────────────┐         ┌────────┐              ┌────────────┐
│ Cmd+C      │         │        │              │  Ctrl+V    │
│ (copias)   │         │        │              │  (pegas)   │
│   ↓        │         │ corre  │              │     ↑      │
│ Cliente    │         │ Node.js│              │  Cliente   │
│ monitorea  │ ──cifra→│ +      │ ──cifra────→ │  recibe y  │
│ portapapel │  por LAN│ SQLite │  reenvía     │  escribe   │
│ del SO     │         │        │              │  portapap. │
└────────────┘         └────────┘              └────────────┘
                          ↑
                          └─── reenvía a todos
                               los demás
                               registrados
```

- **El HUB** es un programita Node.js. Corre en **una sola máquina** de tu red (siempre encendida — Mac, NAS, Raspberry Pi, etc.). Es el "punto de encuentro" donde se cruzan los mensajes.
- **Cada dispositivo** (Mac, iPhone, PC, Android) corre un cliente pequeño que **monitorea el portapapeles del sistema operativo cada 300ms**. Cuando detecta un cambio, lo manda al hub.
- Cuando copias algo en tu Mac → su cliente detecta el cambio → lo cifra → lo manda al hub → el hub lo reenvía a los demás dispositivos registrados → ellos lo descifran → su cliente lo **escribe al portapapeles del SO** → cuando pegas, ahí está.
- **El hub nunca ve el contenido en claro.** Está cifrado de extremo a extremo (AES-256 + X25519). Solo los dispositivos registrados pueden descifrar.

Latencia: **~150–250 ms en LAN.** El cliente revisa el portapapeles cada 150ms (configurable con `CLIPSYNC_POLL_MS`); a eso se suman ~50ms de red + crypto. Imperceptible cuando vas del teclado al trackpad.

## Conceptos que necesitas conocer

Solo 4 cosas. Luego ya entiendes todo.

### 1. Hub
La máquina servidor. Corre `npm start` y queda escuchando. Tiene una **dirección IP en tu red** (ej. `192.168.1.10`). Los demás dispositivos se conectan a esa IP.

### 2. Dashboard del admin
Una página web `https://<ip-hub>:5679/admin` para administrar. Sirve para:
- Generar códigos QR / PINs para registrar dispositivos nuevos
- Ver qué dispositivos están conectados
- Revocar uno (echarlo del sistema)
- Borrar el historial

Solo el admin del hub puede entrar (login con un token).

### 3. Token de admin
Una clave larga aleatoria que **se imprime una sola vez** la primera vez que arrancas el hub:

```
[clipsync] Admin token (save — shown once):
[clipsync]   M24CYQAFDxJJD_GagzXtkXlY9Hnl4Zlq_Pt9gRgB-GA
```

**Cópialo y guárdalo.** Lo necesitas para entrar al dashboard. Si lo pierdes, hay que borrar la base de datos del hub y empezar de nuevo (se genera uno nuevo).

### 4. PIN de registro
Un código de **6 dígitos** que dura 5 minutos. Lo genera el dashboard cada vez que quieres unir un dispositivo nuevo. El nuevo dispositivo introduce ese PIN para "presentarse" al hub. Una vez registrado, ya no necesita el PIN nunca más.

```
PIN ≠ Token de admin.

Token = "yo soy el dueño del hub" (largo, permanente).
PIN   = "ese dispositivo nuevo soy yo, lo confirmo" (corto, 5 min, un solo uso).
```

---

## Pasos para tener todo funcionando

Hay **dos roles**: la máquina-hub (la que sirve) y los dispositivos clientes (los que sincronizan).

### Paso A — Levantar el hub (una sola vez)

Esto se hace en **una sola máquina** que esté siempre encendida cuando uses ClipSync. Idealmente la que más usas (tu Mac, por ejemplo).

```bash
git clone https://github.com/DM20911/clipsync.git
cd clipsync/hub
npm install
npm start
```

Salida esperada:

```
[clipsync] Admin token (save — shown once):
[clipsync]   AbCd1234EfGh5678IjKl9012MnOp3456...      ← ⚠️ COPIA ESTO

[info] cert fingerprint { fp: 'XX:XX:XX:...' }
[info] clipsync hub started { wss: 5678, http: 5679 }

ClipSync Hub running.
  Dashboard:  https://localhost:5679/admin
  PWA:        https://localhost:5679/
  WSS:        wss://localhost:5678
```

Anota:
- El **token de admin** (línea con `M24...`) → necesario para el dashboard
- La **IP de tu hub** en la red local — averigua con `ifconfig | grep 192` (Mac/Linux) o `ipconfig` (Windows). Suele ser `192.168.x.x`.

### Paso B — Abrir el dashboard

En cualquier browser de tu red:

```
https://192.168.1.10:5679/admin
                ↑ tu IP
```

El browser dirá "no es seguro" porque el certificado es self-signed (es normal — el hub no tiene un dominio público). Acepta la excepción.

Pega el token cuando te pida login.

### Paso C — Unir un dispositivo

Desde el dashboard, click **"+ register new device"**. Aparece:

- Un **QR**
- Un **PIN** de 6 dígitos
- Un link `https://192.168.x.x:5679/?reg=...`
- Un comando para terminal

**Tienes 5 minutos** para usar uno de estos métodos antes de que el PIN expire.

#### Si el dispositivo es un móvil/tablet → escanea el QR
Abre la cámara, apunta al QR. Te abre el navegador en una página que YA tiene el hub URL y el PIN rellenados. Click "Register" → listo.

#### Si el dispositivo es una Mac/PC/Linux → copia el comando CLI
El dashboard te muestra algo como:
```bash
node client-desktop/src/register.js --qr '{"v":2,"hub":"...","pin":"690119","fp":"..."}'
```
Pégalo en una terminal de la máquina nueva. Pulsa enter → registrado.

#### Si tu cámara no funciona → introduce manualmente
Anota el PIN. En el otro dispositivo:
```bash
node client-desktop/src/register.js
# te pregunta: hub URL? → wss://192.168.1.10:5678
# te pregunta: PIN?     → 690119
# te pregunta: nombre?  → MiMac
```

### Paso D — Arrancar el cliente del dispositivo

Después del registro, el dispositivo tiene en disco un `state.json` con su JWT y claves de cifrado. Ahora hay que **correr** el cliente:

**Opción 1 — Tray (recomendado para Mac/Linux/Windows con escritorio)**

Aparece un ícono en la barra de menú (esquina superior en Mac, abajo derecha en Windows). Click para ver estado, peers, recent clips, pause/resume.

```bash
node bin/clipsync switch tray
```

**Opción 2 — Daemon (sin UI, ideal para servidor headless)**

Corre como servicio del sistema, sin ícono. Verifica con logs.

```bash
node bin/clipsync switch daemon
```

**Opción 3 — Móvil/tablet (PWA)**

El navegador del móvil ya está corriendo el cliente PWA — no necesita "arrancar" nada más. Mantén la pestaña abierta o instálalo como app (iOS: "Add to Home Screen", Android: "Install app").

---

## Cómo lo usas en el día a día

Una vez todos los dispositivos están registrados:

1. **Copias** algo en cualquier dispositivo (`Cmd+C`).
2. **Pegas** en otro dispositivo (`Cmd+V`).
3. **Listo.**

No hay nada más que hacer. La sincronización es automática y dura unos 100ms en LAN.

Si quieres pausarla (ej. estás copiando una contraseña que NO quieres que llegue al móvil):
- En el tray app: click → "Pause sync"
- Después: click → "Resume sync"

---

## Dos modos de correr el cliente

| Modo | Cuándo usarlo |
|------|---------------|
| **Tray** | En tu equipo de trabajo. Ves el estado, accedes al historial reciente, pausas con un click. |
| **Daemon** | En un servidor sin pantalla (NAS, Raspberry Pi). Corre como servicio del sistema y no estorba. |

**Cambias de modo cuando quieras** sin re-registrar:
```bash
node bin/clipsync switch tray
node bin/clipsync switch daemon
node bin/clipsync status     # qué modo está activo
node bin/clipsync stop       # detener todo
```

---

## Modos de admin (avanzado)

Por defecto el hub usa **token de admin**. Pero puedes elegir otro modo al arrancar:

```bash
# Modo 1: Token (default)
npm start

# Modo 2: Password (defines tu propia contraseña)
CLIPSYNC_ADMIN_MODE=password CLIPSYNC_ADMIN_PASSWORD='mi-clave' npm start

# Modo 3: First device (el primer dispositivo registrado es admin)
CLIPSYNC_ADMIN_MODE=first-device npm start
```

Si no sabes cuál elegir → **deja el default (token)**. Es el más seguro.

---

## Tutoriales por dispositivo

Una vez entiendes lo de arriba, ve al tutorial específico de tu equipo:

- 🍎 [macOS](./macos.md) — instalar cliente desktop en Mac
- 🐧 [Linux](./linux.md) — Ubuntu, Fedora, Arch, etc.
- 🪟 [Windows](./windows.md) — Windows 10 / 11
- 📱 [PWA / móvil / browser](./pwa.md) — iPhone, Android, tablets, otros

---

## Preguntas frecuentes

**¿Necesito internet?**
No. ClipSync solo usa tu Wi-Fi local. Funciona sin internet.

**¿Puedo conectarme desde fuera de casa (4G/5G, otra Wi-Fi)?**
No. Es intencional, por seguridad. Si lo necesitas, monta una VPN a tu casa (Tailscale, WireGuard).

**¿El hub puede ser cualquier máquina?**
Sí. Mac, Linux, Windows, Raspberry Pi 3+. Solo necesita Node.js 18+ y estar siempre encendido cuando quieras sincronizar.

**¿Qué pasa si apago el hub?**
Los demás dispositivos quedan desconectados pero conservan su registro. Cuando enciendas el hub, se reconectan solos.

**¿Y si pierdo el token de admin?**
Borras la DB del hub (`rm -rf ~/.config/clipsync/hub/`) y reinicias. Se genera un nuevo token. Tendrás que re-registrar todos los dispositivos.

**¿Cuánto cuesta?**
Cero. Es software libre, no hay servidor en la nube, no hay tracking.

**¿Quién puede ver mis copias-pegas?**
Solo los dispositivos que tú registres. Ni siquiera el hub puede leer el contenido — está cifrado de extremo a extremo. Si un dispositivo es robado, lo revocas desde el dashboard y queda fuera para siempre.

**¿Funciona con archivos grandes?**
Hasta 50 MB por clip (texto, imagen, archivo). Si copias algo más grande, se omite y verás un warning en logs.

---

Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
