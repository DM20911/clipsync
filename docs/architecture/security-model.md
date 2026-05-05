# Modelo de seguridad de ClipSync

Este documento describe la arquitectura criptográfica y los controles de seguridad activos en ClipSync. Para uso del sistema, ver los [tutoriales](../tutorials/README.md).

---

## Modelo de amenazas

ClipSync corre **solo en redes privadas RFC1918** (`192.168/16`, `10/8`, `172.16/12`). Aun así, asume que la LAN puede contener:

- Dispositivos no confiables (invitados, IoT, ex-empleados con acceso pasado)
- Posible MITM activo (ARP spoofing, rogue AP)
- Acceso físico ocasional (laptop robada)
- Compromiso de un cliente vía malware o supply-chain

El hub asume que **NO debe ver el contenido en claro**. Los clientes asumen que **otros clientes registrados podrían comprometerse** (por eso revocación es real, no flag).

## Cifrado de extremo a extremo (envelope encryption)

Cada dispositivo genera un keypair X25519 al registrarse. La clave privada nunca sale del disco del dispositivo (almacenada en `state.json` con permisos `0o600` o como `CryptoKey` non-extractable en IndexedDB para PWA).

### Flujo de envío

```
1. content_key  ← randomBytes(32)
2. encrypted_payload ← AES-256-GCM(content_key, payload)
3. ephemeral_keypair ← X25519.generate()
4. para cada destinatario d:
     shared    ← X25519(ephemeral_private, d.public)
     wrap_key  ← HKDF-SHA256(shared, salt=wrap_salt, info='clipsync-v1')
     wrapped[d.id] ← AES-256-GCM(wrap_key, content_key)
5. enviar al hub: {
     encrypted_payload,
     sender_ephemeral_public,
     wrap_salt,
     wrapped_keys: { [device_id]: wrapped }
   }
```

### Flujo de recepción

```
1. shared      ← X25519(my_private, sender_ephemeral_public)
2. wrap_key    ← HKDF-SHA256(shared, salt=wrap_salt, info='clipsync-v1')
3. content_key ← AES-256-GCM-decrypt(wrap_key, wrapped_keys[my_id])
4. payload     ← AES-256-GCM-decrypt(content_key, encrypted_payload)
```

### Hub

- Almacena el bundle (encrypted_payload + wrapped_keys) en SQLite
- En BROADCAST envía a cada dispositivo solo su `wrapped_keys[device_id]` correspondiente
- **Nunca posee material para descifrar** el contenido

### Revocación

`revokeDevice(id)`:
1. Marca `devices.revoked = 1`
2. Elimina la pubkey de la lista de destinatarios — clips futuros nunca se cifran para ese dispositivo
3. Inserta todos los JTI activos del dispositivo en `revoked_jti` (cierra sesiones existentes)
4. Cierra el WebSocket del dispositivo si está conectado

Los clips ya recibidos por el dispositivo revocado siguen en su disco — pero no recibe nada nuevo.

## Autenticación

### Registro inicial (PIN)

- PIN de 6 dígitos generado con `crypto.randomInt(0, 1_000_000)` (sin modulo bias)
- TTL: 5 minutos
- Hash en memoria: `sha256(salt || pin)` — el PIN en plaintext nunca se persiste
- Comparación timing-safe (`crypto.timingSafeEqual`)
- Single-use: consumido en el primer intento exitoso
- Lockout: invalidado tras 5 intentos fallidos
- Rate limit: 10 intentos por IP por minuto en `/api/register`

### Sesiones de dispositivo (JWT)

- HS256, TTL 7 días
- Cada JTI se persiste en `device_jtis` al emitirse
- `revokeDevice` cascada: inserta todos los JTI activos del dispositivo en `revoked_jti`
- Verificación: chequea que el JTI no esté revocado **y** que el dispositivo no esté revocado

### Admin (3 modos)

| Modo | `CLIPSYNC_ADMIN_MODE` | Mecanismo |
|------|----------------------|-----------|
| Token (default) | `token` | Token aleatorio 32 bytes, **hash sha256 persistido en DB**. Plaintext mostrado una sola vez al crear |
| Password | `password` | `CLIPSYNC_ADMIN_PASSWORD` env var, hashed con scrypt (N=16384, r=8, p=1) + salt persistido |
| First device | `first-device` | Primer dispositivo registrado tiene `is_admin=1`. Auth vía Bearer JWT |

Sesión: cookie `admin_session` (32 bytes, HttpOnly + Secure + SameSite=Strict, TTL 8h).

Rate limit en `/api/admin/login`: 5 intentos por IP cada 15 min.

## TLS

- Cert self-signed RSA 2048 generado al primer arranque del hub (10 años de validez, SAN incluye localhost + IPs locales + clipsync.local)
- Fingerprint SHA-256 del cert calculado al boot y guardado en `meta.cert_fingerprint`

### TOFU pinning (clientes desktop)

