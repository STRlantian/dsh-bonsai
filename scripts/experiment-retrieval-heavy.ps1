param(
  [string]$Profile = 'ab-tokentree',
  [string]$DataPath = '',
  [string[]]$AttachModes = @('local', 'marker', 'tool'),
  [string]$PermissionMode = 'read-only',
  [string]$DshPath = '',
  [switch]$DryRun
)

# Retrieval-heavy A/B: local heuristic vs marker vs tree_attach.
# Every turn is a separate headless process, but all turns of one arm share one Session, so the
# tree and the prompt cache evolve exactly as they would in a normal conversation.
#
# The API key comes from the environment. Headless mounts the credentials service, and that
# service reads the managed file before the launch environment, so the key is also seeded into
# the isolated DSH_HOME below. The real ~/.dsh credentials file is never modified.

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$repoRoot = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($DataPath)) {
  $DataPath = Join-Path $repoRoot 'docs\experiments\retrieval-heavy.json'
}
if (-not (Test-Path -LiteralPath $DataPath)) {
  throw "data file not found: $DataPath"
}

$json = Get-Content -LiteralPath $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json
$dialogue = @($json.dialogue)
if ($dialogue.Count -ne [int]$json.turns) {
  throw "turn count mismatch: JSON says $($json.turns), dialogue has $($dialogue.Count)"
}
if (@($json.checks).Count -eq 0) {
  throw 'the data file has no checks'
}

$modes = @(
  $AttachModes |
    ForEach-Object { ([string]$_ -split '[,;]') } |
    ForEach-Object { $_.Trim().ToLowerInvariant() } |
    Where-Object { $_ -ne '' } |
    Select-Object -Unique
)
if ($modes.Count -eq 0) { throw 'AttachModes is empty' }
foreach ($mode in $modes) {
  if ($mode -notin @('local', 'marker', 'tool')) {
    throw "unknown attach mode '$mode'; expected local, marker, or tool"
  }
}

if ([string]::IsNullOrWhiteSpace($DshPath)) {
  $known = 'C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  if (Test-Path -LiteralPath $known) {
    $DshPath = $known
  } else {
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw 'dsh not found; pass -DshPath or put dsh on PATH' }
    $DshPath = $command.Source
  }
}
if (-not (Test-Path -LiteralPath $DshPath)) {
  throw "dsh not found: $DshPath"
}

# The headless app needs --json. Refuse a web profile before spending an API call.
$realDshHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  Join-Path $env:USERPROFILE '.dsh'
} else {
  $env:DSH_HOME
}
$profilePackage = Join-Path $realDshHome "profiles\$Profile\package.json"
if (-not (Test-Path -LiteralPath $profilePackage)) {
  throw "profile '$Profile' not found at $profilePackage"
}
$profileConfig = Get-Content -LiteralPath $profilePackage -Raw -Encoding UTF8 | ConvertFrom-Json
$bundles = @($profileConfig.dsh.profile.bundles)
if ($bundles -notcontains '@deepseek-ai/dsh-headless') {
  throw "profile '$Profile' is not headless; CLI --json needs @deepseek-ai/dsh-headless"
}
if ($bundles -contains '@deepseek-ai/dsh-web-app') {
  throw "profile '$Profile' is a web profile; use a headless profile (default ab-tokentree)"
}
$profileTarget = Join-Path $realDshHome "profiles\$Profile"
if (-not (Test-Path -LiteralPath $profileTarget)) {
  throw "profile directory not found: $profileTarget"
}

if ($DryRun) {
  Write-Host "Dry run: $($dialogue.Count) turns × $($modes.Count) arm(s): $($modes -join ', ')"
  Write-Host "profile=$Profile · permission=$PermissionMode · checks=$(@($json.checks).Count)"
  Write-Host 'patch: foldPolicy=always foldKeepTurns=1 candidateSource=retrieve attachMode varies per arm'
  return
}

$apiKey = $env:DEEPSEEK_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'DEEPSEEK_API_KEY is empty in this PowerShell process; set it in the same window before running'
}
# A copied key often carries a trailing newline or wrapping quotes.
$apiKey = $apiKey.Trim().Trim('"').Trim("'")
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'DEEPSEEK_API_KEY is empty after trimming'
}
# Write the normalized value back so the child receives the same key we read.
$env:DEEPSEEK_API_KEY = $apiKey

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = Join-Path $env:TEMP "dsh-retrieval-heavy\$stamp"
New-Item -ItemType Directory -Path $root -Force | Out-Null

