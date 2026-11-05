#!/usr/bin/env node
/**
 * Live A/B of the fold trigger: one conversation per arm, then the real usage numbers from the
 * session log.
 *
 * Arms only differ in the fold settings, which are written as session overrides so the global file is
 * untouched:
 *   history   foldTrigger=history, the old rule (whole visible prompt above the threshold)
 *   block     foldTrigger=block, the new rule (the block about to leave above the threshold and
 *             above a multiple of the keep window)
 *
 * Results: folds, peak prompt, and cost with a cache hit at 1/50 of a miss.
 *
 * Usage: node scripts/ab-fold-trigger.mjs --port 19901 --token <token> --arm block --label block40
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const port = Number(argOf('port', '0'))
const token = argOf('token', '')
const arm = argOf('arm', 'block')
const label = argOf('label', arm)
const turns = Number(argOf('turns', '10'))
const floor = Number(argOf('floor', '3000'))
const ratio = Number(argOf('ratio', '5'))
if (port === 0 || token === '') throw new Error('usage: --port <port> --token <token> --arm <history|block>')
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
    request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' },
  })
  for (let waited = 0; waited < 1200; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error('turn did not finish: ' + text.slice(0, 40))
}

const questions = [
  '请用约 300 字解释：什么是缓存穿透、缓存击穿、缓存雪崩，三者区别和各自常见防护手段。',
  '继续用约 300 字说明：布隆过滤器的误判率公式怎么来的，参数怎么选。',
  '再用约 300 字讲讲：一致性哈希为什么需要虚拟节点，虚拟节点数量怎么定。',
  '用约 300 字解释：分布式锁的过期时间和看门狗续期机制，以及时钟漂移的影响。',
  '用约 300 字说明：数据库索引为什么用 B+ 树而不是红黑树，页大小如何影响选择。',
  '用约 300 字讲讲：MVCC 的实现原理，以及它如何避免读写互相阻塞。',
  '用约 300 字说明：TCP 拥塞控制的四个阶段，以及和滑动窗口的分工。',
  '用约 300 字解释：Raft 的选举过程，任期和日志匹配如何保证一致性。',
  '用约 300 字说明：LSM 树的写入放大问题，以及各层压缩策略的取舍。',
  '用约 300 字总结：一个高并发读写系统的缓存、存储、一致性设计要点。'
]

await signIn()
const created = await rpc('session/create', { request: {} })
const sessionId = created.sessionId
const patch = arm === 'history'
  ? { foldTrigger: 'history', foldAboveTokens: floor, foldBlockRatio: 0, foldCadence: 1 }
  : { foldTrigger: 'block', foldAboveTokens: floor, foldBlockRatio: ratio, foldCadence: 1 }
const applied = await fetch(`${base}/api/token-tree/settings?session=${encodeURIComponent(sessionId)}`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify(patch),
})
console.log(`arm ${arm} · session patch ${applied.status} · ${JSON.stringify(patch)}`)

for (const [index, question] of questions.slice(0, turns).entries()) {
  await say(sessionId, question)
  process.stdout.write(`  turn ${index + 1}/${turns}\n`)
}

// Usage and folds come from the durable log, not from the streaming frames.
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
let file = null
for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  const hit = readdirSync(join(sessionsRoot, project.name)).find(name => name.includes(sessionId))
  if (hit !== undefined) { file = join(sessionsRoot, project.name, hit, 'session.v4.jsonl.zstd'); break }
}
if (file === null) throw new Error('session log not found')
const buffer = readFileSync(file)
const starts = []
for (let index = 0; index + 4 <= buffer.length; index++) {
  if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
}
const events = []
for (let index = 0; index < starts.length; index++) {
  const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
  let chunk = ''
  try { chunk = zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8') } catch {}
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    try { const record = JSON.parse(line); const event = record.event ?? record; if (event?.type) events.push(event) } catch {}
  }
}

const steps = []
for (const event of events) {
  if (event.type !== 'assistant/message' || event.data?.usage === undefined) continue
  const usage = event.data.usage
  steps.push({
    turn: event.data.turn,
    step: event.data.step,
    input: usage.inputTokens ?? 0,
    cached: usage.cacheReadTokens ?? 0,
    written: usage.cacheWriteTokens ?? 0,
    output: usage.outputTokens ?? 0,
  })
}
const folds = events.filter(event => event.surfaceOp !== null && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace').length
const promptOf = step => step.input + step.cached
const cost = steps.reduce((sum, step) => sum + step.input + step.cached / 50 + step.written, 0)
const peak = steps.reduce((max, step) => Math.max(max, promptOf(step)), 0)
const summary = {
  arm,
  label,
  sessionId,
  steps: steps.length,
  folds,
  cost: Math.round(cost),
  peak,
  meanPrompt: Math.round(steps.reduce((sum, step) => sum + promptOf(step), 0) / Math.max(1, steps.length)),
  newInput: steps.reduce((sum, step) => sum + step.input, 0),
  cached: steps.reduce((sum, step) => sum + step.cached, 0),
}
console.log('RESULT ' + JSON.stringify(summary))
