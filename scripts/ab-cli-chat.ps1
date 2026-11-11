#!/usr/bin/env pwsh
<#
.SYNOPSIS
在两个 DSH profile 里跑完全相同的多轮对话，并保存每轮的事件与最终回答。

.DESCRIPTION
每个 profile 都新开一个 session，然后按 $Dialogue 的顺序逐条调用 headless CLI：
第一条不带 --session-id，拿到 sessionId 后，后续每条都用 --session-id 续聊。
两个 profile 使用同一个 $Dialogue，不插入任何额外提示。

.EXAMPLE
$env:DEEPSEEK_API_KEY = 'sk-...'
pwsh scripts/ab-cli-chat.ps1

.EXAMPLE
pwsh scripts/ab-cli-chat.ps1 -DryRun
# 只打印将要执行的命令，不调用模型
#>
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 对话列表：两个 profile 会逐字执行这里完全相同的内容。
# ---------------------------------------------------------------------------
$Dialogue = @(
  '你好，请用一句话介绍你自己。'
  '我朋友很喜欢苹果',
  '介绍一下常用的匹配算法',
  '详细说一下kmp',
  '详细说一下trie',
  'trie的fail指针是什么意思',
  '3d是怎么实现近大远小的？就是在看一条路时越远越窄',
  '给出glsl的一个具体实现',
  '介绍一下bm25算法',
  'cpp的lower_bound和upper_bound是怎么用的',
  '算法竞赛中常用的gcc内置函数都有哪些，尤其是位运算的',
  '生成一份算法竞赛常用的数学板子',
  '它包含组合数相关的吗',
  'ts中的NaN一般什么时候才会出现',
  'mjs和普通js的区别在哪？写法上需要注意什么吗？'
  '以下对话都在1000字以内回答',
  '介绍一下本机上的插件D:\\dsh-token-tree',
  '生成一份适合写在科研简历里面的包含 为了什么目标而用什么做什么 的介绍',
  '现在取消1000字的限制吧',
  '我朋友问我明天想吃什么早饭。你推荐推荐',
  'trie的fail指针和KMP的next数组是什么关系？',
  '能再说一遍组合数公式吗'
)

# 两个 profile 名（PowerShell 常量，脚本开头固定）。
Set-Variable -Name PROFILE_A -Value 'ab-base' -Option Constant
Set-Variable -Name PROFILE_B -Value 'ab-tokentree' -Option Constant

# ---------------------------------------------------------------------------
# 以下通常不用改。
# ---------------------------------------------------------------------------
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutputRoot = Join-Path $env:TEMP "dsh-cli-ab\$Stamp"

# 优先使用 PATH 上的 dsh；找不到时回退到桌面安装位置。
$Dsh = (Get-Command dsh -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if ([string]::IsNullOrWhiteSpace($Dsh)) {
  $Dsh = 'C:\Users\ASUS\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
}
if (-not (Test-Path $Dsh)) {
  throw "找不到 dsh CLI：$Dsh"
}

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
foreach ($profile in @($PROFILE_A, $PROFILE_B)) {
  $profileDir = Join-Path $DshHome "profiles\$profile"
  if (-not (Test-Path $profileDir)) {
    throw "profile 不存在：$profile（$profileDir）"
  }
}

if (-not $env:DEEPSEEK_API_KEY -and -not $DryRun) {
  Write-Warning 'DEEPSEEK_API_KEY 没有设置；CLI 很可能会报 MISSING_CREDENTIAL。'
}

if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $OutputRoot | Out-Null
}

function ConvertTo-Events {
  param([object[]]$Lines)
  foreach ($line in @($Lines)) {
    if ([string]::IsNullOrWhiteSpace([string]$line)) { continue }
    try {
      $line | ConvertFrom-Json
    } catch {
      # CLI 的正常诊断写到 stderr；stdout 理论上只有 JSON，忽略异常行。
    }
  }
}

function Get-FinalText {
  param([object[]]$Events)
  $final = @($Events | Where-Object { $_.type -eq 'final' }) | Select-Object -Last 1
  if ($null -eq $final) { return '' }
  if ($final.reason -and $final.reason.kind -eq 'error') {
    $message = $final.reason.error.message
    throw "模型调用失败：$message"
  }
  return [string]$final.text
}

