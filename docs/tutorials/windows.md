# ClipSync — Windows

## Requisitos

- Windows 10 (build 1903+) o Windows 11
- Node.js 18+ — descarga desde https://nodejs.org
- PowerShell 5+ (incluido por defecto)

## Instalación

Abre PowerShell **como Administrador**:

```powershell
git clone https://github.com/DM20911/clipsync.git
cd clipsync
.\scripts\install-win.ps1 -Role client
```

El script:
1. Instala dependencias del cliente desktop
2. Te ofrece registrar el dispositivo
3. Registra una tarea programada `ClipSync Client` que arranca al iniciar sesión
4. La tarea corre con privilegios limitados del usuario (no SYSTEM)

> Se necesita Administrador solo para registrar la tarea programada. Una vez creada, corre como tu usuario normal.

## Registro inicial

```powershell
cd C:\path\to\clipsync\client-desktop
node src\register.js
# introduce el PIN
Start-ScheduledTask -TaskName "ClipSync Client"
```

## Uso diario

Logs:

```powershell
Get-Content "$env:USERPROFILE\.config\clipsync\client\daemon.log" -Wait
```

## Auto-start

Ya configurado. Para verificar:

```powershell
Get-ScheduledTask -TaskName "ClipSync Client"
```

Para detener:

```powershell
Stop-ScheduledTask -TaskName "ClipSync Client"
Disable-ScheduledTask -TaskName "ClipSync Client"
```

## Solución de problemas

| Síntoma | Causa | Solución |
|---------|-------|----------|
| Tarea falla en arranque | Node fuera de PATH | Edita la acción en Task Scheduler con ruta absoluta |
| No copia imágenes | PowerShell ExecutionPolicy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `cert_mismatch` | Cert del hub cambió | Borra `hub_cert_fp` de `state.json` |
| Daemon termina silenciosamente | Falta permisos en directorio de logs | Crea `%USERPROFILE%\.config\clipsync\client\` manualmente |

---

## ──── Notas técnicas ────

### Arquitectura

`clipboard.js` usa PowerShell con `System.Windows.Forms.Clipboard` para imágenes y `clipboardy` para texto. La tarea programada se registra con `RunLevel=Limited` (no `Highest`), corriendo con tus permisos normales.

### Logs

```powershell
Get-Content "$env:USERPROFILE\.config\clipsync\client\daemon.log" -Tail 100
Get-Content "$env:USERPROFILE\.config\clipsync\client\daemon.err" -Tail 100
```

### Estado local

`%USERPROFILE%\.config\clipsync\client\state.json`. Mismo formato que macOS/Linux.

### Desinstalar

```powershell
Unregister-ScheduledTask -TaskName "ClipSync Client" -Confirm:$false
Remove-Item -Recurse "$env:USERPROFILE\.config\clipsync"
```

---
Herramienta desarrollada por [DM20911](https://github.com/DM20911) — [OptimizarIA Consulting SPA](https://optimizaria.com)
