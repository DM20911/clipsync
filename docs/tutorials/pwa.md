# ClipSync — PWA / móvil / browser

## Requisitos

Navegador moderno con soporte de Web Crypto X25519 e IndexedDB:

- **Chrome / Edge** 113+
- **Firefox** 119+
- **Safari** 17.4+ (iOS 17.4+)

Estar en la misma red Wi-Fi que el hub.

## Instalación / acceso inicial

1. En tu móvil/tablet, abre: `https://<ip-del-hub>:5679/`
2. **Aceptar el certificado self-signed**:
   - El navegador advertirá que la conexión "no es privada".
   - Compara el fingerprint que muestra el navegador (Detalles del certificado → Huella digital SHA-256) con el fingerprint que el dashboard del hub muestra junto al QR.
   - Si coinciden, acepta la excepción. Solo necesitas hacerlo una vez por dispositivo.
3. Click en "Add to Home Screen" (iOS) o "Install app" (Chrome/Android) para usarlo como app nativa.

## Registro

1. En el dashboard del hub, click "Generar QR".
2. En el PWA, escanea el QR (input de URL hub) o introduce manualmente:
   - Hub URL: `wss://<ip>:5678`
   - PIN: el de 6 dígitos
3. El PWA:
   - Genera un keypair X25519 (privada **non-extractable**, guardada en IndexedDB)
   - Envía la pública al hub
   - Recibe y guarda el JWT en localStorage

## Uso diario

- **Recibir clips**: aparecen en la lista al instante. Click en cualquiera para copiarlo al portapapeles del dispositivo.
- **Enviar clips**: pega texto en el área de compose y dale "Send". También funciona el "Share" desde otras apps (gracias al share-target).
- **Imágenes**: se muestran inline. En iOS Safari hay que copiar manualmente (restricción de la API).

## Solución de problemas

| Síntoma | Causa | Solución |
|---------|-------|----------|
| "your connection is not private" | Cert self-signed | Aceptar excepción la primera vez |
| No conecta tras refrescar | TLS exception caducó | Volver a aceptar |
| `auth_fail: device_revoked` | Admin te revocó | Click "Forget device" → re-registrar |
| iOS no permite escribir clipboard | Restricción Safari | El PWA muestra el contenido — copia manual |
| `X25519 not supported` | Browser viejo | Actualiza a la versión mínima requerida |

---

## ──── Notas técnicas ────

### Arquitectura

```
client-pwa/
├── index.html              ← shell de la PWA
├── app.js                  ← UI, WS, envelope encryption con Web Crypto
├── sw.js                   ← service worker (offline shell)
└── manifest.webmanifest    ← PWA manifest
```

### Almacenamiento

| Donde | Qué | Por qué |
|-------|-----|---------|
| `localStorage` (`clipsync_state_v2`) | hub_url, device_id, jwt, http_base | Datos no sensibles |
| `IndexedDB` (`clipsync` → `keys`) | X25519 `CryptoKey` privada (`extractable: false`) + publicKey base64 | La clave privada nunca aparece en JS como bytes raw |

XSS puede invocar derivación de claves usando el handle, pero **no puede exfiltrar la clave privada**.

### Crypto

- `crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])` → keypair, privada non-extractable
- `crypto.subtle.deriveBits({ name: 'X25519', public: peerKey }, myPriv, 256)` → shared secret
- `crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, ...)` → AES-GCM key
- `crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)` → ciphertext + tag

### Limitaciones conocidas

- **iOS Safari** restringe `navigator.clipboard.write` para imágenes — debes copiar manualmente desde el preview
- Si el usuario borra "Site data" del navegador, se pierde la clave privada y hay que re-registrar
- El service worker no implementa offline syncing — solo cachea el shell de la app
- X25519 en Web Crypto es relativamente reciente; en navegadores anteriores no funciona

### Reset

Click "Forget device" → confirma → recarga. Esto limpia tanto localStorage como IndexedDB.

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
