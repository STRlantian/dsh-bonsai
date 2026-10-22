<#
.SYNOPSIS
  Build, verify and publish dsh-bonsai to the public npm registry.

.DESCRIPTION
  The machine's npm registry is a mirror (registry.npmmirror.com), which cannot accept
  publishes, so the official registry is passed explicitly. `prepublishOnly` already runs
  the build, the staging step and the test suite, so a failure there aborts the publish.

.PARAMETER DryRun
  Print what would be uploaded without publishing.

.PARAMETER Otp
  One-time password, when the account has 2FA enabled for publishing.

.EXAMPLE
  powershell -File scripts/release.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$Otp
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  if (-not (Test-Path 'LICENSE')) { throw 'LICENSE is missing; a publish without it is not acceptable' }
  if (-not (Test-Path 'CHANGELOG.md')) { throw 'CHANGELOG.md is missing' }

  $manifest = Get-Content 'package.json' -Raw | ConvertFrom-Json
  if ($manifest.private -eq $true) { throw 'package.json still sets "private": true' }

  Write-Host "publishing $($manifest.name)@$($manifest.version)" -ForegroundColor Cyan
  Write-Host '  registry: https://registry.npmjs.org/'

  $arguments = @('publish', '--registry', 'https://registry.npmjs.org/', '--access', 'public')
  if ($DryRun) { $arguments += '--dry-run' }
  if ($Otp) { $arguments += '--otp', $Otp }

  & npm @arguments
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'publish failed.' -ForegroundColor Yellow
    Write-Host '  - not logged in? run: npm login --registry https://registry.npmjs.org/'
    Write-Host '  - 2FA enabled? pass -Otp <code>'
    exit $LASTEXITCODE
  }
  Write-Host 'done.' -ForegroundColor Green
} finally {
  Pop-Location
}
