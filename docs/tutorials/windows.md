# ClipSync en Windows — guía paso a paso

> **Antes de empezar:** lee el [README principal](./README.md). Esta guía asume que ya entiendes qué es ClipSync.

---

## ¿Qué vas a lograr?

Que cuando hagas `Ctrl+C` en tu PC, ese contenido aparezca al hacer `Cmd+V` en tu Mac (o `Ctrl+V` en otra PC, "pegar" en tu iPhone). Sin abrir páginas, sin enviar nada manualmente.

---

## Requisitos previos

- [ ] **Windows 10** (build 1903+) o Windows 11
- [ ] **Node.js 18+** desde https://nodejs.org → "LTS"
- [ ] **PowerShell 5+** (incluido por defecto)
- [ ] **El hub corriendo** en alguna máquina de tu red
- [ ] **Token de admin** + **IP del hub**

---

## Paso 1 — Clonar e instalar

Abre **PowerShell como Administrador** (necesario para crear la tarea programada que arranca al iniciar sesión):

```powershell
git clone https://github.com/DM20911/clipsync.git
cd clipsync
.\scripts\install-win.ps1 -Role client
```

El instalador pregunta:

```
Como quieres correr ClipSync?
  1) Tray app (recomendado - icono en system tray)
  2) Daemon (Task Scheduler)
Modo [1]:
```

→ Aprieta Enter (Tray, recomendado).

Después:
```
Registrar dispositivo ahora? [Y/n]
```
→ **N** (lo haremos desde el dashboard, más fácil).

> El admin solo se necesita para registrar la tarea programada. ClipSync mismo corre con tu usuario normal, sin privilegios elevados.

---

## Paso 2 — Conseguir un PIN

Abre el browser:
```
https://<IP-del-hub>:5679/admin
```

Acepta el cert. Login con el token. Click **"+ register new device"**.

Copia el comando completo que aparece:
```bash
node client-desktop/src/register.js --qr '{"v":2,"hub":"...","pin":"690119","fp":"..."}'
```

---

## Paso 3 — Registrar este Windows

En PowerShell:
```powershell
cd C:\path\to\clipsync
node client-desktop\src\register.js --qr '<el-comando-completo>'
```

Sigue las preguntas (Enter para aceptar el nombre por defecto). Verás:
```
OK - device XXXXXXXX registered.
```

✅ **Windows registrado.**

---

## Paso 4 — Arrancar el cliente

```powershell
node bin\clipsync switch tray
```

Aparece un ícono **clipboard** en la **system tray** (esquina inferior derecha de la barra de tareas, junto al reloj).

Si no lo ves: Windows oculta íconos de tray. Click la flechita `^` cerca del reloj para ver los hidden icons.

Click derecho en el ícono → menú con estado, peers, recent clips, pause/resume, "Auto-start at login".

---

## Cómo se usa diariamente

```
Windows:  Ctrl+C  (sobre cualquier cosa)
            ↓ ~100 ms
Mac:      Cmd+V   → ahí está
iPhone:   ↑ → "Pegar"
```

**Nunca abres el dashboard.** La sincronización es invisible y automática.

---

## Auto-start

**Tray mode**: marca "Auto-start at login" en el menú del tray.

**Daemon mode**: el instalador ya configura Task Scheduler. Verifica:
```powershell
Get-ScheduledTask -TaskName "ClipSync Client"
```

Para detener:
```powershell
node bin\clipsync stop                      # cualquier modo
Stop-ScheduledTask -TaskName "ClipSync Client"
```

---

## Solución de problemas

| Síntoma | Causa | Solución |
|---------|-------|----------|
| Tarea falla en arranque | `node` fuera de PATH | Edita la acción en Task Scheduler con ruta absoluta a `node.exe` |
| No copia imágenes | ExecutionPolicy bloquea PowerShell | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `cert_mismatch` | Cert del hub cambió | Edita `%USERPROFILE%\.config\clipsync\client\state.json`, borra `hub_cert_fp`, reinicia |
| Daemon termina silenciosamente | Falta directorio de logs | Crea `%USERPROFILE%\.config\clipsync\client\` manual |
| Ícono no aparece | Windows lo escondió | Click flechita `^` en system tray |

### Re-registrar desde cero

```powershell
node bin\clipsync stop
Remove-Item -Recurse "$env:USERPROFILE\.config\clipsync\client"
# Genera nuevo PIN en dashboard, después:
node client-desktop\src\register.js --qr '<...>'
node bin\clipsync switch tray
```

---

## Cambiar entre tray y daemon

```powershell
node bin\clipsync switch daemon
node bin\clipsync switch tray
node bin\clipsync status
node bin\clipsync logs            # tail de logs
```

---

## Desinstalar

```powershell
node bin\clipsync stop
Unregister-ScheduledTask -TaskName "ClipSync Client" -Confirm:$false
Remove-Item -Recurse "$env:USERPROFILE\.config\clipsync"
Remove-Item -Recurse C:\path\to\clipsync
```

---

## ──── Referencia técnica ────

### Logs
```powershell
Get-Content "$env:USERPROFILE\.config\clipsync\client\daemon.log" -Wait -Tail 50
Get-Content "$env:USERPROFILE\.config\clipsync\client\daemon.err" -Wait -Tail 50
```

### Estado local
`%USERPROFILE%\.config\clipsync\client\state.json` — JWT, claves X25519, hub URL, cert FP.

### Cómo se manejan imágenes en Windows
`clipboard.js` invoca PowerShell con `System.Windows.Forms.Clipboard` para leer/escribir imágenes. Para texto usa `clipboardy` (npm), nativo y rápido.

### Tarea programada
Se registra como `ClipSync Client` con:
- Trigger: `AtLogOn` (al iniciar sesión)
- Principal: tu usuario, RunLevel `Limited` (NO SYSTEM)
- Settings: reinicio automático en fallo (5 intentos / minuto)

---

Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