# Isolate the plugin's settings and session logs. The live ~/.dsh/token-tree/settings.json
# overrides profile config, which would silently defeat the test patch.
$tempHome = Join-Path $env:TEMP ("dsh-retrieval-home-" + $stamp)
New-Item -ItemType Directory -Path (Join-Path $tempHome 'profiles') -Force | Out-Null
$profileLink = Join-Path $tempHome "profiles\$Profile"
New-Item -ItemType Junction -Path $profileLink -Target $profileTarget | Out-Null

$tokenTreeHome = Join-Path $tempHome 'token-tree'
New-Item -ItemType Directory -Path $tokenTreeHome -Force | Out-Null

# credentials-local reads $DSH_HOME/.credentials.yaml before the launch environment when that
# service is mounted. ab-tokentree disables it, so the environment is the active path; seeding the
# file keeps the script correct for profiles that do mount it. The temp home is removed in finally.
$credentialYaml = "version: 1`nrefs:`n  DEEPSEEK_API_KEY: $($apiKey | ConvertTo-Json -Compress)`nrecords: {}`n"
[System.IO.File]::WriteAllText((Join-Path $tempHome '.credentials.yaml'), $credentialYaml, $utf8NoBom)
Write-Host 'API key: from DEEPSEEK_API_KEY'

$tempSettings = Join-Path $tokenTreeHome 'settings.json'
$testToolDeny = @('read', 'write', 'edit', 'glob', 'grep', 'pwsh')

function Write-TestSettings {
  $document = [ordered]@{
    toolDeny = $testToolDeny
  }
  [System.IO.File]::WriteAllText($tempSettings, ($document | ConvertTo-Json -Depth 6), $utf8NoBom)
}

Write-TestSettings

$previousDshHome = $env:DSH_HOME
$previousOutputEncoding = [Console]::OutputEncoding
$env:DSH_HOME = $tempHome
$summary = @()
$allOutputs = @{}

