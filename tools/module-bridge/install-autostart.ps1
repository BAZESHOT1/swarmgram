# Registers Kinto module bridge autostart at user logon.
# Run once: powershell -ExecutionPolicy Bypass -File install-autostart.ps1
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node.exe).Source
if (-not $node) { throw 'node.exe not found in PATH' }

$action = New-ScheduledTaskAction -Execute $node -Argument 'server.mjs --port=8787' -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Kinto Module Bridge' -Action $action -Trigger $trigger -Settings $settings -Description 'Local COM/ESP bridge for Kinto admin module debug' -Force | Out-Null
Start-ScheduledTask -TaskName 'Kinto Module Bridge'
Write-Host 'Kinto Module Bridge registered and started: http://127.0.0.1:8787'
