#!/usr/bin/env node
/**
 * Live A/B for history folding: same questions, same tools, one variable.
 *
 * Both arms talk to the same host, so the tool list, the system prompt and the model are identical
 * by construction. The only thing that changes is the fold setting, applied through the plugin's own
 * settings route before each session starts. Arms alternate (A,B,B,A) so time drift and warm caches
 * hit both sides.
 *
 * Every figure printed comes from the host's own records: `assistant/message.data.usage` for tokens,
 * `surfaceOp: replace` events for folds actually applied, `request/header` for the tool list.
 *
 * Usage:
 *   node scripts/ab-fold-live.mjs --port 19631 --token <token> [--plan ABBA] [--turns 12]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const port = Number(argOf('port', '0'))
const token = argOf('token', '')
const plan = argOf('plan', 'ABBA')
const turns = Number(argOf('turns', '12'))
const outPath = argOf('out', 'docs/experiments/fold-live.json')
if (port === 0 || token === '') throw new Error('usage: --port <port> --token <token>')

const base = `http://127.0.0.1:${port}`
let cookie = ''

async function signIn() {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
  if (cookie === '') throw new Error('the token URL set no cookie')
}

async function rpc(method, requestArgs) {
  const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: requestArgs } }
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  })
  const payload = await response.json()
  if (payload.result?.ok !== true) throw new Error(`${method}: ${payload.result?.error?.message ?? 'unknown'}`)
  return payload.result.value
}

const recordsOf = page => (page.records ?? []).map(record => record.event ?? record).filter(record => record?.type !== undefined)
const lastSeq = page => recordsOf(page).reduce((max, record) => Math.max(max, record.seq ?? 0), 0)

async function pageOf(sessionId) {
  const address = { kind: 'session', sessionId }
  try {
    return await rpc('session/page', { request: { address, throughSeq: Number.MAX_SAFE_INTEGER } })
  } catch (error) {
    const match = /past cursor (\d+)/.exec(error instanceof Error ? error.message : String(error))
    if (match === null) throw error
    return rpc('session/page', { request: { address, throughSeq: Number(match[1]) } })
  }
}

async function say(sessionId, text) {
  const before = lastSeq(await pageOf(sessionId))
  await rpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    },
  })
  for (let waited = 0; waited < 600; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    const records = recordsOf(page)
    if (records.some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error('turn did not finish: ' + text.slice(0, 40))
}

function lastAnswer(page) {
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages[messages.length - 1]
  if (last === undefined) return ''
  return (last.data?.message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n').trim()
}

/** Plant values early, ask for them late: folding can only hurt if it drops the plant. */
function scenario() {
  const seeds = []
  const questions = []
  for (let index = 1; index <= turns; index++) {
    const value = 4100 + index * 7
    seeds.push(`记录一个事实并展开说明，不用调用工具：服务 ${index} 的端口号是 ${value}。`
      + `请用大约 300 字说明这个服务通常承担什么职责、可能遇到哪些故障，以及端口选择要注意什么。`)
    if (index <= Math.floor(turns / 2)) {
      questions.push({ ask: `服务 ${index} 的端口号是多少？只回答数字。`, expect: String(value) })
    }
  }
  return { seeds, questions }
}

const arms = {
  A: { label: 'fold-off', patch: { foldAboveTokens: 0, foldKeepTurns: 0, foldScope: 'turns' } },
  B: { label: 'fold-on', patch: { foldAboveTokens: Number(argOf('fold-above', '3000')), foldKeepTurns: Number(argOf('fold-keep', '2')), foldScope: 'turns' } },
}

await signIn()
const data = scenario()
const runs = []