try {
  [Console]::OutputEncoding = $utf8NoBom

  foreach ($mode in $modes) {
    $armDir = Join-Path $root $mode
    New-Item -ItemType Directory -Path $armDir -Force | Out-Null
    # DSH binds a Session to its creation cwd, so every turn of one arm must run in the same
    # directory. Per-turn isolation is still enforced by toolDeny, not by changing cwd.
    $armCwd = Join-Path $armDir 'cwd'
    New-Item -ItemType Directory -Path $armCwd -Force | Out-Null
    $patch = Join-Path $armDir 'retrieval-heavy.patch.yml'
    # A second patch entry for the same id replaces the whole config object, so fold/retrieve
    # settings would silently disappear. Put attachMode into the one base entry instead.
    $modeChoices = 10
    $patchText = [string]$json.setup.patch
    $patchText = [regex]::Replace($patchText, '(?m)^[ \t]*attachChoices:[ \t]*\d+[ \t]*\r?\n?', '')
    $patchText = $patchText.TrimEnd() + "`n    candidateSource: retrieve`n    attachMode: $mode`n    attachChoices: $modeChoices`n"
    foreach ($key in @('foldPolicy', 'foldKeepTurns', 'candidateSource', 'attachMode', 'attachChoices')) {
      $count = ([regex]::Matches($patchText, "(?m)^[ \t]*${key}:")).Count
      if ($count -ne 1) { throw "generated patch has $count '$key' entries; expected exactly one (config merge is broken)" }
    }
    [System.IO.File]::WriteAllText($patch, $patchText, $utf8NoBom)

    $session = $null
    $answers = @{}
    $armOutputs = @{}
    $retrieveCalls = 0
    $retrieveQueries = 0
    $retrieveNodeIds = 0
    $attachCalls = 0
    $markerAttachCalls = 0
    $summaryMarkers = 0
    $steps = 0
    $inputTokens = 0
    $cacheReadTokens = 0
    $cacheWriteTokens = 0
    $outputTokens = 0

    for ($i = 0; $i -lt $dialogue.Count; $i++) {
      $number = $i + 1
      $turnDir = Join-Path $armDir ('turn-{0:D2}' -f $number)
      New-Item -ItemType Directory -Path $turnDir -Force | Out-Null
      $stderrPath = Join-Path $turnDir 'stderr.txt'

      $cliArgs = @('--profile', $Profile, '--patch', $patch, '--permission-mode', $PermissionMode, '--json')
      if ($null -ne $session) { $cliArgs += @('--session-id', $session) }
      $cliArgs += [string]$dialogue[$i]

      Push-Location $armCwd
      try {
        $previousAction = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          $stdout = & $DshPath @cliArgs 2> $stderrPath
          $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
        } finally {
          $ErrorActionPreference = $previousAction
        }
      } finally {
        Pop-Location
      }

      if ($exitCode -ne 0) {
        $stderrText = ''
        if (Test-Path -LiteralPath $stderrPath) {
          $stderrText = [System.IO.File]::ReadAllText($stderrPath, $utf8NoBom)
        }
        $stderrText = ([string]$stderrText).Trim()
        $stdoutText = (@($stdout) -join "`n").Trim()
        if ($stderrText.Length -gt 1200) {
          $stderrText = '…' + $stderrText.Substring($stderrText.Length - 1200)
        }
        if ($stdoutText.Length -gt 1200) {
          $stdoutText = '…' + $stdoutText.Substring($stdoutText.Length - 1200)
        }
        $parts = @()
        if ($stderrText -ne '') { $parts += "stderr:`n$stderrText" }
        if ($stdoutText -ne '') { $parts += "stdout:`n$stdoutText" }
        if ($parts.Count -eq 0) { $parts += "stderr/stdout empty; full args in $turnDir" }
        throw "[$mode #$number] dsh exit $exitCode`n$($parts -join "`n")"
      }

      $lines = @($stdout | ForEach-Object { ([string]$_).TrimStart([char]0xFEFF) })
      $armOutputs[$number] = $lines

      $events = @()
      foreach ($line in $lines) {
        $text = ([string]$line).Trim()
        if ($text -eq '') { continue }
        try {
          $events += ($text | ConvertFrom-Json)
        } catch {
          throw "[$mode #$number] invalid JSON: $($_.Exception.Message)`n$text"
        }
      }

      if ($null -eq $session) {
        $sessionEvent = @($events | Where-Object { $_.type -eq 'session' }) | Select-Object -First 1
        if ($null -eq $sessionEvent) { throw "[$mode #$number] no session event" }
        $session = [string]$sessionEvent.sessionId
      }

      $final = @($events | Where-Object { $_.type -eq 'final' }) | Select-Object -Last 1
      if ($null -eq $final) { throw "[$mode #$number] no final event (exit=$exitCode)" }
      if ($null -ne $final.reason -and $final.reason.kind -eq 'error') {
        throw "[$mode #$number] model error: $($final.reason.error.message)"
      }

      $answer = [string]$final.text
      $answers[$number] = $answer
      $markerAttachCalls += ([regex]::Matches($answer, '\[attach:')).Count
      $summaryMarkers += ([regex]::Matches($answer, '\[summary:')).Count

      $toolCalls = @($events | Where-Object { $_.type -eq 'tool_call' })
      foreach ($call in @($toolCalls | Where-Object { $_.tool -eq 'retrieve_context' })) {
        $retrieveCalls++
        $input = $call.input
        if ($null -ne $input -and $input.PSObject.Properties.Name -contains 'nodeId' -and -not [string]::IsNullOrWhiteSpace([string]$input.nodeId)) {
          $retrieveNodeIds++
        } else {
          $retrieveQueries++
        }
      }
      $attachCalls += @($toolCalls | Where-Object { $_.tool -eq 'tree_attach' }).Count

      $stepEnds = @($events | Where-Object { $_.type -eq 'status' -and $_.phase -eq 'step_end' })
      $steps += $stepEnds.Count
      foreach ($stepEnd in $stepEnds) {
        $usage = $stepEnd.usage
        if ($null -eq $usage) { continue }
        if ($null -ne $usage.inputTokens) { $inputTokens += [int]$usage.inputTokens }
        if ($null -ne $usage.cacheReadTokens) { $cacheReadTokens += [int]$usage.cacheReadTokens }
        if ($null -ne $usage.cacheWriteTokens) { $cacheWriteTokens += [int]$usage.cacheWriteTokens }
        if ($null -ne $usage.outputTokens) { $outputTokens += [int]$usage.outputTokens }
      }

      $preview = if ([string]::IsNullOrWhiteSpace($answer)) {
        '(empty final.text)'
      } else {
        $flat = $answer -replace '\s+', ' '
        $flat.Substring(0, [Math]::Min(80, $flat.Length))
      }
      Write-Host ("[{0} {1}/{2}] {3}" -f $mode, $number, $dialogue.Count, $preview)
    }

    $allOutputs[$mode] = $armOutputs

    if ($mode -ne 'tool' -and $attachCalls -gt 0) {
      throw "[$mode] tree_attach was called $attachCalls time(s); the tool must not be registered outside tool mode (is the plugin build current?)"
    }
    if ($mode -eq 'local' -and $markerAttachCalls -gt 0) {
      throw "[local] emitted $markerAttachCalls attach marker(s); local must not participate in attachment"
    }

    $score = 0
    $total = 0
    $missing = @()
    foreach ($check in @($json.checks)) {
      $turn = [int]$check.turn
      $normalizedAnswer = ([string]$answers[$turn]) -replace '\s+', ''
      $factsPresent = $true
      foreach ($fact in @($check.must)) {
        $total++
        $normalizedFact = ([string]$fact) -replace '\s+', ''
        if ($normalizedAnswer.Contains($normalizedFact)) {
          $score++
        } else {
          $factsPresent = $false
          $missing += "T${turn}:$fact"
        }
      }
      if ($check.ordered -eq $true -and $factsPresent) {
        $positions = @()
        $orderedOk = $true
        foreach ($fact in @($check.must)) {
          $index = $normalizedAnswer.IndexOf((([string]$fact) -replace '\s+', ''))
          if ($index -lt 0) { $orderedOk = $false; break }
          $positions += $index
        }
        if ($orderedOk) {
          for ($j = 1; $j -lt $positions.Count; $j++) {
            if ($positions[$j] -le $positions[$j - 1]) { $orderedOk = $false; break }
          }
        }
        if (-not $orderedOk) {
          $score--
          $missing += "T${turn}:order"
        }
      }
    }

    $summary += [pscustomobject]@{
      arm = $mode
      sessionId = $session
      score = $score
      total = $total
      accuracy = if ($total -eq 0) { 0 } else { [Math]::Round($score / $total, 4) }
      retrieveCalls = $retrieveCalls
      retrieveQueries = $retrieveQueries
      retrieveNodeIds = $retrieveNodeIds
      attachCalls = $attachCalls
      markerAttachCalls = $markerAttachCalls
      summaryMarkers = $summaryMarkers
      steps = $steps
      inputTokens = $inputTokens
      cacheReadTokens = $cacheReadTokens
      cacheWriteTokens = $cacheWriteTokens
      outputTokens = $outputTokens
      missing = ($missing -join '; ')
    }
  }
} finally {
  $env:DSH_HOME = $previousDshHome
  [Console]::OutputEncoding = $previousOutputEncoding
  # A junction must be removed as a link, never with Remove-Item -Recurse, or cleanup can follow
  # it into the real profile and delete node_modules.
  if ($null -ne $profileLink -and (Test-Path -LiteralPath $profileLink)) {
    & cmd.exe /c rmdir "$profileLink" | Out-Null
  }
  if ($null -ne $tempHome -and (Test-Path -LiteralPath $tempHome) -and
      ($null -eq $profileLink -or -not (Test-Path -LiteralPath $profileLink))) {
    Remove-Item -LiteralPath $tempHome -Recurse -Force -ErrorAction SilentlyContinue
  }
}

foreach ($mode in $allOutputs.Keys) {
  $armDir = Join-Path $root $mode
  foreach ($number in @($allOutputs[$mode].Keys | Sort-Object)) {
    $jsonl = Join-Path $armDir ('{0:D2}.jsonl' -f [int]$number)
    [System.IO.File]::WriteAllLines($jsonl, [string[]]$allOutputs[$mode][$number], $utf8NoBom)
  }
}

$summary | Format-Table -Property arm, score, total, accuracy, retrieveCalls, retrieveQueries, retrieveNodeIds, attachCalls, markerAttachCalls, summaryMarkers, steps, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens -AutoSize
$summaryPath = Join-Path $root 'summary.json'
[System.IO.File]::WriteAllText($summaryPath, ($summary | ConvertTo-Json -Depth 5), $utf8NoBom)
Write-Host ''
Write-Host "result=$root"
Write-Host "summary=$summaryPath"
foreach ($row in $summary) {
  Write-Host ("{0}: session={1} accuracy={2}/{3} retrieve={4} toolAttach={5} markerAttach={6}" -f $row.arm, $row.sessionId, $row.score, $row.total, $row.retrieveCalls, $row.attachCalls, $row.markerAttachCalls)
}
