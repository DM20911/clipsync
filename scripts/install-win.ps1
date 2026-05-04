# ClipSync — Windows installer (Task Scheduler at logon).
# Usage:  .\install-win.ps1 -Role hub|client|both
param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('hub','client','both')]
  [string]$Role
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$NodeExe = (Get-Command node -ErrorAction Stop).Source

function Install-Task {
  param([string]$Name, [string]$ScriptPath)
  $action  = New-ScheduledTaskAction  -Execute $NodeExe -Argument "`"$ScriptPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
  $settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
                -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $Name
  Write-Host "✓ Task '$Name' installed"
}

if ($Role -eq 'hub' -or $Role -eq 'both') {
  Push-Location "$Root\hub"; npm install; Pop-Location
  Install-Task -Name 'ClipSync Hub' -ScriptPath "$Root\hub\src\server.js"
}

if ($Role -eq 'client' -or $Role -eq 'both') {
  Push-Location "$Root\client-desktop"; npm install; Pop-Location
  $ans = Read-Host "Register this device now? [Y/n]"
  if ($ans -eq '' -or $ans -match '^[Yy]') {
    Push-Location "$Root\client-desktop"
    & $NodeExe src\register.js
    Pop-Location
  }
  Install-Task -Name 'ClipSync Client' -ScriptPath "$Root\client-desktop\src\main.js"
}

Write-Host "Done. Manage tasks via Task Scheduler or PowerShell (Get-ScheduledTask)."
