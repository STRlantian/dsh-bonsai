#!/usr/bin/env node
/**
 * Does the attach block work for more than anaphora? Two instruction modes, same script.
 *
 * Each session plants five topics, then probes ten times: five continuations (paraphrased so the
 * lexical signal is weak) and five unrelated new topics. A continuation is "correct" when the model
 * names the answer of the topic it refers to; a new topic is correct when it names nothing.
 *
 * Node ids are derived from the record order (root n1, then one id per user/assistant message), so
 * the expected target is known without trusting the model.
 *
 * Usage:
 *   node scripts/ab-attach-scope.mjs --port 19651 --token <t> --mode follow|any [--sessions 2]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const port = Number(argOf('port', '0'))
const token = argOf('token', '')
const mode = argOf('mode', 'follow')
const sessions = Number(argOf('sessions', '2'))
const outPath = argOf('out', `docs/experiments/attach-scope-${mode}.json`)
if (port === 0 || token === '') throw new Error('usage: --port <port> --token <token> --mode follow|any')
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
/** Node ids in record order: root n1, then one id per durable message. */
function idsOf(page) {
  let counter = 1
  const ids = []
  for (const record of recordsOf(page)) {
    if (record.type === 'user/message') {
      const source = record.data?.source?.kind ?? record.data?.message?.source?.kind
      if (source === 'token-tree') continue
      ids.push({ type: 'user', id: 'n' + (++counter), text: (record.data?.content ?? []).filter(p => p?.type === 'text').map(p => p.text).join('') })
      continue
    }
    if (record.type === 'assistant/message') {
      ids.push({ type: 'assistant', id: 'n' + (++counter) })
      continue
    }
    if (record.type === 'tool/result') counter++
  }
  return ids
}
function injectedLast(page) {
  const blocks = recordsOf(page)
    .filter(record => record.type === 'user/message')
    .map(record => ({ source: record.data?.source?.kind ?? record.data?.message?.source?.kind, text: (record.data?.content ?? []).filter(p => p?.type === 'text').map(p => p.text).join('') }))
    .filter(entry => entry.source === 'token-tree')
  return blocks.length === 0 ? '' : blocks[blocks.length - 1].text
}

const topics = [
  { key: 'bloom', seed: '记录一个事实：布隆过滤器的误判率大约由位数组大小与哈希函数个数决定。请用 120 字说明。', probe: '刚才那个概率估算的问题，为什么元素越多越糟？一句话。' },
  { key: 'rbtree', seed: '记录一个事实：红黑树插入后需要变色与旋转来恢复性质。请用 120 字说明。', probe: '那个平衡结构的修复步骤，能不能只用一次旋转？一句话。' },
  { key: 'cursor', seed: '记录一个事实：分页游标要用不重复且单调的键，否则会漏行。请用 120 字说明。', probe: '前面说的翻页越翻越慢的问题，根子在哪？一句话。' },
  { key: 'idem', seed: '记录一个事实：幂等键要放在服务端存储并保留一段时间。请用 120 字说明。', probe: '那个重复提交的防护，过期时间怎么定？一句话。' },
  { key: 'lock', seed: '记录一个事实：分布式锁需要续期，否则业务没跑完锁就没了。请用 120 字说明。', probe: '刚才那个锁提前释放的问题，怎么避免？一句话。' },
]
const fresh = [
  '顺便问一下，KMP 的 next 数组怎么构造？一句话。',
  '再问个别的：TCP 三次握手为什么不是两次？一句话。',
  '换个话题：一致性哈希的虚拟节点解决什么问题？一句话。',
  '另一个问题：B+ 树的叶子节点为什么要链表相连？一句话。',
  '还有个事：HTTP/2 的多路复用解决了什么？一句话。',
]

await signIn()
const patched = await fetch(`${base}/api/token-tree/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ attachPrompt: mode, attachChoices: 10 }),
})
if (!patched.ok) throw new Error('settings patch failed: ' + patched.status)

const runs = []
for (let session = 0; session < sessions; session++) {
  const created = await rpc('session/create', { request: {} })
  const sessionId = created.sessionId
  const topicAnswer = new Map()
  for (const topic of topics) {
    const page = await say(sessionId, topic.seed)
    const ids = idsOf(page)
    const answers = ids.filter(entry => entry.type === 'assistant')
    topicAnswer.set(topic.key, answers[answers.length - 1]?.id)
  }
  const probes = []
  for (let index = 0; index < topics.length; index++) {
    probes.push({ kind: 'continuation', topic: topics[index], text: topics[index].probe })
    probes.push({ kind: 'new-topic', text: fresh[index] })
  }
  const rows = []
  for (const probe of probes) {
    const page = await say(sessionId, probe.text)
    const answer = lastAssistantText(page)
    const marker = /\[attach:(n\d+|root)\]/.exec(answer)
    const block = injectedLast(page)
    const offered = [...block.matchAll(/^- (n\d+) ·/gm)].map(match => match[1])
    const expected = probe.kind === 'continuation' ? topicAnswer.get(probe.topic.key) : null
    const named = marker === null ? null : marker[1]
    rows.push({
      kind: probe.kind,
      expected,
      marker: named,
      valid: named === null ? null : named === 'root' ? true : offered.includes(named),
      correct: probe.kind === 'continuation' ? named === expected : named === null,
      offered: offered.length,
    })
  }
  const page = await pageOf(sessionId)
  const usage = recordsOf(page).filter(record => record.type === 'assistant/message' && record.data?.usage !== undefined).map(record => record.data.usage)
  const sum = key => usage.reduce((total, entry) => total + (entry[key] ?? 0), 0)
  runs.push({ sessionId, rows, steps: usage.length, input: sum('inputTokens'), cacheRead: sum('cacheReadTokens'), output: sum('outputTokens') })
  const cont = rows.filter(row => row.kind === 'continuation')
  const freshRows = rows.filter(row => row.kind === 'new-topic')
  console.log(`session ${session + 1}: continuation marked ${cont.filter(r => r.marker !== null).length}/${cont.length} · correct ${cont.filter(r => r.correct).length}/${cont.length} · new-topic wrongly marked ${freshRows.filter(r => r.marker !== null).length}/${freshRows.length} · steps ${usage.length}`)
}

const all = runs.flatMap(run => run.rows)
const cont = all.filter(row => row.kind === 'continuation')
const freshRows = all.filter(row => row.kind === 'new-topic')
const summary = {
  mode,
  sessions,
  turns: all.length,
  continuation: { total: cont.length, marked: cont.filter(row => row.marker !== null).length, correct: cont.filter(row => row.correct).length },
  newTopic: { total: freshRows.length, marked: freshRows.filter(row => row.marker !== null).length },
  tokens: runs.reduce((acc, run) => ({ input: acc.input + run.input, cacheRead: acc.cacheRead + run.cacheRead, output: acc.output + run.output, steps: acc.steps + run.steps }), { input: 0, cacheRead: 0, output: 0, steps: 0 }),
  runs,
}
console.log('\n== summary ==')
console.log(`mode ${mode} · continuation ${summary.continuation.correct}/${summary.continuation.total} correct (marked ${summary.continuation.marked}) · new-topic wrongly marked ${summary.newTopic.marked}/${summary.newTopic.total}`)
console.log(`tokens: input ${summary.tokens.input} · cache ${summary.tokens.cacheRead} · output ${summary.tokens.output} over ${summary.tokens.steps} steps`)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(summary, undefined, 2))
console.log('written ' + outPath)
