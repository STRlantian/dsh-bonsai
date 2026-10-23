#!/usr/bin/env node
/**
 * Measure the effect of hiding tools.
 *
 * Baseline: one short turn, record how many tool schemas the assembly carried, their total
 * characters and the billed prompt. Then set `toolDeny`, open a *new* session (so
 * `agent/created` fires), and repeat.
 *
 * Usage: node scripts/probe-tool-trim.mjs --port 19791 --token <token>
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const port = Number(argOf('port', '19791'))
const token = argOf('token', '')
const outPath = argOf('out', 'docs/experiments/tool-trim.json')
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
  for (let waited = 0; waited < 240; waited++) {
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

const toolsOf = assembly => {
  const part = assembly?.parts?.find(entry => entry.name === 'tools')
  return { count: assembly?.tools?.length ?? 0, chars: part?.chars ?? 0 }
}

const prompt = '用一句话说明什么是写时复制。'

// 1. Baseline.
const baselineSession = (await rpc('session/create', { request: {} })).sessionId
const baselinePage = await say(baselineSession, prompt)
const baselineSettings = await settings()
const baseline = {
  tools: toolsOf(baselineSettings.lastAssembly),
  promptTokens: billed(baselinePage),
  restriction: baselineSettings.toolRestriction,
}
console.log(`baseline : tools=${baseline.tools.count} · schemaChars=${baseline.tools.chars} · prompt=${baseline.promptTokens} tok`)

// 2. Hide the heavy, rarely-needed tools and open a fresh agent.
const deny = ['workflow', 'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list', 'subagent_fork', 'ask_user_question', 'update_goal', 'get_goal']
await post('/api/token-tree/settings', { toolDeny: deny })
const trimmedSession = (await rpc('session/create', { request: {} })).sessionId
const trimmedPage = await say(trimmedSession, prompt)
const trimmedSettings = await settings()
const trimmed = {
  tools: toolsOf(trimmedSettings.lastAssembly),
  promptTokens: billed(trimmedPage),
  restriction: trimmedSettings.toolRestriction,
}
console.log(`trimmed  : tools=${trimmed.tools.count} · schemaChars=${trimmed.tools.chars} · prompt=${trimmed.promptTokens} tok`)
console.log(`restriction: ${JSON.stringify(trimmed.restriction)}`)
console.log(`saved: ${baseline.promptTokens - trimmed.promptTokens} tok · ${baseline.tools.chars - trimmed.tools.chars} schema chars`)

await post('/api/token-tree/settings', { toolDeny: null })
mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ deny, baseline, trimmed }, undefined, 2)}\n`, 'utf8')
console.log(`evidence: ${outPath}`)
