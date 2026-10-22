# Boot smoke test for Bonsai (`dsh-bonsai`).
#
# Proves that installing the plugin does not break a profile's startup: it builds a
# throwaway DSH home, installs the *staged* package (a copy via `file:`, so the
# profile never scans this repository as a linked workspace), boots a web profile,
# and checks the page, the client boot graph, and the tree rpc endpoint.
#
# Usage:
#   pwsh -NoProfile -File scripts/verify-boot.ps1
#
# Exit code 0 = PASS. The throwaway home is removed afterwards.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dsh = 'C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path $dsh)) { Write-Error "dsh CLI not found at $dsh"; exit 2 }

$home_ = Join-Path $root '.dsh-verify'
$port = 19471
$staged = Join-Path $root 'plugin'

Write-Host '[1/6] staging the package'
& node (Join-Path $root 'scripts\stage.mjs') | Out-Host
if (-not (Test-Path (Join-Path $staged 'lib\client.js'))) { Write-Error 'staged client bundle missing'; exit 1 }

Write-Host '[2/6] creating a throwaway DSH home'
Remove-Item $home_ -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $home_ | Out-Null
$env:DSH_HOME = $home_
& $dsh --profile verify --from-default-profile web --dump-config 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0 -and -not (Test-Path (Join-Path $home_ 'profiles\verify'))) {
  Write-Error 'profile creation failed'
  exit 1
}

Write-Host '[3/6] installing the staged package (file:, a copy)'
& $dsh plugin --profile verify add "file:$staged" 2>&1 | Select-Object -Last 3 | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Error 'install failed'; exit 1 }

$manifest = Get-Content (Join-Path $home_ 'profiles\verify\package.json') -Raw | ConvertFrom-Json
if (-not ($manifest.dsh.profile.bundles -contains 'dsh-bonsai')) {
  Write-Error 'the bundle was not selected in the profile'
  exit 1
}

Write-Host "[4/6] booting on port $port"
$job = Start-Job -ScriptBlock {
  param($dshPath, $profileHome, $listenPort)
  $env:DSH_HOME = $profileHome
  & $dshPath --profile verify --no-open --port $listenPort 2>&1
} -ArgumentList $dsh, $home_, $port

$token = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 1000
  $out = Receive-Job $job -Keep 2>&1 | Out-String
  if ($out -match 'http://127\.0\.0\.1:' + $port + '/\?token=([A-Za-z0-9_\-]+)') {
    $token = $Matches[1]
    break
  }
  if ($out -match 'startup failed|did not activate') {
    Write-Host $out
    Write-Error 'the host failed to start with the plugin installed'
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    exit 1
  }
}

if ($null -eq $token) {
  Write-Host (Receive-Job $job -Keep 2>&1 | Out-String)
  Write-Error 'the host never became ready'
  Stop-Job $job -ErrorAction SilentlyContinue
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host "      ready (token captured)"

Write-Host '[5/6] checking the page, the boot graph, the tree route, and a shipped rpc'
$session = $null
$index = (Invoke-WebRequest "http://127.0.0.1:$port/?token=$token" -UseBasicParsing -SessionVariable session -TimeoutSec 10).Content
$hasClient = $index -match 'dsh-bonsai'
$indexOk = $index.Length -gt 1000

# Our exact route must answer with the block payload.
$tree = Invoke-WebRequest "http://127.0.0.1:$port/api/token-tree/tree" -UseBasicParsing -WebSession $session -TimeoutSec 10
$treeOk = ($tree.StatusCode -eq 200) -and ($tree.Content -match '"blocks"')

# The settings route proves the installed copy is the one just built, not a stale one
# left behind by a `file:` dependency that pnpm did not refresh.
$settingsOk = $false
try {
  $settings = Invoke-WebRequest "http://127.0.0.1:$port/api/token-tree/settings" -UseBasicParsing -WebSession $session -TimeoutSec 10
  $settingsOk = ($settings.StatusCode -eq 200) -and ($settings.Content -match '"effective"')
} catch {
  $settingsOk = $false
}

# The shipped gateway must still answer: registering on the shared `/api`
# interceptor slot would replace it and make every other RPC 404.
$shippedBody = '{"type":"client-request","rpcId":"verify-2","method":"session/list","payload":{"args":{}}}'
$shippedOk = $false
try {
  $shipped = Invoke-WebRequest "http://127.0.0.1:$port/api/session/list" -Method Post -Body $shippedBody -ContentType 'application/json' -UseBasicParsing -WebSession $session -TimeoutSec 10
  $shippedOk = ($shipped.StatusCode -eq 200) -and ($shipped.Content -match '"server-response"')
} catch {
  $shippedOk = $false
}

Write-Host '[6/6] cleaning up'
Stop-Job $job -ErrorAction SilentlyContinue
Remove-Job $job -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Get-Process -Name node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like '*DeepSeek*' } |
  Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-3) } |
  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Remove-Item $home_ -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "  page served      : $(if ($indexOk) { 'PASS' } else { 'FAIL' }) ($($index.Length) bytes)"
Write-Host "  client half wired: $(if ($hasClient) { 'PASS' } else { 'FAIL' }) (boot graph entry)"
Write-Host "  tree route       : $(if ($treeOk) { 'PASS' } else { 'FAIL' }) ($($tree.StatusCode))"
Write-Host "  settings route   : $(if ($settingsOk) { 'PASS' } else { 'FAIL' })"
Write-Host "  shipped rpc      : $(if ($shippedOk) { 'PASS' } else { 'FAIL' }) (gateway not shadowed)"
if ($indexOk -and $hasClient -and $treeOk -and $settingsOk -and $shippedOk) {
  Write-Host '  RESULT           : PASS'
  exit 0
}
Write-Host '  RESULT           : FAIL'
exit 1
