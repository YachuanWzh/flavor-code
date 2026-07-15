# Stops the brainstorm mind-map server for a session directory.
param(
    [Parameter(Mandatory = $true)][string]$SessionDir
)

$ErrorActionPreference = 'SilentlyContinue'

$infoPath = Join-Path $SessionDir 'state\server-info'
if (Test-Path $infoPath) {
    $info = Get-Content $infoPath -Raw | ConvertFrom-Json
    if ($info.pid) { Stop-Process -Id $info.pid -Force -Confirm:$false }
    Remove-Item $infoPath -Force
}
$stateDir = Join-Path $SessionDir 'state'
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force $stateDir | Out-Null }
New-Item -ItemType File -Force (Join-Path $stateDir 'server-stopped') | Out-Null
exit 0