for (const [position, armKey] of [...plan].entries()) {
  const arm = arms[armKey]
  await rpc('settings', {}) .catch(() => undefined)
  // The plugin's own route writes a whole patch in one request.
  const patchResponse = await fetch(`${base}/api/token-tree/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(arm.patch),
  })
  if (!patchResponse.ok) throw new Error('settings patch failed: ' + patchResponse.status)

  const created = await rpc('session/create', { request: {} })
  const sessionId = created.sessionId
  for (const seed of data.seeds) await say(sessionId, seed)
  const asked = []
  for (const question of data.questions) {
    const page = await say(sessionId, question.ask)
    const answer = lastAnswer(page)
    asked.push({ expect: question.expect, answer: answer.slice(0, 60), hit: answer.includes(question.expect) })
  }

  const page = await pageOf(sessionId)
  const records = recordsOf(page)
  const usage = records.filter(record => record.type === 'assistant/message' && record.data?.usage !== undefined).map(record => record.data.usage)
  const sum = key => usage.reduce((total, entry) => total + (entry[key] ?? 0), 0)
  const placeholderText = records
    .filter(record => record.type === 'user/message')
    .map(record => (record.data?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join(''))
    .filter(text => text.includes('已折叠'))
  const folds = Math.max(records.filter(record => record.surfaceOp?.op === 'replace').length, placeholderText.length)
  const header = records.find(record => record.type === 'request/header')
  const tools = (header?.data?.header?.tools ?? []).map(tool => tool.name).sort()

  runs.push({
    position,
    arm: armKey,
    label: arm.label,
    sessionId,
    steps: usage.length,
    input: sum('inputTokens'),
    cacheRead: sum('cacheReadTokens'),
    output: sum('outputTokens'),
    folds,
    toolCount: tools.length,
    tools,
    correct: asked.filter(item => item.hit).length,
    asked: asked.length,
    answers: asked,
  })
  console.log(`#${position} ${arm.label.padEnd(9)} steps ${usage.length} · input ${sum('inputTokens')} · cacheRead ${sum('cacheReadTokens')} · folds ${folds} · tools ${tools.length} · correct ${asked.filter(i => i.hit).length}/${asked.length}`)
}

function perArm(key) {
  const subset = runs.filter(run => run.arm === key)
  const total = field => subset.reduce((sum, run) => sum + run[field], 0)
  return {
    runs: subset.length,
    steps: total('steps'),
    input: total('input'),
    cacheRead: total('cacheRead'),
    output: total('output'),
    folds: total('folds'),
    correct: total('correct'),
    asked: total('asked'),
    inputPerStep: subset.reduce((sum, run) => sum + run.steps, 0) === 0 ? 0 : Math.round(total('input') / total('steps')),
    promptPerStep: subset.reduce((sum, run) => sum + run.steps, 0) === 0 ? 0 : Math.round((total('input') + total('cacheRead')) / total('steps')),
  }
}

const summary = { arms: { A: perArm('A'), B: perArm('B') }, plan, turns, runs }
console.log('\n== summary ==')
for (const key of ['A', 'B']) {
  const arm = summary.arms[key]
  if (arm.runs === 0) continue
  console.log(`${key} ${arms[key].label.padEnd(9)} runs ${arm.runs} · steps ${arm.steps} · prompt/step ${arm.promptPerStep} · input/step ${arm.inputPerStep} · folds ${arm.folds} · correct ${arm.correct}/${arm.asked}`)
}
const a = summary.arms.A
const b = summary.arms.B
if (a.steps > 0 && b.steps > 0) {
  const saved = (1 - b.promptPerStep / a.promptPerStep) * 100
  console.log(`prompt per step: ${a.promptPerStep} -> ${b.promptPerStep} (${saved.toFixed(1)}% ${saved >= 0 ? 'lower' : 'higher'} with folding)`)
  console.log(`tools identical: ${JSON.stringify(a.runs === 0 ? [] : runs.filter(r => r.arm === 'A')[0].tools) === JSON.stringify(runs.filter(r => r.arm === 'B')[0]?.tools ?? [])}`)
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(summary, undefined, 2))
console.log('written ' + outPath)
