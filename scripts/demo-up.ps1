<#
.SYNOPSIS
  Bring everything up, or back up, in one command.

.DESCRIPTION
  Written for a live demo, where the failure that matters is not a bug but a
  process that quietly went away - an app closed by accident, a database that
  was never started, a dev server orphaned by a hard kill.

  Every step is idempotent. Run it as often as you like: it starts only what is
  actually down, and it says what it found either way. Running it when
  everything is already healthy does nothing and takes a second.

  It does NOT kill anything by default. A demo has enough ways to go wrong
  without a helper script deciding your app needed restarting; pass -Reap to
  clean up orphaned dev servers when a port has drifted.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-up.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\demo-up.ps1 -Reap
#>
param(
  # Kill dev-server processes left behind by a hard shutdown. Ports drift when
  # an orphan holds the one the preview wanted, and the demo URL changes.
  [switch]$Reap
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot

function Test-Port($port) {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Report($name, $ok, $detail = '') {
  $mark = if ($ok) { '  UP  ' } else { ' DOWN ' }
  Write-Host ("{0} {1,-22} {2}" -f $mark, $name, $detail)
}

Write-Host ''
Write-Host 'Agentic Team - demo check' -ForegroundColor Cyan
Write-Host ''

# ---------------------------------------------------------------------------
# MongoDB. Only needed by projects that use it; started if it is installed.
# ---------------------------------------------------------------------------
if (Test-Port 27017) {
  Report 'MongoDB' $true 'already listening on 27017'
} else {
  $mongod = Get-ChildItem "$env:LOCALAPPDATA\..\.local\mongodb", "$env:USERPROFILE\.local\mongodb", "$env:PROGRAMFILES\MongoDB" -Recurse -Filter mongod.exe -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $mongod) {
    Report 'MongoDB' $false 'not installed - only matters for projects that use it'
  } else {
    $data = Join-Path (Split-Path -Parent (Split-Path -Parent $mongod.FullName)) 'data'
    $logs = Join-Path (Split-Path -Parent (Split-Path -Parent $mongod.FullName)) 'log'
    New-Item -ItemType Directory -Force -Path $data, $logs | Out-Null
    # Loopback only, both families: `localhost` resolves to ::1 first on
    # Windows, and binding one family strands every client that picks the other.
    # NOT --bind_ip_all, which would expose an unauthenticated database.
    Start-Process -FilePath $mongod.FullName `
      -ArgumentList "--dbpath `"$data`"", '--bind_ip', '127.0.0.1,::1', '--ipv6', '--port', '27017' `
      -RedirectStandardOutput (Join-Path $logs 'mongod.out') `
      -RedirectStandardError (Join-Path $logs 'mongod.err') `
      -WindowStyle Hidden
    Start-Sleep -Seconds 6
    Report 'MongoDB' (Test-Port 27017) "started from $($mongod.FullName)"
  }
}

# ---------------------------------------------------------------------------
# Orphaned dev servers, on request only.
# ---------------------------------------------------------------------------
if ($Reap) {
  $orphans = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'vite|nodemon' -and $_.CommandLine -notmatch [regex]::Escape($repo) }
  foreach ($o in $orphans) {
    Write-Host ("  reaping orphaned dev server, pid {0}" -f $o.ProcessId)
    Stop-Process -Id $o.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if (-not $orphans) { Write-Host '  no orphaned dev servers' }
}

# ---------------------------------------------------------------------------
# The app itself.
# ---------------------------------------------------------------------------
$healthy = $false
try {
  $healthy = ((Invoke-WebRequest -Uri 'http://127.0.0.1:4400/api/health' -UseBasicParsing -TimeoutSec 4).StatusCode -eq 200)
} catch { $healthy = $false }

if ($healthy) {
  Report 'Agentic Team' $true 'already running on 4400'
} else {
  $electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
  $main = Join-Path $repo 'desktop\dist\main.cjs'
  if (-not (Test-Path $main)) {
    Report 'Agentic Team' $false 'not built - run: npm run build; npm run build -w @agentic/desktop'
  } else {
    $log = Join-Path $env:TEMP 'agentic-desktop.log'
    Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory (Join-Path $repo 'desktop') `
      -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    # It boots the core service in-process, which probes every provider first.
    for ($i = 0; $i -lt 20 -and -not $healthy; $i++) {
      Start-Sleep -Seconds 2
      try { $healthy = ((Invoke-WebRequest -Uri 'http://127.0.0.1:4400/api/health' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) } catch { }
    }
    Report 'Agentic Team' $healthy $(if ($healthy) { 'started' } else { "did not come up - see $log" })
  }
}

# ---------------------------------------------------------------------------
# What is connected, and what is running.
# ---------------------------------------------------------------------------
if ($healthy) {
  Write-Host ''
  try {
    $snap = (Invoke-RestMethod -Uri 'http://127.0.0.1:4400/api/snapshot' -TimeoutSec 8)
    $snap = if ($snap.data) { $snap.data } else { $snap }
    $up = @($snap.providers | Where-Object { $_.available })
    Write-Host ("  models: {0}" -f (($up | ForEach-Object { "$($_.name) ($($_.kind))" }) -join ', '))
    foreach ($p in $snap.previews) {
      if ($p.status -eq 'running') { Write-Host ("  preview: {0}" -f $p.url) }
    }
  } catch { Write-Host '  (could not read the snapshot)' }
}

Write-Host ''
Write-Host 'Ready.' -ForegroundColor Green
Write-Host ''
