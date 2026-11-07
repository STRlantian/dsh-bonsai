#!/usr/bin/env node
/** Live three-arm A/B: no plugin, default, aggressive; same tool visibility. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const exe = 'C:/Users/ASUS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
const cli = 'C:/Users/ASUS/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const settingsPath = join(dshHome, 'token-tree', 'settings.json')
const apiKey = process.env.DEEPSEEK_API_KEY
if (apiKey === undefined || apiKey === '') throw new Error('set DEEPSEEK_API_KEY before running this A/B')

const defaultSettings = {
  autoInject: false, retrievalHint: true, autoReflect: true,
  attachChoices: 10, attachSummary: true, toolDeny: [],
  foldAboveTokens: 30000, foldKeepTurns: 2, foldScope: 'turns',
  foldBlockRatio: 8, foldCadence: 10, hintAboveTokens: 30000,
}
const aggressiveSettings = {
  ...defaultSettings, foldAboveTokens: 10000, foldKeepTurns: 1,
  foldBlockRatio: 5, foldCadence: 3, fileRegion: 'digest', mandatoryContext: true,
}

const facts = [
  '项目代号是青松；数据库是 SQLite，文件名 data/qingsong.db。',
  '接口前缀是 /api/v3；认证算法是 HMAC-SHA256，时钟容差 30 秒。',
  '部署目录是 /srv/qingsong；日志保留 14 天；缓存用内存 LRU，容量 512 条。',
  '限流是每分钟每 IP 60 次；备份每天 03:15 执行；时区固定 Asia/Shanghai。',
  '前端是 Vue 3 + Vite；错误码从 40001 开始；告警发到 ops@qingsong.dev。',
  '数据库连接池上限 20；读写分离从库两个；慢查询阈值 200 毫秒。',
  '会话 Cookie 是 HttpOnly + SameSite=Lax；刷新 token 有效期 7 天。',
  '构建命令是 pnpm build；产物目录 dist；发布前必须跑 pnpm check。',
]
const filler = '以下是项目背景资料，请在后续问题中使用。'.repeat(650)
const prompts = [
  ...facts.map((fact, index) => `这是第 ${index + 1} 段项目资料，只需记住，不要调用任何工具，回复“了解”：\n${fact}\n${filler}`),
  '不要调用任何工具。根据前面资料回答：项目代号是什么？只答代号。',
  '不要调用任何工具。根据前面资料回答：数据库文件名是什么？只答文件名。',
  '不要调用任何工具。根据前面资料回答：认证时钟容差是多少秒？只答数字。',
  '不要调用任何工具。根据前面资料回答：备份每天几点执行？只答时间。',
  '不要调用任何工具。根据前面资料回答：数据库连接池上限是多少？只答数字。',
]
const expected = ['青松', 'data/qingsong.db', '30', '03:15', '20']

function parse(out) {
  const events = []
  for (const line of out.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  return {
    session: events.find(event => event.type === 'session')?.sessionId,
    final: events.filter(event => event.type === 'final').at(-1)?.text ?? '',
    usages: events.filter(event => event.type === 'status' && event.phase === 'step_end').map(event => event.usage),
    tools: events.filter(event => event.type === 'tool_call' || event.type === 'tool/call').map(event => event.name ?? event.tool ?? 'tool'),
  }
}

function arm(label, profile, settings) {
  writeFileSync(settingsPath, settings === null ? '{}\n' : JSON.stringify(settings, undefined, 2) + '\n')
  let sessionId
  const turns = []
  for (const [index, prompt] of prompts.entries()) {
    const args = ['--expose-internals', cli, '--profile', profile, '--json']
    if (sessionId !== undefined) args.push('--session-id', sessionId)
    args.push(prompt)
    const started = Date.now()
    const result = spawnSync(exe, args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DEEPSEEK_API_KEY: apiKey, ELECTRON_RUN_AS_NODE: '1' },
    })
    const parsed = parse(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    if (parsed.session !== undefined) sessionId = parsed.session
    turns.push({ index: index + 1, answer: parsed.final, usage: parsed.usages, tools: parsed.tools, ms: Date.now() - started })
    console.log(`${label} ${index + 1}/${prompts.length} ${Math.round((Date.now() - started) / 1000)}s ${parsed.final.slice(0, 60).replace(/\n/g, ' ')}`)
  }
  const asked = turns.slice(-5)
  const sum = key => turns.flatMap(turn => turn.usage).reduce((total, usage) => total + (usage?.[key] ?? 0), 0)
  return {
    label, sessionId,
    correct: asked.filter((turn, index) => turn.answer.includes(expected[index])).length,
    total: expected.length,
    input: sum('inputTokens'), cacheRead: sum('cacheReadTokens'), cacheWrite: sum('cacheWriteTokens'), output: sum('outputTokens'),
    tools: turns.flatMap(turn => turn.tools), turns,
  }
}

let backup
if (existsSync(settingsPath)) backup = readFileSync(settingsPath, 'utf8')
try {
  const arms = [arm('no-plugin', 'ab-base', null), arm('default', 'ab-plugin', defaultSettings), arm('aggressive', 'ab-plugin', aggressiveSettings)]
  writeFileSync('docs/experiments/ab-live-three.json', JSON.stringify({ generatedAt: new Date().toISOString(), prompts, expected, arms }, undefined, 2) + '\n')
  console.log('\narm          correct  input  cacheRead  output  tools')
  for (const row of arms) console.log(`${row.label.padEnd(12)} ${row.correct}/${row.total}      ${row.input}    ${row.cacheRead}     ${row.output}    ${row.tools.length}`)
} finally {
  if (backup !== undefined) writeFileSync(settingsPath, backup)
}
