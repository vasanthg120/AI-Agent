# Keeps the NestJS backend running continuously: if it ever exits (crash, an
# unhandled exception, being killed by something outside this session -
# confirmed happening repeatedly in this dev environment with no exception
# trace at all), this immediately restarts it instead of leaving the API
# down until someone notices. Mirrors python-agent/run-forever.ps1 - same
# reasoning, same pattern, applied to the other service that's shown the
# same "silently died, nothing was supervising it" issue.
#
# Usage: powershell -ExecutionPolicy Bypass -File run-forever.ps1
# Stop with Ctrl+C (stops the loop and whatever attempt is currently running).
#
# Runs the already-built dist/ - this does NOT rebuild on its own. After a
# source change, run "npm run build" first (in a separate terminal, or let
# this loop keep serving the old build until you do) - the loop will pick up
# the new dist/main.js on its next restart.
#
# Note: this keeps the process alive only as long as this script itself is
# running (e.g. in an open terminal, or a background job in this session).
# It does NOT survive a machine reboot or logout on its own - for that,
# either run the whole stack via "docker compose up -d" (docker-compose.yml
# already sets restart: unless-stopped for backend) or install this script
# as a real Windows service (e.g. via NSSM) / Scheduled Task.

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$distMain = Join-Path $PSScriptRoot 'dist\main.js'
$logDir = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

Write-Host ("[{0}] run-forever supervisor starting - logs in {1}" -f (Get-Date -Format o), $logDir)

while ($true) {
    if (-not (Test-Path $distMain)) {
        Write-Host ("[{0}] dist/main.js not found - run 'npm run build' first. Retrying in 3s..." -f (Get-Date -Format o))
        Start-Sleep -Seconds 3
        continue
    }

    $timestamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
    $logFile = Join-Path $logDir ("backend_{0}.log" -f $timestamp)
    Write-Host ("[{0}] Starting backend (log: {1})" -f (Get-Date -Format o), $logFile)

    & node --enable-source-maps dist/main *>> $logFile
    $exitCode = $LASTEXITCODE

    Write-Host ("[{0}] backend exited (code {1}) - restarting in 3s..." -f (Get-Date -Format o), $exitCode)
    Start-Sleep -Seconds 3
}
