#!/usr/bin/env node
/**
 * Final end-to-end check of the shipping configuration.
 *
 * Two parts, both natural (the model is never told to call the tool):
 *
 *   short   default settings — the hint threshold is 12k measured tokens, so a normal
 *           session should see *no* injection at all. The plugin should be invisible.
 *   forced  the hint threshold is lowered through the settings route, so the hint really
 *           fires every turn. That is where its token and cache cost becomes visible.
 *
 * Arms: `A` = no plugin, `C` = plugin. Alternating order, script scoring, usage from the
 * provider's own numbers.
 *
 * Usage:
 *   node scripts/ab-final.mjs --part short --plan ACCA --base-port 19611 --base-token … --plug-port 19612 --plug-token …
 *   node scripts/ab-final.mjs --part forced --plan ACCA … --hint-above 600
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const part = argOf('part', 'short')
const plan = argOf('plan', 'ACCA')
const hintAbove = argOf('hint-above', '600')
const outPath = argOf('out', `docs/experiments/final-${part}.json`)
const arms = {
  A: { label: 'no-plugin', port: Number(argOf('base-port', '19611')), token: argOf('base-token', '') },
  C: { label: 'plugin', port: Number(argOf('plug-port', '19612')), token: argOf('plug-token', '') },
}

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
  return (last?.data?.message?.content ?? []).filter(block => block?.type === 'text').map(block => block.text).join(' ').trim()
}

const FACTS = [
  { fact: '数据库文件名是 kuroshio_user.db。', ask: '只答文件名。数据库文件名是什么？', expect: 'kuroshio_user.db' },
  { fact: '认证时钟容差是 45 秒。', ask: '只答数字。认证时钟容差是多少秒？', expect: '45' },
  { fact: '备份每天 03:15 执行，保留 14 天。', ask: '只答时间。备份每天几点执行？', expect: '03:15' },
  { fact: '错误码从 41000 开始。', ask: '只答数字。错误码从哪个数字开始？', expect: '41000' },
]

const runs = []

for (const [position, armKey] of [...plan].entries()) {
  const arm = arms[armKey]
  const client = clientFor(arm)
  await client.signIn()
  if (armKey === 'C' && part === 'forced') {
    const applied = await client.post('/api/token-tree/settings', { hintAboveTokens: Number(hintAbove) })
    if (applied.ok !== true) throw new Error(`could not lower the hint threshold: ${JSON.stringify(applied)}`)
  }
  if (armKey === 'C' && part === 'short') {
    await client.post('/api/token-tree/settings', { hintAboveTokens: null })
  }

  const sessionId = (await client.rpc('session/create', { request: {} })).sessionId
  for (const entry of FACTS) {
    await say(client, sessionId, `记一条项目事实（不要调用工具、不要反问）：${entry.fact}`)
  }
  // Filler turns push the facts away from the tail, so the questions genuinely need recall.
  for (let index = 0; index < 4; index++) {
    await say(client, sessionId, `无操作确认，只回复「收到」：第 ${index + 1} 项例行检查已完成。`)
  }

  const asked = []
  for (const entry of FACTS) {
    const page = await say(client, sessionId, `不要调用任何工具、不要反问，凭我们此前的对话回答。${entry.ask}`)
    const answer = lastAnswer(page)
    asked.push({ expect: entry.expect, answer, hit: answer.includes(entry.expect) })
  }

  const page = await pageOf(client, sessionId)
  const records = recordsOf(page)
  const usage = records.filter(record => record.type === 'assistant/message' && record.data?.usage !== undefined).map(record => record.data.usage)
  const sum = key => usage.reduce((total, entry) => total + (entry[key] ?? 0), 0)
  const hints = records.filter(record => record.type === 'user/message' && record.data?.source?.kind === 'token-tree').length
  const input = sum('inputTokens')
  const cacheRead = sum('cacheReadTokens')
  const cacheWrite = sum('cacheWriteTokens')
  const billable = input + cacheRead + cacheWrite
  const lastTotal = usage.length === 0 ? 0
    : (usage[usage.length - 1].inputTokens ?? 0) + (usage[usage.length - 1].cacheReadTokens ?? 0)

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
    hintLines: hints,
    finalContext: lastTotal,
    retrievals: records.filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context').length,
  }
  runs.push(entry)
  console.log(`#${position} ${armKey} ${entry.label.padEnd(10)} correct ${entry.correct}/${entry.asked}`
    + ` · new input ${String(entry.input).padStart(6)} · cache hit ${entry.hitRate.toFixed(2)}%`
    + ` · hint lines ${entry.hintLines} · final context ${entry.finalContext} tok · retrievals ${entry.retrievals}`)
}

function summarise(armKey) {
  const subset = runs.filter(run => run.arm === armKey)
  if (subset.length === 0) return null
  const total = key => subset.reduce((sum, run) => sum + run[key], 0)
  return {
    runs: subset.length,
    correct: total('correct'),
    asked: total('asked'),
    inputPerRun: Math.round(total('input') / subset.length),
    cacheHit: total('cacheRead') + total('input') + total('cacheWrite') === 0
      ? '0%'
      : `${(total('cacheRead') / (total('cacheRead') + total('input') + total('cacheWrite')) * 100).toFixed(2)}%`,
    hintLines: total('hintLines'),
    finalContext: Math.round(total('finalContext') / subset.length),
  }
}

const summary = { A: summarise('A'), C: summarise('C') }
console.log('\nsummary')
for (const key of ['A', 'C']) {
  const row = summary[key]
  if (row === null) continue
  console.log(` ${key} ${row.runs} runs · correct ${row.correct}/${row.asked} · new input ${row.inputPerRun}/run`
    + ` · cache hit ${row.cacheHit} · hint lines ${row.hintLines} · context ${row.finalContext} tok`)
}

mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ part, plan, hintAbove: Number(hintAbove), summary, runs }, undefined, 2)}\n`, 'utf8')
console.log(`\nevidence: ${outPath}`)
