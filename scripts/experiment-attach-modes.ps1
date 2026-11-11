param(
  [string]$Profile = 'ab-tokentree',
  [double]$OutputPriceRatio = 2.0,
  [string]$ApiKey = $env:DEEPSEEK_API_KEY,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Dsh = 'C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$Dialogue = @(
  '你好，请用一句话介绍你自己。'
  '我朋友很喜欢苹果'
  '介绍一下常用的匹配算法'
  '详细说一下kmp'
  '那它的复杂度是多少'
  '和bm算法比呢'
  '早餐吃什么比较好'
  '我昨天买了香蕉和燕麦'
  '给我一个简单的早餐搭配'
  '为什么香蕉适合早餐'
  '那燕麦呢'
  '怎么挑选燕麦'
  '即食燕麦和钢切燕麦有什么区别'
  '钢切燕麦怎么煮'
  '需要提前泡吗'
  '不泡会怎么样'
  '那用压力锅呢'
  '压力锅和普通锅的时间差多少'
  '再说说匹配算法里的ac自动机'
  '它和kmp有什么关系'
  '多模式匹配还有哪些算法'
  '最后总结一下今天聊的几条线'
)

$Arms = @(
  @{ name = 'tool';   mode = 'tool'   },
  @{ name = 'marker'; mode = 'marker' },
  @{ name = 'local';  mode = 'local'  }
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  if (-not $DryRun) {
    Write-Warning 'DEEPSEEK_API_KEY 未设置；如果 profile 里也没有存储凭据，CLI 会报 MISSING_CREDENTIAL。'
  }
} else {
  # 只传给子进程，不写进脚本，也不打印。
  $env:DEEPSEEK_API_KEY = $ApiKey
}

