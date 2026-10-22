# Install Bonsai (`dsh-bonsai`) into a profile, with preflight, verification, and rollback.
#
# The rule this script enforces: never leave a profile in a state that has not been
# proven bootable. It stages a self-contained copy, backs up the profile manifest,
# installs, refreshes the copied package (pnpm skips `file:` refresh), checks the
# package is complete, then boots a throwaway profile through the real Loader. If
# any check fails it restores the manifest and removes the copy.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile web
#   ... -Profile web -DshPath "C:\...\dsh.cmd"   # explicit CLI
#   ... -Profile web -Keep                        # keep the rollback backup

param(
  [string]$Profile = 'web',
  [string]$DshPath = '',
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $homeDir "profiles\$Profile"
$manifest = Join-Path $profileDir 'package.json'
$target = Join-Path $profileDir 'node_modules\dsh-bonsai'
$staged = Join-Path $root 'plugin'
$packageName = 'dsh-bonsai'

function Fail([string]$message) {
  Write-Host ''
  Write-Host "  RESULT: FAIL — $message" -ForegroundColor Red
  exit 1
}

# --- 1. locate the CLI -------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($DshPath)) {
  $candidates = @(
    'C:\Users\ASUS\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\.bin\dsh.cmd',
    'C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  )
  $DshPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ([string]::IsNullOrWhiteSpace($DshPath) -or -not (Test-Path $DshPath)) { Fail 'no dsh CLI found; pass -DshPath' }
Write-Host "[1/7] cli: $DshPath"

if (-not (Test-Path $manifest)) { Fail "profile '$Profile' does not exist at $profileDir" }

# --- 2. build + stage a self-contained package -------------------------------
Write-Host '[2/7] building and staging'
& node (Join-Path $root 'scripts\stage.mjs') | Out-Host
if ($LASTEXITCODE -ne 0) { Fail 'stage failed' }
if (-not (Test-Path (Join-Path $staged 'lib\client.js'))) { Fail 'staged package has no client bundle' }
if (Test-Path (Join-Path $staged 'harness')) { Fail 'staged package unexpectedly contains the source checkout' }

# --- 3. back up the profile manifest (byte-exact) -----------------------------
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$backup = "$manifest.bak-$stamp"
Copy-Item $manifest $backup -Force
Write-Host "[3/7] manifest backed up to $(Split-Path -Leaf $backup)"

# --- 4. install through the official command --------------------------------
Write-Host "[4/7] dsh plugin --profile $Profile add file:$staged"
& $DshPath plugin --profile $Profile add "file:$staged" 2>&1 | Select-Object -Last 3 | Out-Host
if ($LASTEXITCODE -ne 0) {
  Copy-Item $backup $manifest -Force
  Fail 'dsh plugin add failed; manifest restored'
}

# --- 5. refresh the copied package (pnpm does not re-copy file: on content change)
Write-Host '[5/7] refreshing the installed copy'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Copy-Item $staged $target -Recurse -Force

# --- 6. integrity checks ----------------------------------------------------
Write-Host '[6/7] integrity checks'
$checks = @()
$checks += @{ name = 'entry dist/index.js'; ok = (Test-Path (Join-Path $target 'dist\index.js')) }
$checks += @{ name = 'client lib/client.js'; ok = (Test-Path (Join-Path $target 'lib\client.js')) }
$checks += @{ name = 'bundle patch'; ok = (Test-Path (Join-Path $target 'cordis\bundle.patch.yml')) }
$checks += @{ name = 'no source checkout'; ok = -not (Test-Path (Join-Path $target 'harness')) }
$http = Join-Path $target 'dist\plugin\http.js'
$checks += @{ name = 'no /api rpc intercept'; ok = ((Select-String -Path $http -Pattern 'rpc\.intercept' -SimpleMatch | Measure-Object).Count -eq 0) }
$manifestJson = [System.IO.File]::ReadAllText($manifest) -replace "^\uFEFF", ''
try {
  $parsed = $manifestJson | ConvertFrom-Json
  $checked = ($parsed.dependencies.$packageName -ne $null) -and ($parsed.dsh.profile.bundles -contains $packageName)
} catch { $checked = $false }
$checks += @{ name = 'manifest valid and selected'; ok = $checked }

foreach ($check in $checks) {
  $mark = if ($check.ok) { 'PASS' } else { 'FAIL' }
  Write-Host ("       {0,-28} {1}" -f $check.name, $mark)
}
$failed = $checks | Where-Object { -not $_.ok }
if ($failed) {
  Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item $backup $manifest -Force
  Fail "integrity checks failed ($($failed.name -join ', ')); rolled back"
}

# --- 7. prove it boots -------------------------------------------------------
Write-Host '[7/7] boot smoke test'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\verify-boot.ps1') | Out-Host
if ($LASTEXITCODE -ne 0) {
  Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item $backup $manifest -Force
  Fail 'the boot smoke test failed; profile rolled back'
}

if (-not $Keep) { Remove-Item $backup -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host "  RESULT: PASS - installed into profile '$Profile' and proven bootable" -ForegroundColor Green
Write-Host "  profile: $profileDir"
Write-Host '  next   : restart the app that uses this profile'
exit 0
