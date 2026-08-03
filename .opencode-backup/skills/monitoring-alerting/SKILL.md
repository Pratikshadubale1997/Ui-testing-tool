---
name: monitoring-alerting
description: >-
  Use when the user asks about system monitoring, resource usage, performance
  inspection, alert thresholds, health checks, or troubleshooting high CPU/memory/disk.
  Triggers on keywords: monitor, alert, CPU, memory, disk, health check, performance,
  top processes, system resource, threshold, watch, usage, lag, slow.
---

# Monitoring & Alerting

Activates the **monitoring-alerting** agent for system resource inspection, threshold-based alerting, and health reporting.

## When to invoke

- User says "monitor my system", "check CPU", "why is my computer slow", "check disk space", "memory usage", "top processes"
- User wants "alerts when ...", "set up monitoring", "health check"
- User says "watch" or "keep an eye on" resources

## Quick reference

```powershell
# CPU load
Get-CimInstance Win32_Processor | Select LoadPercentage

# Memory
Get-CimInstance Win32_OperatingSystem | Select @{N='MemPct';E={[math]::Round((1 - FreePhysicalMemory/TotalVisibleMemorySize)*100,1)}}

# Disk
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select DeviceID, @{N='UsedPct';E={[math]::Round((($_.Size-$_.FreeSpace)/$_ .Size)*100,1)}}

# Top processes by memory
Get-Process | Sort WorkingSet -Desc | Select -First 5 Name, @{N='MB';E={[math]::Round($_.WorkingSet/1MB,1)}}
```
