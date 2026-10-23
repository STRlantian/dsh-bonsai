#!/usr/bin/env node
/**
 * Do facts survive compaction when they live in tool output?
 *
 * `compaction/summary` paraphrases the conversation, but `compaction/prune` drops tool results
 * outright. So this run seeds the facts by *running commands* (they end up in tool output),
 * compacts, verifies that prune shadowed something, then asks with the host tools forbidden
 * and only `retrieve_context` allowed.
 *
 *   A (bare)  — the plain hint after compaction.
 *   C (index) — the hint plus a map of the folded nodes.
 *
 * If A misses and C hits, the tree finally earns its cost. If both miss, retrieval itself is
 * broken. If both hit, prune did not actually remove the facts.
 *
 * Usage:
 *   node scripts/ab-prune.mjs --plan AC --port 19751 --token <token>
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const plan = argOf('plan', 'AC')
const port = Number(argOf('port', '19751'))
const token = argOf('token', '')
const outPath = argOf('out', 'docs/experiments/ab-prune.json')
const base = `http://127.0.0.1:${port}`

let cookie = ''
const signIn = async () => {
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

const post = async (path, body) => (await fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})).json()

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
  throw new Error(`turn did not finish: ${text.slice(0, 24)}`)
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

/** Facts are printed by a command, so they land in tool output — the thing prune removes. */
const facts = [
  { command: 'Write-Output "probe_timeout_ms=1733 max_retries=4"', ask: '探针超时是多少毫秒？只答数字。', expect: '1733' },
  { command: 'Write-Output "artifact=9f2c41ab77de05 builder=kepler-07"', ask: 'artifact 标识前 12 位是什么？只答十六进制串。', expect: '9f2c41ab77de' },
  { command: 'Write-Output "batch=rbx-2291 percent=7"', ask: '灰度批次编号是什么？只答编号。', expect: 'rbx-2291' },
  { command: 'Write-Output "rollback_on_error_rate=0.42 percent"', ask: '回滚的错误率阈值是多少？只答数字。', expect: '0.42' },
]

await signIn()

const runs = []
for (const [position, armKey] of [...plan].entries()) {
  await post('/api/token-tree/settings', { compactionIndex: armKey === 'C' })
  const sessionId = (await rpc('session/create', { request: {} })).sessionId

  for (const fact of facts) {
    await say(sessionId, `请在终端执行下面这条命令并把输出贴出来，不要总结、不要评论：${fact.command}`)
  }
  for (let index = 0; index < 6; index++) await say(sessionId, `例行检查 ${index + 1} 已完成，只回复「收到」。`)

  const before = await pageOf(sessionId)
  const agentId = recordsOf(before).find(record => record.type === 'turn/end')?.data?.agentId ?? sessionId
  let compacted = ''
  try {
    const result = await rpc('commands/execute', { agentId, line: '/compact', submittedAttachments: [] })
    compacted = JSON.stringify(result?.output ?? result ?? '').slice(0, 140)
  } catch (error) {
    compacted = `failed: ${String(error.message).slice(0, 120)}`
  }

  const after = await pageOf(sessionId)
  const pruneEvents = recordsOf(after).filter(record => record.type === 'compaction/prune')
  const shadowed = pruneEvents.reduce((sum, record) => sum + (record.data?.shadowedTokenCount ?? 0), 0)

  const asked = []
  let retrieveCalls = 0
  let otherTools = 0
  for (const fact of facts) {
    const page = await say(
      sessionId,
      `只能用 retrieve_context 查历史；禁止使用 pwsh、read、write 或任何其他工具。记不清就回答「不确定」，不要猜。${fact.ask}`,
    )
    const answer = lastAnswer(page)
    const calls = recordsOf(page).filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context').length
    const others = recordsOf(page).filter(record => record.type === 'tool/call' && record.data?.name !== 'retrieve_context').length
    retrieveCalls += calls
    otherTools += others
    asked.push({ expect: fact.expect, answer: answer.slice(0, 100), hit: answer.includes(fact.expect), calls, others })
  }

  const records = recordsOf(await pageOf(sessionId))
  const usage = records.filter(record => record.type === 'assistant/message' && record.data?.usage !== undefined).map(record => record.data.usage)
  const sum = key => usage.reduce((total, entry) => total + (entry[key] ?? 0), 0)
  const input = sum('inputTokens')
  const cacheRead = sum('cacheReadTokens')
  const cacheWrite = sum('cacheWriteTokens')

  const run = {
    position,
    arm: armKey,
    label: armKey === 'C' ? 'index' : 'bare',
    sessionId,
    compacted,
    pruneEvents: pruneEvents.length,
    shadowedTokens: shadowed,
    correct: asked.filter(item => item.hit).length,
    asked: asked.length,
    details: asked,
    retrieveCalls,
    otherTools,
    input,
    cacheRead,
    cacheWrite,
    hitRate: input + cacheRead + cacheWrite === 0 ? 0 : Number((cacheRead / (input + cacheRead + cacheWrite) * 100).toFixed(2)),
  }
  runs.push(run)
  console.log(`#${position} ${armKey} ${run.label.padEnd(6)} correct ${run.correct}/${run.asked} · retrieve ${retrieveCalls} · other tools ${otherTools}`
    + ` · prune ${run.pruneEvents} (shadowed ${shadowed} tok) · input ${input} · cache ${run.hitRate}%`)
  for (const detail of asked) {
    console.log(`   ${detail.hit ? 'HIT ' : 'MISS'} ${detail.expect} · retrieve=${detail.calls} · others=${detail.others} · ${JSON.stringify(detail.answer.slice(0, 70))}`)
  }
}

await post('/api/token-tree/settings', { compactionIndex: null })
mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ plan, runs }, undefined, 2)}\n`, 'utf8')
console.log(`\nevidence: ${outPath}`)
