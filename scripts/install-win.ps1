# ClipSync — Windows installer.
# Usage:  .\install-win.ps1 -Role hub|client|both
#   When installing client, asks: tray (Electron) or daemon (Task Scheduler).
param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('hub','client','both')]
  [string]$Role
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$NodeExe = (Get-Command node -ErrorAction Stop).Source

function Install-DaemonTask {
  param([string]$Name, [string]$ScriptPath)
  $action  = New-ScheduledTaskAction  -Execute $NodeExe -Argument "`"$ScriptPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
  $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
                -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $Name
  Write-Host "OK Task '$Name' installed"
}

if ($Role -eq 'hub' -or $Role -eq 'both') {
  Push-Location "$Root\hub"; npm install; Pop-Location
  Install-DaemonTask -Name 'ClipSync Hub' -ScriptPath "$Root\hub\src\server.js"
}

if ($Role -eq 'client' -or $Role -eq 'both') {
  Push-Location "$Root\client-desktop"; npm install; Pop-Location

  Write-Host ""
  Write-Host "Como quieres correr ClipSync?"
  Write-Host "  1) Tray app (recomendado - icono en system tray)"
  Write-Host "  2) Daemon (Task Scheduler)"
  $choice = Read-Host "Modo [1]"
  if ($choice -eq '') { $choice = '1' }

  $ans = Read-Host "Registrar dispositivo ahora? [Y/n]"
  if ($ans -eq '' -or $ans -match '^[Yy]') {
    Push-Location "$Root\client-desktop"
    & $NodeExe src\register.js
    Pop-Location
  }

  if ($choice -eq '1') {
    Write-Host "-> installing tray (Electron) deps - first run is slow (~80 MB)"
    Push-Location "$Root\client-tray"; npm install; Pop-Location
    Write-Host "OK tray mode ready"
    Write-Host "  Start now: node `"$Root\bin\clipsync`" switch tray"
  } elseif ($choice -eq '2') {
    Install-DaemonTask -Name 'ClipSync Client' -ScriptPath "$Root\client-desktop\src\main.js"
    Write-Host "OK daemon mode installed (Task Scheduler)"
  } else {
    Write-Error "invalid choice"
    exit 1
  }
  Write-Host ""
  Write-Host "Para cambiar de modo despues: node `"$Root\bin\clipsync`" switch tray|daemon"
}

Write-Host "Done."
