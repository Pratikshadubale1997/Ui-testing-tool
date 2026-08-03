$scriptSource = Join-Path $PSScriptRoot "monitor.ps1"
$scriptDest = "$env:USERPROFILE\.opencode\monitoring\scripts\monitor.ps1"
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$startupFile = "$startupDir\SystemMonitor.ps1"

$targetDir = Split-Path $scriptDest -Parent
if (!(Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }

Copy-Item $scriptSource $scriptDest -Force
Write-Host "Script deployed to: $scriptDest"
Write-Host ""

$startupContent = @"
Start-Process powershell -WindowStyle Hidden -ArgumentList '-ExecutionPolicy Bypass -File "$scriptDest" -IntervalSec 60'
"@
$startupContent | Set-Content $startupFile -Force
Write-Host "[OK] Added to Startup folder (runs at every logon)"

Write-Host ""
Write-Host "Summary:"
Write-Host "  - Auto-starts at logon via: $startupFile"
Write-Host "  - Logs saved to: $env:USERPROFILE\.opencode-monitor\alerts.log"
Write-Host "  - Config at: $env:USERPROFILE\.opencode-monitor\config.json"
Write-Host ""
Write-Host "To test right now, run this in a PowerShell window:"
Write-Host "  powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptDest`" -IntervalSec 60"
Write-Host ""
Write-Host "For resume-from-sleep support, run this script as Administrator once."
