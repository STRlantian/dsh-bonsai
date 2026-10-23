#!/usr/bin/env node
/**
 * Does folding actually reduce input, and what does it cost in cache hits?
 *
 * Two arms, same script: four turns where the first two produce a large tool output, then two
 * questions about that output. One arm folds (low threshold), the other does not. Per model call
 * the table shows input tokens, cache-read tokens and the hit rate, plus the fold diagnostics.
 *
 * Usage: node scripts/probe-fold-cache.mjs --port 19911 --token <token>
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const port = Number(argOf('port', '19911'))
const token = argOf('token', '')
const outPath = argOf('out', 'docs/experiments/fold-cache.json')
const foldThreshold = Number(argOf('threshold', '6000'))
const base = `http://127.0.0.1:${port}`

const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')

async function rpc(method, requestArgs) {
  const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: requestArgs } }
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  })
  const payload = await res.json()
  if (payload.result?.ok !== true) throw new Error(`${method}: ${payload.result?.error?.message ?? 'failed'}`)
  return payload.result.value
}

const post = async (path, body) => (await fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})).json()

const settings = async () => (await fetch(`${base}/api/token-tree/settings`, { headers: { cookie } })).json()
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
  for (let waited = 0; waited < 300; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) {
      await new Promise(resolve => setTimeout(resolve, 800))
      return pageOf(sessionId)
    }
  }
  throw new Error('turn did not finish')
}

const lastText = page => {
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages[messages.length - 1]
  return (last?.data?.message?.content ?? last?.data?.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
}

const usageRows = page => recordsOf(page)
  .filter(record => record.type === 'assistant/message' && record.data?.usage)
  .map(record => {
    const usage = record.data.usage
    const input = usage.inputTokens ?? 0
    const cacheRead = usage.cacheReadTokens ?? 0
    const cacheWrite = usage.cacheWriteTokens ?? 0
    const total = input + cacheRead + cacheWrite
    return { input, cacheRead, cacheWrite, total, hitRate: total === 0 ? 0 : Number(((cacheRead / total) * 100).toFixed(1)) }
  })

const TEXT_TURN = count => `运行 pwsh 命令输出 ${count} 行 "line N payload"，只贴输出，不要总结。`
const question = index => `第 ${index} 次命令输出的最后一行是什么？只回答那一行，不要调用工具。`

async function runArm(arm, foldAboveTokens) {
  await post('/api/token-tree/settings', {
    foldAboveTokens,
    foldKeepTurns: 1,
    foldScope: 'turns',
    toolDeny: null,
  })
  const sessionId = (await rpc('session/create', { request: {} })).sessionId
  const answers = []
  let page
  let before = 0
  for (const prompt of [TEXT_TURN(200), TEXT_TURN(200), question(1), question(2)]) {
    page = await say(sessionId, prompt)
    if (prompt.startsWith('运行')) before = usageRows(page).length
    else answers.push(lastText(page).slice(0, 40))
  }
  const rows = usageRows(page)
  const state = await settings()
  const fold = state.fold

  // Turns after the fold are the ones that show the saving.
  const base = rows.slice(0, before)
  const after = rows.slice(before)
  const avg = list => (list.length === 0 ? 0 : Math.round(list.reduce((sum, row) => sum + row.total, 0) / list.length))
  return { arm, sessionId, rows, answers, fold, baseAverage: avg(base), afterAverage: avg(after) }
}

const folded = await runArm('fold', foldThreshold)
const plain = await runArm('off', 1000000)

const show = run => {
  console.log(`\n${run.arm} (${run.sessionId.slice(-8)})`)
  console.log('  #  input  cacheRead  total  hit%')
  run.rows.forEach((row, index) => {
    console.log(`  ${String(index + 1).padStart(2)} ${String(row.input).padStart(6)} ${String(row.cacheRead).padStart(10)} ${String(row.total).padStart(6)} ${String(row.hitRate).padStart(5)}`)
  })
  console.log(`  answers: ${JSON.stringify(run.answers)}`)
  console.log(`  fold: ${JSON.stringify(run.fold)}`)
  console.log(`  calls before fold ${run.baseAverage} tok · after ${run.afterAverage} tok`)
}

show(plain)
show(folded)
console.log(`\ndelta on the post-fold calls: ${plain.afterAverage - folded.afterAverage} tokens`)

await post('/api/token-tree/settings', { foldAboveTokens: null, foldKeepTurns: null, foldScope: null })
mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ folded, plain }, undefined, 2)}\n`, 'utf8')
console.log(`evidence: ${outPath}`)
