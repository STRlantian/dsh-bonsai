#!/usr/bin/env node
/**
 * Does folding actually shrink the prompt without a model call?
 *
 * Script: two turns that each produce a large tool output, then a third turn. With the
 * threshold low, `turn/end` should fold the older tool results out of the surface, so the
 * third request carries placeholders instead of the dumps.
 *
 * Usage: node scripts/probe-fold.mjs --port 19811 --token <token>
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const port = Number(argOf('port', '19811'))
const token = argOf('token', '')
const outPath = argOf('out', 'docs/experiments/history-fold.json')
const foldOff = args.includes('--fold-off')
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
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error('turn did not finish')
}

const billed = page => {
  const usage = recordsOf(page).filter(record => record.type === 'assistant/message' && record.data?.usage).map(record => record.data.usage)
  const last = usage[usage.length - 1]
  return last === undefined ? 0 : (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) + (last.cacheWriteTokens ?? 0)
}

// Fold aggressively so the effect is visible in three turns.
await post('/api/token-tree/settings', { foldAboveTokens: foldOff ? 0 : 50, foldKeepTurns: 1 })
console.log('settings:', JSON.stringify((await settings()).overrides))

const sessionId = (await rpc('session/create', { request: {} })).sessionId
const first = await say(sessionId, '运行 pwsh 命令输出 400 行填充文本，只贴输出不要总结：1..400 | ForEach-Object { "line $_ payload" }')
const second = await say(sessionId, '再运行一次同类命令，输出 400 行填充文本，只贴输出。')
const third = await say(sessionId, '用一句话总结刚才两次命令的输出大概是什么内容，不要调用工具。')

const state = await settings()
const after = await pageOf(sessionId)
const folded = recordsOf(after).filter(record => record.type === 'tool/result' && JSON.stringify(record.data ?? {}).includes('已折叠'))
const placeholders = folded.length

console.log(`turn1 prompt=${billed(first)} · turn2 prompt=${billed(second)} · turn3 prompt=${billed(third)}`)
console.log(`fold diagnostics: ${JSON.stringify(state.fold)}`)
console.log(`surface 里带占位符的 tool/result: ${placeholders}`)

await post('/api/token-tree/settings', { foldAboveTokens: null, foldKeepTurns: null })
mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({
  prompts: [billed(first), billed(second), billed(third)],
  fold: state.fold,
  placeholders,
  sessionId,
}, undefined, 2)}\n`, 'utf8')
console.log(`evidence: ${outPath}`)
