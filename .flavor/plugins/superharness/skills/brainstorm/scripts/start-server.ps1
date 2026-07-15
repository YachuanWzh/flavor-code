# Starts the brainstorm mind-map server for a project.
# Creates <project>/.claude/superharness/brainstorm/<session-id>/{content,state}, launches
# node server.cjs detached, waits for state/server-info, prints it and exits.
param(
    [string]$ProjectDir = (Get-Location).Path,
    [int]$TimeoutSec = 10
)

$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'node not found on PATH - brainstorm mind map unavailable'; exit 1 }

$sessionId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $PID
$sessionDir = Join-Path $ProjectDir ".claude\superharness\brainstorm\$sessionId"
New-Item -ItemType Directory -Force (Join-Path $sessionDir 'content') | Out-Null
New-Item -ItemType Directory -Force (Join-Path $sessionDir 'state') | Out-Null

$serverJs = Join-Path $PSScriptRoot 'server.cjs'
$env:SUPERHARNESS_SESSION_DIR = $sessionDir
try {
    Start-Process -FilePath $node.Source -ArgumentList ('"' + $serverJs + '"') -WindowStyle Hidden
} finally {
    Remove-Item Env:SUPERHARNESS_SESSION_DIR -ErrorAction SilentlyContinue
}

$infoPath = Join-Path $sessionDir 'state\server-info'
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    if (Test-Path $infoPath) { break }
    Start-Sleep -Milliseconds 200
}
if (-not (Test-Path $infoPath)) {
    Write-Error "server did not start within $TimeoutSec seconds"
    exit 1
}
Get-Content $infoPath -Raw -Encoding UTF8
exit 0
