# ClipSync en móvil / tablet / browser — guía paso a paso

> **Antes de empezar:** lee el [README principal](./README.md). Esta guía asume que ya entiendes qué es ClipSync.

---

## ⚠️ Importante: limitación del móvil

A diferencia de Mac/Linux/Windows, en **iOS y Android los browsers NO pueden monitorear automáticamente el portapapeles del sistema**. Es una restricción de seguridad del SO.

**Eso significa:**
- En desktop: copias en Mac → aparece automático en otra Mac (`Cmd+V`)
- En móvil: copias en iPhone → **no se sincroniza solo**. Tienes que abrir el PWA y pegar/compartir manualmente

### Cómo funciona en móvil entonces

**Para enviar desde móvil → desktop:**
1. Copias texto en cualquier app del móvil (Safari, WhatsApp, etc.)
2. Abres la PWA de ClipSync
3. Tap en el área "Compose" → "Paste from clipboard" → "Send"
4. Aparece en tu Mac/PC al instante

O usa el botón de **Compartir** del SO:
1. En cualquier app: Compartir → ClipSync (la PWA aparece como destino)
2. Se manda solo

**Para recibir desde desktop → móvil:**
1. Copias en tu Mac (`Cmd+C`)
2. La PWA del móvil lo recibe automáticamente y lo muestra en la lista
3. Tap en el item → se copia al portapapeles del móvil
4. Pegas donde quieras

> En **Mac/Linux/Windows desktop sí es full automático.** Solo el móvil tiene esta limitación.

---

## Requisitos

- [ ] Browser moderno con Web Crypto X25519 + IndexedDB:
  - Chrome / Edge **113+**
  - Firefox **119+**
  - Safari **17.4+** (iOS 17.4+)
- [ ] Estar en la **misma red Wi-Fi** que el hub
- [ ] Hub corriendo + IP del hub conocida

---

## Paso 1 — Abrir la PWA

En el browser del móvil/tablet:
```
https://<IP-del-hub>:5679/
```

Vas a ver un **warning de "conexión no privada"** porque el hub usa cert self-signed (no tiene dominio público). **Es normal en LAN privada.** Haz tap en "Avanzado" → "Continuar".

---

## Paso 2 — Registrar el móvil

Hay dos formas:

### A) Escanear el QR del dashboard (más rápido)

1. En tu Mac/PC abre `https://<ip-hub>:5679/admin`
2. Login con token del admin
3. Click "+ register new device" → aparece un QR
4. Abre la **cámara de tu móvil**, apunta al QR
5. Te aparece una notificación → tap → abre la PWA con todo pre-llenado (hub URL, PIN)
6. Verifica que el **fingerprint** que muestra coincide con el que ves en pantalla del Mac
7. Tap "Register" → listo

### B) Manual (si la cámara no funciona)

1. En la PWA, escribe:
   - Hub URL: `wss://192.168.x.x:5678`
   - PIN: el de 6 dígitos del dashboard
   - Device name: `iPhone Diego` (o el que quieras)
2. Tap "Register"

✅ El móvil queda registrado. Genera y guarda su par de claves X25519 (la privada nunca sale del IndexedDB del browser).

---

## Paso 3 — Instalar como app (opcional pero recomendado)

Que la PWA quede como ícono en home screen, abre rápido, recibe push:

**iOS Safari:**
- Tap el botón de compartir (cuadrado con flecha hacia arriba)
- Scroll abajo → "Add to Home Screen"
- Confirma

**Android Chrome:**
- Menú (`⋮`) → "Install app"
- Confirma

Ahora se ve como cualquier otra app. Abre directamente al dashboard de clipboard.

---

## Cómo se usa diariamente

### Recibir clips (desktop → móvil)

1. En tu Mac haces `Cmd+C` sobre algo
2. Abres la PWA en tu móvil (o ya está abierta) → aparece en la lista de "Recent clips"
3. Tap en el item → se copia al portapapeles del móvil
4. Pegas en WhatsApp, mensaje, donde sea

### Enviar clips (móvil → desktop)

**Opción 1 — Pegar manual:**
1. Copias algo en el móvil (Safari, WhatsApp, lo que sea)
2. Abres la PWA → tap "Paste from clipboard" → tap "Send"
3. Aparece en todos tus desktops registrados

**Opción 2 — Compartir desde otra app:**
1. En cualquier app → botón Compartir → "ClipSync"
2. Se manda solo

> **iOS Safari restricción:** para imágenes a veces hay que tap "Copy" manual al recibir, no se copia auto. Es restricción de iOS.

---

## Solución de problemas

| Síntoma | Causa | Solución |
|---------|-------|----------|
| "your connection is not private" | Cert self-signed (esperable) | Aceptar excepción la primera vez |
| No conecta tras refrescar | Excepción TLS expiró | Volver a aceptar excepción |
| `auth_fail: device_revoked` | Admin te revocó | "Forget device" → re-registrar con PIN nuevo |
| iOS no copia imágenes | Restricción Safari | Toca "Copy" manualmente sobre la imagen |
| No aparece como destino al compartir | Faltó "Add to Home Screen" | Instala como app |
| Browser muy viejo, error "X25519 not supported" | Versión antigua | Actualiza el browser a la mínima |

### Resetear todo

En la PWA, tap "Forget device" → confirma → recarga. Esto borra:
- localStorage (jwt, hub URL)
- IndexedDB (claves X25519)

Y vuelve al formulario de registro.

---

## Cosas que NO funcionan en PWA móvil

- **Auto-monitoreo del portapapeles** (limitación iOS/Android, no de ClipSync)
- **Sincronización en background** cuando la PWA está cerrada (los browsers limitan esto severamente)
- **Imágenes auto-copy en iOS Safari** (siempre requiere tap manual)
- **Archivos grandes binarios** (>10 MB en móvil puede ser lento)

---

## ──── Referencia técnica ────

### Almacenamiento

| Donde | Qué |
|-------|-----|
| `localStorage["clipsync_state_v2"]` | JSON con: hub_url, http_base, device_id, jwt |
| IndexedDB `clipsync` → `keys` | `x25519_private` (CryptoKey **non-extractable**) + `x25519_public_b64` |

La clave privada nunca aparece en JS como bytes raw — está como `CryptoKey` con `extractable: false`. XSS al máximo puede invocar derivación de claves usando el handle, pero no puede leer la clave en bruto.

### Crypto

- `crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])` — generar keypair non-extractable
- `crypto.subtle.deriveBits({ name: 'X25519', public: peerKey }, myPriv, 256)` — ECDH shared secret
- `crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, ...)` — derivar AES key
- `crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)` — AES-256-GCM

### Archivos

```
client-pwa/
├── index.html              ← UI shell (Tailwind)
├── app.js                  ← lógica completa (~400 líneas)
├── sw.js                   ← service worker (caches el shell offline)
└── manifest.webmanifest    ← PWA manifest (icons, share target)
```

### Share target

El manifest registra ClipSync como destino de "Compartir" para `text`, `url`, `title`. Cuando recibe un share, el PWA lee `?text=...&url=...&title=...` y lo pega en el campo Compose.

---

Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
