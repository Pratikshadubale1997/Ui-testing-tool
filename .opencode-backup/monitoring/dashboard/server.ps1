param([int]$Port = 8080)

$dashboardDir = Join-Path $PSScriptRoot "."
$dashboardFile = Join-Path $dashboardDir "index.html"

if (!(Test-Path $dashboardFile)) {
  Write-Host "ERROR: index.html not found at $dashboardFile"
  exit 1
}

$dashboardHtml = [System.IO.File]::ReadAllText($dashboardFile)
$alertLogPath = "$env:USERPROFILE\.opencode-monitor\alerts.log"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

Write-Host ""
Write-Host "  ==========================================="
Write-Host "    System Monitor Dashboard"
Write-Host "    http://localhost:$Port"
Write-Host "  ==========================================="
Write-Host "  Press Ctrl+C to stop."
Write-Host ""

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $rsp = $ctx.Response

  $path = $req.RawUrl

  if ($path -eq "/" -or $path -eq "") {
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($dashboardHtml)
    $rsp.ContentType = "text/html; charset=utf-8"
    $rsp.ContentLength64 = $buffer.Length
    $rsp.OutputStream.Write($buffer, 0, $buffer.Length)
    $rsp.OutputStream.Close()
    continue
  }

  if ($path -eq "/api/status") {
    $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue
    $procs = Get-Process -ErrorAction SilentlyContinue

    $cpuLoad = 0
    $cpuModel = ""
    if ($cpu) {
      $firstCpu = $cpu | Select-Object -First 1
      $cpuLoad = [int]$firstCpu.LoadPercentage
      $cpuModel = $firstCpu.Name
    }

    $memPct = 0
    $memFreeGB = 0
    if ($os) {
      $memPct = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
      $memFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    }

    $diskHash = @{}
    foreach ($d in $disks) {
      $pct = [math]::Round(($d.Size - $d.FreeSpace) / $d.Size * 100, 1)
      $diskHash[$d.DeviceID] = $pct
    }

    $allProcs = $procs.Count

    $topCpu = $procs | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object {
      @{ name = $_.Name; value = [math]::Round($_.CPU, 1) }
    }

    $topMem = $procs | Sort-Object WorkingSet -Descending | Select-Object -First 5 | ForEach-Object {
      @{ name = $_.Name; value = [math]::Round($_.WorkingSet / 1MB, 1) }
    }

    $alerts = @()
    if (Test-Path $alertLogPath) {
      $lines = Get-Content $alertLogPath -Tail 50
      foreach ($line in $lines) {
        $parts = $line -split '\s*\|\s*'
        if ($parts.Count -ge 3) {
          $alert = @{
            timestamp = $parts[0].Trim()
            level     = $parts[1].Trim() -replace '\[|\]', ''
            metric    = ""
            value     = ""
            threshold = ""
            remediation = ""
          }
          $detail = $parts[2]
          if ($detail -match '^(.+?)\s*=\s*(\S+)%\s*\(threshold:\s*(\S+)%\)') {
            $alert.metric = $matches[1].Trim()
            $alert.value = $matches[2]
            $alert.threshold = $matches[3]
          }
          if ($parts.Count -ge 4) {
            $alert.remediation = $parts[3] -replace '^Remediation:\s*', ''
          }
          $alerts += $alert
        }
      }
    }

    $status = @{
      timestamp    = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
      cpu          = $cpuLoad
      cpuModel     = $cpuModel
      memory       = $memPct
      memoryFreeGB = $memFreeGB
      disks        = $diskHash
      processes    = $allProcs
      topCpu       = $topCpu
      topMem       = $topMem
      alerts       = $alerts
    }

    $json = $status | ConvertTo-Json -Depth 5
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
    $rsp.ContentType = "application/json; charset=utf-8"
    $rsp.ContentLength64 = $buffer.Length
    $rsp.OutputStream.Write($buffer, 0, $buffer.Length)
    $rsp.OutputStream.Close()
    continue
  }

  if ($path -like "/api/duplicates*") {
    $query = [System.Web.HttpUtility]::ParseQueryString($req.Url.Query)
    $dir = $query["dir"]
    if (!$dir) { $dir = "$env:USERPROFILE" }

    Write-Host "  [scan] Scanning $dir ..."

    $groups = @{}
    $total = 0
    $files = Get-ChildItem -Path $dir -Recurse -File -ErrorAction SilentlyContinue -Depth 3
    foreach ($f in $files) {
      $key = "$($f.Name)|$($f.Length)"
      if (!$groups.ContainsKey($key)) {
        $groups[$key] = @()
      }
      $groups[$key] += @{
        name     = $f.Name
        path     = $f.FullName
        size     = $f.Length
        lastWrite = $f.LastWriteTime.ToString("yyyy-MM-dd HH:mm")
      }
      $total++
    }

    $dups = @()
    foreach ($g in $groups.Values) {
      if ($g.Count -gt 1) {
        $dups += @{ files = $g }
      }
    }

    Write-Host "  [scan] Found $($dups.Count) duplicate groups (scanned $total files)"

    $result = @{ duplicates = $dups; totalScanned = $total }
    $json = $result | ConvertTo-Json -Depth 5
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
    $rsp.ContentType = "application/json; charset=utf-8"
    $rsp.ContentLength64 = $buffer.Length
    $rsp.OutputStream.Write($buffer, 0, $buffer.Length)
    $rsp.OutputStream.Close()
    continue
  }

  if ($path -eq "/api/cleanup" -and $req.HttpMethod -eq "POST") {
    $reader = New-Object System.IO.StreamReader($req.InputStream)
    $body = $reader.ReadToEnd()
    $reader.Close()
    $payload = $body | ConvertFrom-Json

    $deleted = 0
    $failed = @()
    foreach ($f in $payload.files) {
      try {
        if (Test-Path $f) {
          Remove-Item -Path $f -Force -ErrorAction Stop
          $deleted++
        }
      } catch {
        $failed += $f
      }
    }

    $msg = "Deleted $deleted file(s)"
    if ($failed.Count -gt 0) { $msg += "; $($failed.Count) failed (may need admin)" }

    $result = @{ deleted = $deleted; failed = $failed; message = $msg }
    $json = $result | ConvertTo-Json
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
    $rsp.ContentType = "application/json; charset=utf-8"
    $rsp.ContentLength64 = $buffer.Length
    $rsp.OutputStream.Write($buffer, 0, $buffer.Length)
    $rsp.OutputStream.Close()

    Write-Host "  [cleanup] $msg"
    continue
  }

  # 404 fallback
  $rsp.StatusCode = 404
  $buffer = [System.Text.Encoding]::UTF8.GetBytes("Not found")
  $rsp.ContentLength64 = $buffer.Length
  $rsp.OutputStream.Write($buffer, 0, $buffer.Length)
  $rsp.OutputStream.Close()
}

$listener.Stop()
