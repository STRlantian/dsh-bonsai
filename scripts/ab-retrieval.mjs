#!/usr/bin/env node
/**
 * Does the new retrieval mode change hit rate, cache behaviour, or input size?
 *
 * Three arms, same conversation shape, same questions, alternating order:
 *
 *   A  no retrieval          — the model answers from the raw history
 *   B  retrieval, old mode   — admission off, topic-line matching off
 *   C  retrieval, new mode   — admission 0.3, topic-line matching on
 *
 * Retrieval is *forced* in B and C ("call retrieve_context first"), because a normal
 * short session never calls the tool — and the tool path is exactly what changed.
 *
 * The facts are long, padded nodes with the fact in the first sentence: the shape where
 * topic-line matching is supposed to matter (see bench-summary.mjs for the offline case).
 *
 * Usage:
 *   node scripts/ab-retrieval.mjs --plan ABCCBA \
 *     --base-port 19561 --base-token <t> --plug-port 19562 --plug-token <t>
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const plan = argOf('plan', 'ABCCBA')
const arms = {
  A: { label: 'no-retrieval', port: Number(argOf('base-port', '19561')), token: argOf('base-token', '') },
  B: { label: 'old-mode', port: Number(argOf('plug-port', '19562')), token: argOf('plug-token', '') },
  C: { label: 'new-mode', port: Number(argOf('plug-port', '19562')), token: argOf('plug-token', '') },
}
const outPath = argOf('out', 'docs/experiments/round3-retrieval.json')

/** A tiny gateway client bound to one host. */
function clientFor(arm) {
  const base = `http://127.0.0.1:${arm.port}`
  let cookie = ''
  return {
    async signIn() {
      const response = await fetch(`${base}/?token=${encodeURIComponent(arm.token)}`, { redirect: 'manual' })
      cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
      if (cookie === '') throw new Error(`arm ${arm.label}: token URL set no cookie`)
    },
    async rpc(method, requestArgs) {
      const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: requestArgs } }
      const response = await fetch(`${base}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(envelope),
      })
      const payload = await response.json()
      if (payload.result?.ok !== true) throw new Error(`${arm.label} ${method}: ${payload.result?.error?.message ?? 'failed'}`)
      return payload.result.value
    },
    async post(path, body) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      })
      return response.json()
    },
  }
}

const recordsOf = page => (page.records ?? []).map(record => record.event ?? record).filter(record => record?.type)
const lastSeq = page => recordsOf(page).reduce((max, record) => Math.max(max, record.seq ?? 0), 0)

async function pageOf(client, sessionId) {
  const address = { kind: 'session', sessionId }
  try {
    return await client.rpc('session/page', { request: { address, throughSeq: Number.MAX_SAFE_INTEGER } })
  } catch (error) {
    const match = /past cursor (\d+)/.exec(String(error.message))
    if (match === null) throw error
    return client.rpc('session/page', { request: { address, throughSeq: Number(match[1]) } })
  }
}

async function say(client, sessionId, text) {
  const before = lastSeq(await pageOf(client, sessionId))
  await client.rpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    },
  })
  for (let waited = 0; waited < 300; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(client, sessionId)
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error(`turn did not finish: ${text.slice(0, 40)}`)
}

const lastAnswer = page => {
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages[messages.length - 1]
  return (last?.data?.message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join(' ').trim()
}

const PAD = '与本次问题无关的工程细节、日志格式、部署顺序、值班安排、发布窗口、监控阈值、回滚流程、'
  + '容量规划、成本核算、依赖升级与文档同步等。'

const FACTS = [
  { fact: '备份窗口固定在 03:15，保留 14 天。', ask: '只答时间。备份窗口固定在几点？', expect: '03:15' },
  { fact: '认证时钟容差是 45 秒。', ask: '只答数字。认证时钟容差是多少秒？', expect: '45' },
  { fact: '连接池上限是 24。', ask: '只答数字。连接池上限是多少？', expect: '24' },
  { fact: '限流按 IP 每分钟 90 次。', ask: '只答数字。限流每分钟多少次？', expect: '90' },
]

const runs = []

for (const [position, armKey] of [...plan].entries()) {
  const arm = arms[armKey]
  const client = clientFor(arm)
  await client.signIn()

  if (armKey === 'B') await client.post('/api/token-tree/settings', { admitRelevance: 0, summaryMatch: false })
  if (armKey === 'C') await client.post('/api/token-tree/settings', { admitRelevance: 0.3, summaryMatch: true })

  const sessionId = (await client.rpc('session/create', { request: {} })).sessionId
  for (const entry of FACTS) {
    await say(client, sessionId, `项目背景记录（无需操作、不要调用工具或反问）：${entry.fact}${PAD.repeat(8)}`)
  }

  const asked = []
  for (const entry of FACTS) {
    const prefix = armKey === 'A'
      ? '不要调用任何工具、不要反问，凭我们此前的对话直接回答。'
      : '先调用 retrieve_context 检索，再回答，不要猜。'
    const page = await say(client, sessionId, `${prefix}${entry.ask}`)
    const answer = lastAnswer(page)
    asked.push({ expect: entry.expect, answer, hit: answer.includes(entry.expect) })
  }

  const page = await pageOf(client, sessionId)
  const records = recordsOf(page)
  const usage = records.filter(record => record.type === 'assistant/message' && record.data?.usage !== undefined).map(record => record.data.usage)
  const sum = key => usage.reduce((total, entry) => total + (entry[key] ?? 0), 0)
  const toolResults = records.filter(record => record.type === 'tool/result')
  const retrieved = toolResults.map(record => {
    const text = JSON.stringify(record.data ?? {})
    const match = /Retrieved (\d+) node\(s\), (\d+)\/\d+ tokens/.exec(text)
    return match === null ? null : { nodes: Number(match[1]), tokens: Number(match[2]) }
  }).filter(Boolean)
  const retrieveCalls = records.filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context').length

  const input = sum('inputTokens')
  const cacheRead = sum('cacheReadTokens')
  const cacheWrite = sum('cacheWriteTokens')
  const billable = input + cacheRead + cacheWrite
  const entry = {
    position,
    arm: armKey,
    label: arm.label,
    sessionId,
    correct: asked.filter(item => item.hit).length,
    asked: asked.length,
    input,
    cacheRead,
    cacheWrite,
    hitRate: billable === 0 ? 0 : Number((cacheRead / billable * 100).toFixed(2)),
    retrieveCalls,
    retrievedNodes: retrieved.reduce((total, item) => total + item.nodes, 0),
    retrievedTokens: retrieved.reduce((total, item) => total + item.tokens, 0),
    answers: asked,
  }
  runs.push(entry)
  console.log(`#${position} ${armKey} ${entry.label.padEnd(12)} correct ${entry.correct}/${entry.asked}`
    + `  input ${String(entry.input).padStart(6)}  cache-hit ${entry.hitRate.toFixed(2)}%`
    + `  tool ${entry.retrieveCalls}  nodes ${entry.retrievedNodes} (${entry.retrievedTokens} tok)`)
  console.log(`     retrieved = ${JSON.stringify(retrieved)}`)
}