- En el primer pairing, el cliente captura `socket.getPeerCertificate().fingerprint256` y lo guarda en `state.hub_cert_fp`
- En conexiones siguientes, verifica que el fingerprint coincide
- Mismatch → cliente rechaza conexión, escribe a log, no envía credenciales

### Verificación durante el registro

`register.js --qr <payload>` recibe el cert FP en el QR. Antes de enviar el PIN + pubkey al hub, verifica que el cert servido por el hub coincida — previene MITM en first-contact.

### PWA

No tiene API de pinning programático. El usuario acepta manualmente la excepción TLS la primera vez. El QR muestra el FP para comparación visual contra los detalles del cert del browser.

## Aislamiento de red

- HTTP server: `#checkPrivate` rechaza requests cuyo IP de origen no esté en RFC1918
- WebSocket: rechaza upgrades de IPs no privadas
- mDNS: solo anuncia en interfaces locales

## CORS

Allowlist explícito:
- Cualquier origen `https://` con hostname en RFC1918 o `*.local` o `localhost` (gateado además por el check de IP privada)
- Foreign origins → 403

`Vary: Origin` enviado para evitar cache poisoning.

## Headers de seguridad en HTML

```
content-security-policy:
  default-src 'self';
  script-src 'self' https://cdn.tailwindcss.com https://unpkg.com 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  connect-src 'self' wss: https:;
  frame-ancestors 'none';
  base-uri 'self';
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: no-referrer
cache-control: no-cache, no-store, must-revalidate
```

## Rate limiting

Token bucket (`hub/src/rate-limit.js`):
- `PUSH` por dispositivo: capacity 20, refill 5/s
- `HISTORY_REQ` por dispositivo: capacity 5, refill 0.5/s

Attempt counter:
- `/api/register` por IP: 10 intentos / minuto
- `/api/admin/login` por IP: 5 intentos / 15 min
- PIN: 5 fallos antes de invalidación del PIN

## Validación de entrada

`validateRegistration` en `hub/src/auth.js`:
- `name`: string ≤ 64 chars, NFC-normalized, control chars stripped
- `os`: string ≤ 32 chars
- `fingerprint`: regex `^[a-f0-9]{32,128}$` o null
- `public_key`: Buffer no vacío

`isValidEnvelope` en `shared/protocol.js`: clip + envelope structure required fields.

## Anti-replay

`db.insertHistory()` usa `INSERT OR IGNORE`. Duplicate clip ID → error `duplicate_id` retornado al sender.

## Almacenamiento de claves

| Plataforma | Privada | Pública | Notas |
|------------|---------|---------|-------|
| Desktop (Mac/Linux/Win) | `state.json` mode `0o600` | `state.json` | DER bytes, base64 |
| PWA (browser) | IndexedDB `clipsync.keys.x25519_private` como `CryptoKey` con `extractable: false` | `localStorage` base64 | La privada nunca aparece en JS como bytes raw |

JWT en localStorage (PWA) — vulnerable a XSS pero LAN-only mitiga el riesgo. CSP estricto y escape en todo render dinámico.

## KDF

HKDF-SHA256 sobre el shared secret X25519. **No se usa PBKDF2** — el input ya es alta entropía (32 bytes random), HKDF es la primitiva correcta.

Para passwords admin: scrypt (N=16384, r=8, p=1, keylen=32) sobre el password. Salt aleatorio persistido en `meta.admin_pw_salt`.

## Separación de protocolo

`PROTOCOL_VERSION = 2` en `shared/protocol.js`. Clientes v1 reciben `protocol_upgrade_required` y deben re-registrar tras un wipe.

## Tests

- 40+ unit tests en `hub/src/__tests__/` cubren crypto, db, auth, admin, rate-limit, envelope
- 6 integration tests con WS reales — round-trip envelope, admin auth, rate limits, CORS, CSP

Ejecuta con `cd hub && npm test`.

## Limitaciones conocidas

- **PWA**: clave privada en IndexedDB. Si el usuario borra "Site data", se pierde y hay que re-registrar
- **JWT en localStorage**: extraíble vía XSS si la PWA recibe contenido attacker-controlled (todo input se escapa pero defensa en profundidad recomienda CryptoKey-based session tokens)
- **iOS Safari**: no permite escribir el clipboard programáticamente para imágenes — el usuario debe tap-copy manual
- **Sin perfect forward secrecy en JWTs**: rotación de server secret cada 30 días invalida tokens, pero no protege historial expuesto

## Roadmap de hardening

- [ ] WebAuthn/passkey-based admin auth
- [ ] Session tokens en cookies (no JWT en localStorage) para PWA
- [ ] Argon2id para passwords admin (actualmente scrypt es suficiente)
- [ ] Per-clip recipient ACLs ("solo a mi teléfono")
- [ ] Audit log de acciones admin con firma del operador

---

Para detalles del protocolo de wire ver `shared/protocol.js` y `hub/src/server.js` (función `onMessage`).
