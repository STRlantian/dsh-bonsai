#!/usr/bin/env node
/**
 * Live check of the attach-marker loop: does the model use the candidate list, and does it help?
 *
 * One host, one session, a scripted conversation with a planted ambiguous follow-up. For each turn
 * it records the marker the model wrote (if any), whether that id was on the offered list, and the
 * tokens of the injected block. Reparenting is read back from the plugin's edit log
 * (`~/.dsh/token-tree/edits.jsonl`), not from the model's own claim.
 *
 * Usage:
 *   node scripts/ab-attach-live.mjs --port 19641 --token <token> [--out docs/experiments/attach-live.json]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const port = Number(argOf('port', '0'))
const token = argOf('token', '')
const outPath = argOf('out', 'docs/experiments/attach-live.json')
if (port === 0 || token === '') throw new Error('usage: --port <port> --token <token>')
const base = `http://127.0.0.1:${port}`
let cookie = ''

async function signIn() {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
  if (cookie === '') throw new Error('no cookie')
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
  for (let waited = 0; waited < 900; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    const records = recordsOf(page)
    if (records.some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error('turn did not finish: ' + text.slice(0, 40))
}

function lastAssistantText(page) {
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages[messages.length - 1]
  if (last === undefined) return ''
  return (last.data?.message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n')
}

/** The injected block, as it appeared in the request: the user-message record the plugin appended. */
function injectedBlocks(page) {
  return recordsOf(page)
    .filter(record => record.type === 'user/message')
    .map(record => (record.data?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join(''))
    .filter(text => text.includes('[attach:nX]'))
}

const editLog = join(homedir(), '.dsh', 'token-tree', 'edits.jsonl')
function reparentsSince(fromBytes) {
  if (!existsSync(editLog)) return []
  const text = readFileSync(editLog, 'utf8')
  const fresh = text.slice(fromBytes)
  return fresh.split('\n').filter(line => line.includes('"reparent"')).map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
}

await signIn()
const created = await rpc('session/create', { request: {} })
const sessionId = created.sessionId
const startBytes = existsSync(editLog) ? readFileSync(editLog, 'utf8').length : 0

const script = [
  { turn: 'topic-a', text: '记录一个事实，不用调用工具：服务 A 的端口是 4107。请用大约 150 字说明这类服务通常承担什么职责。' },
  { turn: 'topic-b', text: '记录另一个事实：服务 B 的端口是 5108。请用大约 150 字说明它和缓存层的关系。' },
  { turn: 'anaphora-1', text: '它的端口号是多少？只回答数字。' },
  { turn: 'anaphora-2', text: '那它对缓存的依赖强吗？一句话回答。' },
  { turn: 'new-topic', text: '介绍一下一致性哈希的虚拟节点，约 120 字。' },
  { turn: 'anaphora-3', text: '它的主要缺点是什么？一句话。' },
]

const rows = []
for (const step of script) {
  const page = await say(sessionId, step.text)
  const text = lastAssistantText(page)
  const marker = /\[attach:(n\d+)\]/.exec(text)
  const blocks = injectedBlocks(page)
  const offered = blocks.length === 0
    ? []
    : [...blocks[blocks.length - 1].matchAll(/^- (n\d+) ·/gm)].map(match => match[1])
  rows.push({
    step: step.turn,
    marker: marker === null ? null : marker[1],
    offeredCount: offered.length,
    offered,
    valid: marker === null ? null : offered.includes(marker[1]),
    answer: text.replace(/\s+/g, ' ').slice(0, 80),
  })
  console.log(`turn ${step.turn.padEnd(11)} marker ${String(marker === null ? '-' : marker[1]).padEnd(5)} offered ${String(offered.length).padStart(2)}${marker === null ? '' : marker[1] !== undefined && offered.includes(marker[1]) ? ' (valid)' : ' (NOT offered)'}`)
}

const reparents = reparentsSince(startBytes)
const summary = {
  sessionId,
  turns: rows.length,
  markers: rows.filter(row => row.marker !== null).length,
  validMarkers: rows.filter(row => row.valid === true).length,
  reparents: reparents.length,
  rows,
}
console.log(`\nmarkers ${summary.markers}/${summary.turns} · valid ${summary.validMarkers} · reparents recorded ${summary.reparents}`)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(summary, undefined, 2))
console.log('written ' + outPath)