/** Aggregate one arm across its runs. */
function summarise(runs, armKey) {
  const subset = runs.filter(run => run.arm === armKey)
  if (subset.length === 0) return null
  const total = key => subset.reduce((sum, run) => sum + run[key], 0)
  const input = total('input')
  const cacheRead = total('cacheRead')
  const cacheWrite = total('cacheWrite')
  const billable = input + cacheRead + cacheWrite
  return {
    runs: subset.length,
    correct: total('correct'),
    asked: total('asked'),
    input,
    inputPerRun: Math.round(input / subset.length),
    cacheHit: billable === 0 ? '0%' : `${(cacheRead / billable * 100).toFixed(2)}%`,
    retrieveCalls: total('retrieveCalls'),
    retrievedNodes: total('retrievedNodes'),
    retrievedTokens: total('retrievedTokens'),
  }
}

const summary = { A: summarise(runs, 'A'), B: summarise(runs, 'B'), C: summarise(runs, 'C') }
console.log('\nsummary')
for (const key of ['A', 'B', 'C']) {
  const row = summary[key]
  if (row === null) continue
  console.log(` ${key} ${row.runs} runs · correct ${row.correct}/${row.asked} · new input ${row.input}`
    + ` (${row.inputPerRun}/run) · cache hit ${row.cacheHit} · retrieve ${row.retrieveCalls} calls`
    + ` · returned ${row.retrievedNodes} nodes (${row.retrievedTokens} tok)`)
}

mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ plan, summary, runs }, undefined, 2)}\n`, 'utf8')
console.log(`\nevidence: ${outPath}`)