function Invoke-Dialogue {
  param(
    [string]$Profile,
    [string[]]$Messages
  )

  $profileDir = Join-Path $OutputRoot $Profile
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  }

  $sessionId = $null
  $turns = @()

  for ($index = 0; $index -lt $Messages.Count; $index++) {
    $message = $Messages[$index]
    $number = $index + 1

    $cliArgs = @('--profile', $Profile, '--json')
    if ($null -ne $sessionId) {
      $cliArgs += @('--session-id', $sessionId)
    }
    $cliArgs += $message

    Write-Host ("[{0}] 第 {1}/{2} 轮：{3}" -f $Profile, $number, $Messages.Count, $message)

    if ($DryRun) {
      Write-Host ("  dsh " + ($cliArgs -join ' '))
      continue
    }

    $stdoutFile = Join-Path $profileDir ('{0:D2}.jsonl' -f $number)
    $stderrFile = Join-Path $profileDir ('{0:D2}.stderr.log' -f $number)

    # stdout 是 NDJSON；stderr 单独落盘，避免污染 JSON 解析。
    # Windows PowerShell 会把原生命令的 stderr 包装成 ErrorRecord；全局 Stop 会在
    # llm-deepseek-api-key 打印“model listing ...”时直接终止。只在这次调用期间放宽。
    # 同时必须把控制台解码切到 UTF-8：否则 dsh 的 UTF-8 JSON 会按 GBK 解码，
    # 中文字符串会被破坏，ConvertFrom-Json 直接报 Unterminated string。
    $previousErrorAction = $ErrorActionPreference
    $previousOutputEncoding = [Console]::OutputEncoding
    try {
      $ErrorActionPreference = 'Continue'
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      $stdout = & $Dsh @cliArgs 2> $stderrFile
      $exitCode = $LASTEXITCODE
    } finally {
      [Console]::OutputEncoding = $previousOutputEncoding
      $ErrorActionPreference = $previousErrorAction
    }

    [System.IO.File]::WriteAllLines($stdoutFile, [string[]]$stdout, [System.Text.UTF8Encoding]::new($false))
    $events = @(ConvertTo-Events -Lines $stdout)

    if ($null -eq $sessionId) {
      $sessionEvent = @($events | Where-Object { $_.type -eq 'session' }) | Select-Object -First 1
      if ($null -eq $sessionEvent) {
        throw "[$Profile] 第一条消息没有返回 sessionId，见 $stdoutFile"
      }
      $sessionId = [string]$sessionEvent.sessionId
    }

    $answer = ''
    try {
      $answer = Get-FinalText -Events $events
    } catch {
      if ($exitCode -ne 0) {
        $stderr = if (Test-Path $stderrFile) { Get-Content $stderrFile -Raw } else { '' }
        throw "[$Profile] 第 $number 轮失败（exit $exitCode）：$($_.Exception.Message)`n$stderr"
      }
      throw
    }

    if ($exitCode -ne 0) {
      $stderr = if (Test-Path $stderrFile) { Get-Content $stderrFile -Raw } else { '' }
      throw "[$Profile] 第 $number 轮失败（exit $exitCode）：$stderr"
    }

    $turns += [pscustomobject]@{
      index   = $number
      user    = $message
      answer  = $answer
      session = $sessionId
    }
    Write-Host ("  -> {0}" -f (($answer -replace '\s+', ' ').Trim()))
  }

  if ($DryRun) { return }

  $transcript = foreach ($turn in $turns) {
    "## 第 $($turn.index) 轮`n`n**User**`n`n$($turn.user)`n`n**Assistant**`n`n$($turn.answer)`n"
  }
  [System.IO.File]::WriteAllText((Join-Path $profileDir 'transcript.md'), ($transcript -join "`n---`n`n"), [System.Text.UTF8Encoding]::new($false))

  [System.IO.File]::WriteAllText((Join-Path $profileDir 'turns.json'), ($turns | ConvertTo-Json -Depth 10), [System.Text.UTF8Encoding]::new($false))

  return [pscustomobject]@{
    profile   = $Profile
    sessionId = $sessionId
    turns     = $turns
    directory = $profileDir
  }
}

$results = @()
foreach ($profile in @($PROFILE_A, $PROFILE_B)) {
  $results += Invoke-Dialogue -Profile $profile -Messages $Dialogue
}

if ($DryRun) {
  Write-Host "Dry run：$($Dialogue.Count) 条消息 × 2 个 profile；未创建目录。"
  return
}

$summary = $results | ForEach-Object {
  [pscustomobject]@{
    profile   = $_.profile
    sessionId = $_.sessionId
    turns     = $_.turns.Count
    directory = $_.directory
  }
}
$summary | Format-Table -AutoSize

Write-Host ''
Write-Host 'Session IDs'
foreach ($result in $results) {
  Write-Host ("{0}: {1}" -f $result.profile, $result.sessionId)
}

Write-Host "结果目录：$OutputRoot"
