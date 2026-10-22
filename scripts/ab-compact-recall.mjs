#!/usr/bin/env node
/**
 * Can the tree recover details that compaction dropped?
 *
 * This is the experiment that decides whether the plugin's retrieval has value at all.
 * Both arms run the *same* script: seed exact facts inside long tool-looking dumps, push
 * them away with filler turns, compact the history, then ask for the exact strings.
 *
 *   A (baseline) — no plugin. After compaction, the details live only in the summary.
 *   C (plugin)   — retrieval hint enabled. The model may call retrieve_context to pull the
 *                  original node back out of the tree.
 *
 * Facts are quoted exactly (a token, an id, a checksum) so "close enough" does not count.
 *
 * Usage:
 *   node scripts/ab-compact-recall.mjs --plan ACCA --base-port 19651 --base-token … --plug-port 19652 --plug-token …
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const plan = argOf('plan', 'ACCA')
const outPath = argOf('out', 'docs/experiments/compact-recall.json')
const arms = {
  A: { label: 'no-plugin', port: Number(argOf('base-port', '19651')), token: argOf('base-token', '') },
  C: { label: 'plugin', port: Number(argOf('plug-port', '19652')), token: argOf('plug-token', '') },
}

const facts = [
  { id: 'A', seed: '部署探针配置如下（原样保存，后续会问）：\n```yaml\nliveness: /healthz?deep=1\ntimeout_ms: 1733\n```', ask: '我们部署探针的超时毫秒数是多少？只答数字。', expect: '1733' },
  { id: 'B', seed: '构建产物校验记录：\n```text\nartifact sha256: 9f2c41ab77de05\nbuilder: kepler-07\n```', ask: '构建产物的 sha256 前缀（12 位）是什么？只答十六进制串。', expect: '9f2c41ab77de' },
  { id: 'C', seed: '灰度批次编号与比例：\n```json\n{"batch": "rbx-2291", "percent": 7, "window_hours": 26}\n```', ask: '灰度批次编号是什么？只答编号。', expect: 'rbx-2291' },
  { id: 'D', seed: '回滚阈值记录：错误率超过 0.42% 或 P99 超过 1830ms 即回滚。', ask: '回滚的错误率阈值是多少？只答百分比数字。', expect: '0.42' },
]

/** A gateway client for one host. */
function clientFor(arm) {
  const base = `http://127.0.0.1:${arm.port}`
  let cookie = ''
  return {
    async signIn() {
      const response = await fetch(`${base}/?token=${encodeURIComponent(arm.token)}`, { redirect: 'manual' })
      cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
      if (cookie === '') throw new Error(`${arm.label}: token URL set no cookie`)
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
  for (let waited = 0; waited < 400; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(client, sessionId)
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

const runs = []

for (const [position, armKey] of [...plan].entries()) {
  const arm = arms[armKey]
  const client = clientFor(arm)
  await client.signIn()
  const sessionId = (await client.rpc('session/create', { request: {} })).sessionId

  // Seed: facts plus filler, so they end up deep in the history.
  for (const fact of facts) await say(client, sessionId, `记录一条工程信息，不要评论：${fact.seed}`)
  for (let index = 0; index < 6; index++) await say(client, sessionId, `例行检查 ${index + 1} 已完成，请只回复「收到」。`)

  // Compact, so the facts survive only as a summary in the baseline arm.
  let compacted = ''
  try {
    const page = await pageOf(client, sessionId)
    const agentId = (recordsOf(page).find(record => record.type === 'turn/end')?.data?.agentId) ?? sessionId
    const result = await client.rpc('commands/execute', { agentId, line: '/compact', submittedAttachments: [] })
    compacted = JSON.stringify(result?.output ?? result ?? '').slice(0, 200)
  } catch (error) {
    compacted = `failed: ${error.message.slice(0, 160)}`
  }

  const asked = []
  for (const fact of facts) {
    const page = await say(client, sessionId, `不要调用工具、不要反问，凭我们此前的对话回答。${fact.ask}`)
    const answer = lastAnswer(page)
    asked.push({ id: fact.id, expect: fact.expect, answer: answer.slice(0, 120), hit: answer.includes(fact.expect) })
  }

  const page = await pageOf(client, sessionId)
  const records = recordsOf(page)
  const usage = records.filter(record => record.type === 'assistant/message' && record.data?.usage !== undefined).map(record => record.data.usage)
  const sum = key => usage.reduce((total, entry) => total + (entry[key] ?? 0), 0)
  const input = sum('inputTokens')
  const cacheRead = sum('cacheReadTokens')
  const cacheWrite = sum('cacheWriteTokens')
  const hints = records.filter(record => record.type === 'user/message' && record.data?.source?.kind === 'token-tree').length
  const retrievals = records.filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context').length

  runs.push({
    position,
    arm: armKey,
    label: arm.label,
    sessionId,
    compacted,
    correct: asked.filter(item => item.hit).length,
    asked: asked.length,
    details: asked,
    input,
    cacheRead,
    cacheWrite,
    hitRate: input + cacheRead + cacheWrite === 0 ? 0 : Number((cacheRead / (input + cacheRead + cacheWrite) * 100).toFixed(2)),
    hints,
    retrievals,
  })
  console.log(`#${position} ${armKey} ${arm.label.padEnd(10)} correct ${asked.filter(item => item.hit).length}/${asked.length}`
    + ` · input ${input} · cache ${runs[runs.length - 1].hitRate}% · hints ${hints} · retrievals ${retrievals}`
    + ` · compact ${compacted.slice(0, 60)}`)
}

function summarise(armKey) {
  const subset = runs.filter(run => run.arm === armKey)
  if (subset.length === 0) return null
  const total = key => subset.reduce((sum, run) => sum + run[key], 0)
  return {
    runs: subset.length,
    correct: total('correct'),
    asked: total('asked'),
    retrievals: total('retrievals'),
    hintLines: total('hints'),
    inputPerRun: Math.round(total('input') / subset.length),
  }
}

console.log('\nsummary', JSON.stringify({ A: summarise('A'), C: summarise('C') }))
mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ plan, summary: { A: summarise('A'), C: summarise('C') }, runs }, undefined, 2)}\n`, 'utf8')
console.log(`evidence: ${outPath}`)
