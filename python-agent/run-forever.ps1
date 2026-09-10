# Keeps python-agent running continuously: if it ever exits (crash, an
# unhandled exception at startup, being killed, anything), this immediately
# restarts it instead of leaving the service down until someone notices.
# This is what was missing - the app itself was already fine; nothing was
# supervising the process, so a single crash/kill meant CRM/Outlook sync
# silently stopped until someone manually restarted it.
#
# Usage: powershell -ExecutionPolicy Bypass -File run-forever.ps1
# Stop with Ctrl+C (stops the loop and whatever attempt is currently running).
#
# Note: this keeps the process alive only as long as this script itself is
# running (e.g. in an open terminal, or a background job in this session).
# It does NOT survive a machine reboot or logout on its own - for that,
# either run the whole stack via "docker compose up -d" (docker-compose.yml
# already sets restart: unless-stopped for python-agent) or install this
# script as a real Windows service (e.g. via NSSM) / Scheduled Task.

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$logDir = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

Write-Host ("[{0}] run-forever supervisor starting - logs in {1}" -f (Get-Date -Format o), $logDir)

while ($true) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
    $logFile = Join-Path $logDir ("python-agent_{0}.log" -f $timestamp)
    Write-Host ("[{0}] Starting python-agent (log: {1})" -f (Get-Date -Format o), $logFile)

    & $venvPython -m uvicorn app.main:app --host 0.0.0.0 --port 8000 *>> $logFile
    $exitCode = $LASTEXITCODE

    Write-Host ("[{0}] python-agent exited (code {1}) - restarting in 3s..." -f (Get-Date -Format o), $exitCode)
    Start-Sleep -Seconds 3
}
