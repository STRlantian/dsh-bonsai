<#
.SYNOPSIS
  Publish the current tree as a stable release, then continue on a new test version.

.DESCRIPTION
  The repository always sits on a prerelease version such as 0.1.1-test.0, which is never
  published. This script:

    1. reads 0.1.1-test.0 from package.json
    2. refuses if 0.1.1 already exists on npm
    3. writes 0.1.1 and publishes it with the "latest" tag
    4. moves the working tree to 0.1.2-test.0 (next test cycle)
    5. commits that bump, tags the release and pushes

  A failure between 3 and 4 still restores a test version, so the tree never stays on a
  number that npm already owns.

.PARAMETER DryRun
  Do everything except publish, commit and push.

.PARAMETER Otp
  One-time password, when npm asks for 2FA despite a bypass token.

.PARAMETER SkipPush
  Publish, commit and tag locally, but do not push.

.EXAMPLE
  powershell -File scripts/release.ps1 -DryRun
  powershell -File scripts/release.ps1
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$SkipPush,
  [string]$Otp
)

$ErrorActionPreference = 'Stop'
$registry = 'https://registry.npmjs.org/'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Get-Manifest {
  # Explicit UTF-8: PowerShell 5.1 defaults to the system code page, which mangles the Chinese
  # in the description and wrote mojibake into a published tarball once already.
  $path = Join-Path $root 'package.json'
  $json = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  return ($json | ConvertFrom-Json)
}

function Set-Version([string]$version) {
  # Patch the raw text instead of round-tripping the manifest: ConvertTo-Json would reflow the
  # whole file and re-encode every string.
  $path = Join-Path $root 'package.json'
  $json = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $patched = [regex]::Replace($json, '"version"\s*:\s*"[^"]*"', ('"version": "' + $version + '"'), 'None')
  if ($patched -eq $json -and $json -notmatch ('"version"\s*:\s*"' + [regex]::Escape($version) + '"')) {
    throw "could not set version to $version"
  }
  [System.IO.File]::WriteAllText($path, $patched, (New-Object System.Text.UTF8Encoding($false)))
}

$original = $null
try {
  if (-not (Test-Path 'LICENSE')) { throw 'LICENSE is missing' }
  if (-not (Test-Path 'CHANGELOG.md')) { throw 'CHANGELOG.md is missing' }
  if ((Get-Manifest).private -eq $true) { throw 'package.json still sets private: true' }

  $original = (Get-Manifest).version
  if ($original -notmatch '^(\d+\.\d+\.\d+)-test\.(\d+)$') {
    throw "version '$original' is not a test version (expected x.y.z-test.N)"
  }
  $stable = $Matches[1]

  Write-Host "test version : $original  (local only)"
  Write-Host "stable target: $stable"

  $existing = $null
  try { $existing = & npm view "dsh-bonsai@$stable" version --registry $registry 2>$null } catch { $existing = $null }
  if ($existing) {
    throw "dsh-bonsai@$stable already exists on npm; bump the test version first (node scripts/bump-test-version.mjs)"
  }

  Set-Version $stable
  Write-Host "publishing $stable ..." -ForegroundColor Cyan

  $arguments = @('publish', '--registry', $registry, '--access', 'public', '--tag', 'latest')
  if ($DryRun) { $arguments += '--dry-run' }
  if ($Otp) { $arguments += '--otp', $Otp }

  & npm @arguments
  if ($LASTEXITCODE -ne 0) { throw "npm publish failed with exit code $LASTEXITCODE" }

  $parts = $stable.Split('.')
  $nextTest = '{0}.{1}.{2}-test.0' -f $parts[0], $parts[1], ([int]$parts[2] + 1)

  if ($DryRun) {
    Write-Host ''
    Write-Host "dry run: would publish $stable, then continue on $nextTest" -ForegroundColor Yellow
  } else {
    Write-Host "next test version: $nextTest" -ForegroundColor Cyan
    Set-Version $nextTest
    & git add -A
    & git -c user.name='STRlantian' -c user.email='m1606977882@outlook.com' commit -q -m "release v$stable"
    & git tag "v$stable"
    if (-not $SkipPush) {
      & git push origin main
      & git push origin "v$stable"
    }
    Write-Host ''
    Write-Host "published  : dsh-bonsai@$stable (latest)" -ForegroundColor Green
    Write-Host "working on : $nextTest (local only)" -ForegroundColor Green
  }
} catch {
  Write-Host "release aborted: $($_.Exception.Message)" -ForegroundColor Red
  $code = 1
} finally {
  $current = (Get-Manifest).version
  if ($current -notmatch '-test\.\d+$') {
    $fallback = if ($original -and $original -match '-test\.\d+$') { $original } else { "$current-test.0" }
    Set-Version $fallback
    Write-Host "restored working version: $fallback" -ForegroundColor Yellow
  }
  Pop-Location
}

if ($code -eq 1) { exit 1 }
