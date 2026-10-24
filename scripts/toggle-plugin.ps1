<#
.SYNOPSIS
Turn the Bonsai plugin off (or back on) in a DSH profile without deleting anything.

.DESCRIPTION
When the desktop app refuses to start, the first question is whether a third-party plugin is
involved. This edits the profile manifest in one direction or the other and prints the result; the
installed files stay where they are, so turning it back on is one command.

.PARAMETER Profile
Profile name; defaults to "desktop".

.PARAMETER Off
Remove the plugin from the profile's bundles and dependencies.

.PARAMETER On
Put it back (dependency plus bundle entry).

.EXAMPLE
powershell -File scripts/toggle-plugin.ps1 -Off
powershell -File scripts/toggle-plugin.ps1 -On
#>
param(
  [string]$Profile = 'desktop',
  [switch]$Off,
  [switch]$On
)

$ErrorActionPreference = 'Stop'
$packageName = 'dsh-bonsai'
$manifest = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\package.json"

if (-not (Test-Path $manifest)) {
  Write-Host "no profile manifest at $manifest" -ForegroundColor Red
  exit 1
}
if (-not $Off -and -not $On) {
  Write-Host 'pass -Off or -On' -ForegroundColor Yellow
  exit 1
}

$backup = "$manifest.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
Copy-Item $manifest $backup -Force

$text = [System.IO.File]::ReadAllText($manifest, [System.Text.Encoding]::UTF8)
$json = $text | ConvertFrom-Json
if ($null -eq $json.dsh) { $json | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if ($null -eq $json.dsh.profile) { $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }

$bundles = @()
if ($null -ne $json.dsh.profile.bundles) { $bundles = @($json.dsh.profile.bundles) }

if ($Off) {
  $bundles = @($bundles | Where-Object { $_ -ne $packageName })
  if ($null -ne $json.dependencies -and $null -ne $json.dependencies.PSObject.Properties[$packageName]) {
    $json.dependencies.PSObject.Properties.Remove($packageName)
  }
} else {
  if ($bundles -notcontains $packageName) { $bundles += $packageName }
  if ($null -eq $json.dependencies) {
    $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
  }
  $plugin = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'plugin'
  $json.dependencies | Add-Member -NotePropertyName $packageName -NotePropertyValue "file:$plugin" -Force
}

$json.dsh.profile.bundles = $bundles
[System.IO.File]::WriteAllText($manifest, ($json | ConvertTo-Json -Depth 10) + "`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host "profile  : $Profile"
Write-Host "manifest : $manifest (backup: $(Split-Path $backup -Leaf))"
Write-Host "bundles  : $($bundles -join ', ')"
if ($Off) {
  Write-Host 'plugin is OFF. Start the app to confirm it boots without it.' -ForegroundColor Yellow
} else {
  Write-Host 'plugin is ON. Start the app and open the tree.' -ForegroundColor Green
}
