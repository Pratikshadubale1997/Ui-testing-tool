$scriptPath = "$env:USERPROFILE\.opencode\monitoring\scripts\monitor.ps1"
$sourceScript = Join-Path $PSScriptRoot "monitor.ps1"

# Ensure target directory exists
$targetDir = Split-Path $scriptPath -Parent
if (!(Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }

# Copy script to user profile so it persists
Copy-Item $sourceScript $scriptPath -Force

# --- Task: Start on logon ---
$logonTask = "SystemMonitor-LogOn"
$null = Unregister-ScheduledTask -TaskName $logonTask -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -IntervalSec 60"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $logonTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Created task: $logonTask (runs at logon)"

# --- Task: Start on resume from sleep (lid open) ---
$resumeTask = "SystemMonitor-Resume"
$null = Unregister-ScheduledTask -TaskName $resumeTask -Confirm:$false -ErrorAction SilentlyContinue
$action2 = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -IntervalSec 60"
$trigger2 = New-ScheduledTaskTrigger -AtStartup
$trigger2 = New-ScheduledTaskTrigger -Custom -RepetitionInterval (New-TimeSpan -Minutes 1) -AtStartup
# Use event trigger for resume from sleep
$trigger2 = New-ScheduledTaskTrigger -AtStartup
$null = Register-ScheduledTask -TaskName $resumeTask -Action $action2 -Trigger $trigger2 -Principal $principal -Settings $settings -Force -ErrorAction SilentlyContinue

# Better approach: use event trigger for resume
$resumeTask2 = "SystemMonitor-ResumeFromSleep"
$null = Unregister-ScheduledTask -TaskName $resumeTask2 -Confirm:$false -ErrorAction SilentlyContinue
$xml = @"
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <EventTrigger>
      <Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="System"&gt;&lt;Select Path="System"&gt;*[System[Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=507]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>
      <Delay>PT10S</Delay>
    </EventTrigger>
  </Triggers>
  <Actions>
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-WindowStyle Hidden -ExecutionPolicy Bypass -File "$scriptPath" -IntervalSec 60</Arguments>
    </Exec>
  </Actions>
  <Principals>
    <Principal id="Author">
      <UserId>$env:USERDOMAIN\$env:USERNAME</UserId>
      <RunLevel>Limited</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnRemoteAppliance>false</AllowStartOnRemoteAppliance>
  </Settings>
</Task>
"@
$taskPath = "$env:TEMP\_resume_task.xml"
$xml | Set-Content $taskPath -Encoding UTF8
$null = schtasks /Create /TN "SystemMonitor-ResumeFromSleep" /XML "$taskPath" /F 2>$null
Remove-Item $taskPath -Force

Write-Host "Created task: SystemMonitor-ResumeFromSleep (runs on lid open / resume)"
Write-Host ""
Write-Host "Setup complete! Monitoring will start automatically:"
Write-Host "  - At logon (every time you sign in)"
Write-Host "  - On resume from sleep (lid open)"
Write-Host "  - Logs: $env:USERPROFILE\.opencode-monitor\alerts.log"
Write-Host "  - To test now, run: $scriptPath"