if ($DryRun) {
  Write-Host "Dry run：$($Dialogue.Count) 条消息 × $($Arms.Count) 个模式（tool / marker / local）"
  Write-Host "profile=$Profile outputPriceRatio=$OutputPriceRatio"
  return
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = Join-Path $env:TEMP "dsh-attach-modes\$stamp"
New-Item -ItemType Directory -Path $root -Force | Out-Null

$utf8 = [System.Text.UTF8Encoding]::new($false)
$previousOutputEncoding = [Console]::OutputEncoding
$results = @()

function Write-Utf8NoBom([string]$Path, [string[]]$Lines) {
  [System.IO.File]::WriteAllLines($Path, $Lines, $utf8)
}

foreach ($arm in $Arms) {
  $dir = Join-Path $root $arm.name
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $patch = Join-Path $dir 'attach-mode.patch.yml'
  [System.IO.File]::WriteAllText($patch,
    "- id: token-tree`n  config:`n    attachMode: $($arm.mode)`n", $utf8)

  $sessionId = $null
  $turns = @()
  $sum = @{ input = 0; cache = 0; write = 0; output = 0; steps = 0; tools = 0; attach = 0 }

  for ($i = 0; $i -lt $Dialogue.Count; $i++) {
    $number = $i + 1
    $jsonl = Join-Path $dir ('{0:D2}.jsonl' -f $number)
    $stderr = Join-Path $dir ('{0:D2}.stderr.log' -f $number)
    $cliArgs = @('--profile', $Profile, '--patch', $patch, '--json')
    if ($null -ne $sessionId) { $cliArgs += @('--session-id', $sessionId) }
    $cliArgs += $Dialogue[$i]

    $prevAction = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      [Console]::OutputEncoding = $utf8
      $stdout = & $Dsh @cliArgs 2> $stderr
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousOutputEncoding
      $ErrorActionPreference = $prevAction
    }
    Write-Utf8NoBom $jsonl ([string[]]$stdout)

    $events = @()
    foreach ($line in $stdout) {
      $text = ([string]$line).TrimStart([char]0xFEFF).Trim()
      if ($text -eq '') { continue }
      try { $events += ($text | ConvertFrom-Json) }
      catch { throw "[$($arm.name) #$number] 无效 JSON：$($_.Exception.Message)`n$text" }
    }

    if ($null -eq $sessionId) {
      $sessionEvent = @($events | Where-Object { $_.type -eq 'session' }) | Select-Object -First 1
      if ($null -eq $sessionEvent) { throw "[$($arm.name) #$number] 没有 session 事件" }
      $sessionId = [string]$sessionEvent.sessionId
    }

    $final = @($events | Where-Object { $_.type -eq 'final' }) | Select-Object -Last 1
    if ($null -eq $final) { throw "[$($arm.name) #$number] 没有 final 事件（exit=$exitCode）" }
    if ($final.reason.kind -eq 'error') {
      throw "[$($arm.name) #$number] 模型错误：$($final.reason.error.message)"
    }

    $answer = [string]$final.text
    $usage = @($events | Where-Object { $_.type -eq 'status' -and $_.phase -eq 'step_end' })
    $toolCalls = @($events | Where-Object { $_.type -eq 'tool_call' })
    $attachCalls = @($toolCalls | Where-Object { $_.tool -eq 'tree_attach' }).Count
    $sum.steps += $usage.Count
    $sum.tools += $toolCalls.Count
    $sum.attach += $attachCalls
    foreach ($step in $usage) {
      $u = $step.usage
      if ($null -eq $u) { continue }
      $sum.input += if ($null -ne $u.inputTokens) { [int]$u.inputTokens } else { 0 }
      $sum.cache += if ($null -ne $u.cacheReadTokens) { [int]$u.cacheReadTokens } else { 0 }
      $sum.write += if ($null -ne $u.cacheWriteTokens) { [int]$u.cacheWriteTokens } else { 0 }
      $sum.output += if ($null -ne $u.outputTokens) { [int]$u.outputTokens } else { 0 }
    }

    $markers = ([regex]::Matches($answer, '\[attach:')).Count
    $turns += [pscustomobject]@{
      index = $number
      user = $Dialogue[$i]
      answer = $answer
      markers = $markers
      toolCalls = $toolCalls.Count
      steps = $usage.Count
    }
    $preview = (($answer -replace '\s+', ' ').Trim())
    if ($preview.Length -gt 100) { $preview = $preview.Substring(0, 100) + '...' }
    Write-Host ("[{0}] {1}/{2} markers={3} tools={4} -> {5}" -f $arm.name, $number, $Dialogue.Count, $markers, $toolCalls.Count, $preview)
  }

  $promptCost = [double]$sum.input + [double]$sum.cache * 0.02 + [double]$sum.write
  $totalCost = $promptCost + [double]$sum.output * $OutputPriceRatio
  $result = [pscustomobject]@{
    arm = $arm.name
    mode = $arm.mode
    sessionId = $sessionId
    turns = $turns.Count
    steps = $sum.steps
    input = $sum.input
    cacheRead = $sum.cache
    cacheWrite = $sum.write
    output = $sum.output
    markers = ($turns | Measure-Object markers -Sum).Sum
    tools = $sum.tools
    attachCalls = $sum.attach
    promptCost = [Math]::Round($promptCost, 2)
    totalCost = [Math]::Round($totalCost, 2)
  }
  $results += $result
  $result | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $dir 'summary.json') -Encoding utf8
  $result | Export-Csv -Path (Join-Path $dir 'summary.csv') -NoTypeInformation -Encoding utf8
}

$summary = $results | Select-Object arm, turns, steps, input, cacheRead, output, markers, attachCalls, tools, promptCost, totalCost
$summary | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

Write-Host ''
Write-Host 'Session IDs'
foreach ($result in $results) {
  Write-Host ("{0}: {1}" -f $result.arm, $result.sessionId)
}
Write-Host "结果目录：$root"
Write-Host "成本口径：prompt = input + cacheRead*0.02 + cacheWrite；total = prompt + output*$OutputPriceRatio（相对单位，不是美元）"
