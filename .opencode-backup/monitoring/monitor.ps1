param(
  [int]$IntervalSec = 60,
  [int]$CpuWarn = 70,
  [int]$CpuCrit = 90,
  [int]$MemWarn = 80,
  [int]$MemCrit = 92,
  [int]$DiskWarn = 85,
  [int]$DiskCrit = 95
)

$logDir = "$env:USERPROFILE\.opencode-monitor"
$logFile = "$logDir\alerts.log"
$stateFile = "$logDir\state.json"
$configFile = "$logDir\config.json"

if (!(Test-Path $logDir)) {
  $null = New-Item -ItemType Directory -Path $logDir -Force
}

$config = @{
  IntervalSec = $IntervalSec
  Thresholds  = @{
    CpuWarn  = $CpuWarn
    CpuCrit  = $CpuCrit
    MemWarn  = $MemWarn
    MemCrit  = $MemCrit
    DiskWarn = $DiskWarn
    DiskCrit = $DiskCrit
  }
}
$config | ConvertTo-Json | Set-Content $configFile

function Get-Timestamp {
  return Get-Date -Format "yyyy-MM-dd HH:mm:ss"
}

function Log-Alert {
  param($Level, $Metric, $Value, $Threshold, $Remediation)
  $ts = Get-Timestamp
  $entry = "$ts | [$Level] | $Metric = $Value% (threshold: $Threshold%)"
  if ($Remediation) {
    $entry = "$entry -- Remediation: $Remediation"
  }
  Add-Content -Path $logFile -Value $entry
  Write-Host $entry
}

function Send-Toast {
  param($Title, $Message)
  try {
    $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<toast>
  <visual>
    <binding template="ToastText02">
      <text id="1">$Title</text>
      <text id="2">$Message</text>
    </binding>
  </visual>
</toast>
"@
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]::CreateToastNotifier("System Monitor").Show($xml)
  } catch {
    Write-Host "  [Toast failed: $($_.Exception.Message)]"
  }
}

function Get-CpuLoad {
  $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue
  if ($cpu) { return [int]($cpu | Select-Object -First 1).LoadPercentage }
  return $null
}

function Get-MemUsage {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($os) {
    return [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
  }
  return $null
}

function Get-DiskUsage {
  $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue
  $result = @{}
  foreach ($d in $disks) {
    $pct = [math]::Round(($d.Size - $d.FreeSpace) / $d.Size * 100, 1)
    $result[$d.DeviceID] = $pct
  }
  return $result
}

function Get-TopProcs {
  param($Count = 3)
  $procs = Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First $Count Name, @{N='MB';E={[math]::Round($_.WorkingSet / 1MB, 1)}}
  $lines = $procs | ForEach-Object { "$($_.Name) ($($_.MB) MB)" }
  return $lines -join ", "
}

function Test-AndAlert {
  $alerts = @()

  $cpu = Get-CpuLoad
  if ($cpu -ne $null) {
    if ($cpu -ge $CpuCrit) {
      $procs = Get-Process | Sort-Object CPU -Descending | Select-Object -First 3 Name
      $names = $procs.Name -join ", "
      Log-Alert "CRITICAL" "CPU" $cpu $CpuCrit "Top: $names. Consider: Taskkill /F /IM <name>"
      Send-Toast "CPU Critical" "$cpu% -- $names"
      $alerts += "cpu_critical"
    } elseif ($cpu -ge $CpuWarn) {
      Log-Alert "WARNING" "CPU" $cpu $CpuWarn
      $alerts += "cpu_warn"
    }
  }

  $mem = Get-MemUsage
  if ($mem -ne $null) {
    if ($mem -ge $MemCrit) {
      $procs = Get-TopProcs
      Log-Alert "CRITICAL" "Memory" $mem $MemCrit "Top consumers: $procs"
      Send-Toast "Memory Critical" "$mem% -- $procs"
      $alerts += "mem_critical"
    } elseif ($mem -ge $MemWarn) {
      Log-Alert "WARNING" "Memory" $mem $MemWarn
      $alerts += "mem_warn"
    }
  }

  $disks = Get-DiskUsage
  foreach ($d in $disks.Keys) {
    $pct = $disks[$d]
    if ($pct -ge $DiskCrit) {
      Log-Alert "CRITICAL" "Disk $d" $pct $DiskCrit "Free up space on $d"
      Send-Toast "Disk $d Critical" "$pct% full -- free up space"
      $alerts += "disk_critical"
    } elseif ($pct -ge $DiskWarn) {
      Log-Alert "WARNING" "Disk $d" $pct $DiskWarn
      $alerts += "disk_warn"
    }
  }

  $state = @{
    Timestamp = Get-Timestamp
    Cpu       = $cpu
    Memory    = $mem
    Disks     = $disks
    Alerts    = $alerts
  }
  $state | ConvertTo-Json | Set-Content $stateFile

  if ($alerts.Count -eq 0) {
    $diskStr = ($disks.Values | ForEach-Object { "$_%" }) -join ", "
    Write-Host "$(Get-Timestamp) | OK | CPU: $cpu% | Mem: $mem% | Disk: $diskStr"
  }
}

Write-Host "========================================"
Write-Host "  System Monitor Started"
Write-Host "  Interval: ${IntervalSec}s"
Write-Host "  Log file: $logFile"
Write-Host "========================================"
Write-Host "Thresholds:"
Write-Host "  CPU:  warn >= ${CpuWarn}%, crit >= ${CpuCrit}%"
Write-Host "  Mem:  warn >= ${MemWarn}%, crit >= ${MemCrit}%"
Write-Host "  Disk: warn >= ${DiskWarn}%, crit >= ${DiskCrit}%"
Write-Host "----------------------------------------"
Write-Host ""

while ($true) {
  Test-AndAlert
  Start-Sleep -Seconds $IntervalSec
}
