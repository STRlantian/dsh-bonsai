# A/B harness: same prompts, one profile with the plugin, one without.
#
# Creates two standalone profiles under the real DSH home (so credentials resolve
# exactly as they do for the desktop app), installs dsh-bonsai into the "on"
# profile only, then runs the same six prompts through both, chaining a single
# session per profile so prompt-cache counters accumulate across turns.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ab-run.ps1
#   ... -Turns 4 -SkipInstall     # reuse existing profiles

param(
  [string]$ProfileOff = 'aboff',
  [string]$ProfileOn = 'abon',
  [int]$Turns = 6,
  [switch]$SkipInstall,
  [string]$DshPath = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($DshPath)) {
  $candidates = @(
    'C:\Users\ASUS\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\.bin\dsh.cmd',
    'C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  )
  $DshPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not (Test-Path $DshPath)) { Write-Error 'no dsh CLI found'; exit 2 }

$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

# One topic so answers stay short and comparable; each prompt builds on the last.
$prompts = @(
  '用一句话解释什么是哈希表。',
  '它和数组的区别是什么？一句话。',
  '负载因子是什么意思？一句话。',
  '开放寻址法怎么解决冲突？一句话。',
  '为什么哈希表查询平均是 O(1)？一句话。',
  '把前五问的结论合成三行。'
)
if ($Turns -lt $prompts.Count) { $prompts = $prompts[0..($Turns - 1)] }

function Ensure-Profile([string]$name) {
  $dir = Join-Path $homeDir "profiles\$name"
  if (Test-Path $dir) { return }
  Write-Host "creating profile $name"
  & $DshPath --profile $name --from-default-profile headless --dump-config 2>&1 | Out-Null
}

function Newest-Session([string]$since) {
  $base = Join-Path $homeDir 'sessions'
  $best = $null
  foreach ($workspace in Get-ChildItem $base -Directory -ErrorAction SilentlyContinue) {
    foreach ($session in Get-ChildItem $workspace.FullName -Directory -ErrorAction SilentlyContinue) {
      if ($session.LastWriteTime -lt $since) { continue }
      if ($null -eq $best -or $session.LastWriteTime -gt $best.LastWriteTime) { $best = $session }
    }
  }
  return $best
}

function Run-Conversation([string]$profile) {
  Write-Host "`n=== $profile ==="
  $started = Get-Date
  $sessionId = $null
  $index = 0
  foreach ($prompt in $prompts) {
    $index++
    if ($null -eq $sessionId) {
      $output = & $DshPath --profile $profile $prompt 2>&1
      $code = $LASTEXITCODE
    } else {
      $output = & $DshPath --profile $profile --session-id $sessionId $prompt 2>&1
      $code = $LASTEXITCODE
    }
    if ($code -ne 0) {
      Write-Host "  turn ${index}: FAILED"
      $output | Select-Object -Last 4 | ForEach-Object { Write-Host "    $_" }
      return $null
    }
    $answer = ($output | Out-String).Trim()
    $short = if ($answer.Length -gt 60) { $answer.Substring(0, 60) + '…' } else { $answer }
    Write-Host "  turn ${index}: $short"
    if ($null -eq $sessionId) {
      $dir = Newest-Session $started
      if ($null -eq $dir) { Write-Host '  could not locate the session directory'; return $null }
      $sessionId = $dir.Name
      Write-Host "  session: $sessionId"
    }
  }
  return $sessionId
}

Ensure-Profile $ProfileOff
Ensure-Profile $ProfileOn

if (-not $SkipInstall) {
  Write-Host "installing the plugin into $ProfileOn"
  & $DshPath plugin --profile $ProfileOn add "file:$root\plugin" 2>&1 | Select-Object -Last 2 | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Error 'install failed'; exit 1 }
}

$off = Run-Conversation $ProfileOff
$on = Run-Conversation $ProfileOn

Write-Host "`n=== sessions ==="
Write-Host "off: $off"
Write-Host "on : $on"

if ($null -eq $off -or $null -eq $on) { exit 1 }
exit 0
