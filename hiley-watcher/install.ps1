<#
  Registers hiley-watcher as a Scheduled Task that starts at logon and
  restarts itself if it dies. Run from an ELEVATED PowerShell on the
  playout PC (the Dell), from inside C:\VxD\hiley-watcher.

      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\install.ps1

  This needs the Dell to auto-login, otherwise "at logon" never happens
  after a power cut — which is the whole scenario this is for. Set that
  up separately (netplwiz, or Sysinternals Autologon).

  Deliberately NOT a Windows service: OBS runs in the interactive
  session and obs-websocket listens on 127.0.0.1 there. A LocalSystem
  service would be in a different session and could not reach it — the
  same trap as cloudflared reading the systemprofile config.
#>

$ErrorActionPreference = 'Stop'

$dir  = $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found on PATH. Install Node, then re-run." }

$script = Join-Path $dir 'hiley-watcher.js'
if (-not (Test-Path $script)) { throw "hiley-watcher.js not found in $dir" }
if (-not (Test-Path (Join-Path $dir 'config.json'))) {
  throw "config.json not found in $dir. Copy config.example.json to config.json and fill it in first."
}

$name = 'VxD Hiley Watcher'

# Remove any previous registration so this script is safe to re-run.
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "Removed previous task."
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

# Highest privileges, interactive session — see the note at the top.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal | Out-Null

Write-Host "Registered '$name'."
Write-Host "Starting it now..."
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName $name | Get-ScheduledTaskInfo |
  Select-Object TaskName, LastRunTime, LastTaskResult, NumberOfMissedRuns | Format-List

Write-Host ""
Write-Host "Check the log:  Get-Content '$dir\hiley-watcher.log' -Tail 30 -Wait"
Write-Host "Dashboard:      https://mix.vxd.news/hiley"
