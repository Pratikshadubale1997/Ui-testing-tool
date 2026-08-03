param([int]$Port = 8080)

$serverScript = Join-Path $PSScriptRoot "dashboard\server.ps1"
$dashboardFile = Join-Path $PSScriptRoot "dashboard\index.html"

if (!(Test-Path $serverScript) -or !(Test-Path $dashboardFile)) {
  Write-Host "ERROR: Dashboard files not found."
  Write-Host "  Expected: $serverScript"
  Write-Host "            $dashboardFile"
  exit 1
}

$existing = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
while ($existing) {
  Write-Host "Port $Port is in use, trying $($Port + 1)..."
  $Port++
  $existing = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
}

$p = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$serverScript`" -Port $Port" -WindowStyle Normal -PassThru

Start-Sleep -Seconds 2

$test = $null
try { $test = Invoke-RestMethod -Uri "http://localhost:$Port/api/status" -ErrorAction Stop } catch {}

if ($test) {
  Start-Process "http://localhost:$Port"
  Write-Host ""
  Write-Host "  ==========================================="
  Write-Host "    System Monitor Dashboard"
  Write-Host "    http://localhost:$Port"
  Write-Host "  ==========================================="
  Write-Host ""
  Write-Host "    PID: $($p.Id)"
  Write-Host "    CPU: $($test.cpu)%  Memory: $($test.memory)%  Processes: $($test.processes)"
  Write-Host ""
  Write-Host "  To stop:"
  Write-Host "    Stop-Process -Id $($p.Id)"
  Write-Host ""
} else {
  Write-Host "ERROR: Server failed to start on port $Port"
}
