#!/usr/bin/env node
/**
 * Does a map of the folded nodes make the model actually look things up?
 *
 * Both arms run the same script and differ in exactly one setting:
 *
 *   A (bare)   — after /compact the hint is the plain one-liner.
 *   C (index)  — the first hint also lists the folded nodes (id, kind, one line, size).
 *
 * Measured: how often `retrieve_context` is called, whether the exact strings come back, and
 * what the turns cost. Facts are quoted exactly so a plausible paraphrase does not count.
 *
 * NOTE: the first run of this driver was invalid — the instruction invited read/pwsh/write,
 * so the model went looking on disk instead of in the tree, and compaction's summary had kept
 * every fact anyway. See docs/experiment-context-cache.md, experiment 12.
 *
 * Usage:
 *   node scripts/ab-index.mjs --plan ACCA --port 19751 --token <token>
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const plan = argOf('plan', 'ACCA')
const port = Number(argOf('port', '19751'))
const token = argOf('token', '')
const outPath = argOf('out', 'docs/experiments/ab-index.json')
const base = `http://127.0.0.1:${port}`

let cookie = ''
async function signIn() {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
  if (cookie === '') throw new Error('token URL set no cookie')
}

async function rpc(method, requestArgs) {
  const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: requestArgs } }
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  })
  const payload = await response.json()
  if (payload.result?.ok !== true) throw new Error(`${method}: ${payload.result?.error?.message ?? 'failed'}`)
  return payload.result.value
}

const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  return response.json()
}

const recordsOf = page => (page.records ?? []).map(record => record.event ?? record).filter(record => record?.type)
const lastSeq = page => recordsOf(page).reduce((max, record) => Math.max(max, record.seq ?? 0), 0)

async function pageOf(sessionId) {
  const address = { kind: 'session', sessionId }
  try {
    return await rpc('session/page', { request: { address, throughSeq: Number.MAX_SAFE_INTEGER } })
  } catch (error) {
    const match = /past cursor (\d+)/.exec(String(error.message))
    if (match === null) throw error
    return rpc('session/page', { request: { address, throughSeq: Number(match[1]) } })
  }
}

async function say(sessionId, text) {
  const before = lastSeq(await pageOf(sessionId))
  await rpc('session/prompt', {
    request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' },
  })
  for (let waited = 0; waited < 400; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error(`turn did not finish: ${text.slice(0, 30)}`)
}

const lastAnswer = page => {
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages[messages.length - 1]
  return (last?.data?.message?.content ?? last?.data?.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
}

const facts = [
  { seed: '部署记录（原样保存）：\n```yaml\nprobe_timeout_ms: 1733\nmax_retries: 4\n```', ask: '探针超时是多少毫秒？只答数字。', expect: '1733' },
  { seed: '构建校验：\n```text\nartifact 9f2c41ab77de05\nbuilder kepler-07\n```', ask: '构建产物的 sha256 前 12 位是什么？只答十六进制串。', expect: '9f2c41ab77de' },
  { seed: '灰度批次：\n```json\n{"batch": "rbx-2291", "percent": 7}\n```', ask: '灰度批次编号是什么？只答编号。', expect: 'rbx-2291' },
  { seed: '回滚阈值：错误率超过 0.42% 或 P99 超过 1830ms 即回滚。', ask: '回滚的错误率阈值是多少？只答数字。', expect: '0.42' },
]

await signIn()

const runs = []
for (const [position, armKey] of [...plan].entries()) {
  // A = no index, C = index. The switch is the only difference.
  await post('/api/token-tree/settings', { compactionIndex: armKey === 'C' })
  const sessionId = (await rpc('session/create', { request: {} })).sessionId

  for (const fact of facts) await say(sessionId, `记录一条工程信息，不要评论：${fact.seed}`)
  for (let index = 0; index < 6; index++) await say(sessionId, `例行检查 ${index + 1} 已完成，请只回复「收到」。`)

  let compacted = ''
  try {
    const page = await pageOf(sessionId)
    const agentId = recordsOf(page).find(record => record.type === 'turn/end')?.data?.agentId ?? sessionId
    const result = await rpc('commands/execute', { agentId, line: '/compact', submittedAttachments: [] })
    compacted = JSON.stringify(result?.output ?? result ?? '').slice(0, 120)
  } catch (error) {
    compacted = `failed: ${String(error.message).slice(0, 120)}`
  }

  const asked = []
  let toolCalls = 0
  let retrieveCalls = 0
  for (const fact of facts) {
    const page = await say(sessionId, `只允许使用 retrieve_context 查询历史；不要使用 read、pwsh、write 或任何其他工具。只凭对话内容回答，记不清就回答「不确定」。${fact.ask}`)
    const answer = lastAnswer(page)
    const calls = recordsOf(page).filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context').length
    const total = recordsOf(page).filter(record => record.type === 'tool/call').length
    toolCalls += total
    retrieveCalls += calls
    asked.push({ expect: fact.expect, answer: answer.slice(0, 100), hit: answer.includes(fact.expect), calls, total })
  }

  const page = await pageOf(sessionId)
  const records = recordsOf(page)
  const usage = records.filter(record => record.type === 'assistant/message' && record.data?.usage !== undefined).map(record => record.data.usage)
  const sum = key => usage.reduce((total, entry) => total + (entry[key] ?? 0), 0)
  const input = sum('inputTokens')
  const cacheRead = sum('cacheReadTokens')
  const cacheWrite = sum('cacheWriteTokens')
  const hints = records.filter(record => record.type === 'user/message' && record.data?.source?.kind === 'token-tree').length

  runs.push({
    position,
    arm: armKey,
    label: armKey === 'C' ? 'index' : 'bare',
    sessionId,
    compacted,
    correct: asked.filter(item => item.hit).length,
    asked: asked.length,
    details: asked,
    toolCalls,
    retrieveCalls,
    hints,
    input,
    cacheRead,
    cacheWrite,
    hitRate: input + cacheRead + cacheWrite === 0 ? 0 : Number((cacheRead / (input + cacheRead + cacheWrite) * 100).toFixed(2)),
  })
  const last = runs[runs.length - 1]
  console.log(`#${position} ${armKey} ${last.label.padEnd(6)} correct ${last.correct}/${last.asked}`
    + ` · retrieve_context ${last.retrieveCalls} · all tool calls ${last.toolCalls} · hints ${last.hints}`
    + ` · input ${last.input} · cache ${last.hitRate}% · compact ${compacted.slice(0, 40)}`)
}

await post('/api/token-tree/settings', { compactionIndex: null })

function summarise(armKey) {
  const subset = runs.filter(run => run.arm === armKey)
  if (subset.length === 0) return null
  const total = key => subset.reduce((sum, run) => sum + run[key], 0)
  return {
    runs: subset.length,
    correct: total('correct'),
    asked: total('asked'),
    toolCalls: total('toolCalls'),
    retrieveCalls: total('retrieveCalls'),
    hints: total('hints'),
    inputPerRun: Math.round(total('input') / subset.length),
  }
}

console.log('\nsummary', JSON.stringify({ A: summarise('A'), C: summarise('C') }))
mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ plan, summary: { A: summarise('A'), C: summarise('C') }, runs }, undefined, 2)}\n`, 'utf8')
console.log(`evidence: ${outPath}`)
