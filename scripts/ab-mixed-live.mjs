#!/usr/bin/env node
/**
 * One longer mixed conversation: new topics, stays, jumps back, a paraphrase, a requirement turn and a
 * cross-topic comparison. Every turn is scripted by hand with the parent it should get, so the same
 * run measures all decision types at once.
 *
 * Labels are by turn: `root` = a new branch, `here` = stay on the current line (requirement turn),
 * a number = the answer of that turn, which is a jump when it is not turn-1.
 *
 * Usage: node scripts/ab-mixed-live.mjs --port <port> --token <token>
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
const outPath = argOf('out', 'docs/experiments/mixed-live.json')
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
    request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' },
  })
  for (let waited = 0; waited < 1200; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error('turn did not finish: ' + text.slice(0, 40))
}

/** One entry per turn: question, expected parent, category. */
const script = [
  { q: '请介绍布隆过滤器：原理、误判率公式、常见用途，并明确提到位数组和哈希函数。', expect: 'root', kind: 'new-topic' },
  { q: '布谷鸟过滤器是什么？它和布隆过滤器的主要区别，请明确提到指纹和桶。', expect: 1, kind: 'continue' },
  { q: '那这两者的误判率差别大吗？一句话。', expect: 2, kind: 'stay' },
  { q: '假阳性概率怎么才能降下来？', expect: 1, kind: 'synonym-jump' },
  { q: '缓存穿透是什么？一般怎么防？', expect: 'root', kind: 'new-topic' },
  { q: '用布隆过滤器防穿透，会带来什么风险？一句话。', expect: 5, kind: 'stay' },
  { q: '一致性哈希解决什么问题？请提到虚拟节点。', expect: 'root', kind: 'new-topic' },
  { q: '虚拟节点为什么能改善数据分布？一句话。', expect: 7, kind: 'stay' },
  { q: '回到布隆过滤器：位数组太小会发生什么？', expect: 1, kind: 'jump' },
  { q: '布谷鸟过滤器支持删除吗？一句话。', expect: 2, kind: 'jump' },
  { q: '从现在开始，你只回答"对"或"错"，不要解释。', expect: 'here', kind: 'requirement' },
  { q: '虚拟节点的数量是越多越好吗？', expect: 8, kind: 'jump' },
  { q: '分布式锁为什么必须有过期时间？', expect: 'root', kind: 'new-topic' },
  { q: '业务还没跑完锁就过期了，怎么办？', expect: 13, kind: 'stay' },
  { q: '比较布隆过滤器和布谷鸟过滤器在内存占用上的差异。', expect: 2, kind: 'cross-topic' },
  { q: '把刚才那个内存比较再具体一点。', expect: 15, kind: 'stay' }
]

await signIn()
await fetch(`${base}/api/token-tree/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ attachPrompt: 'any', attachChoices: 10, attachGate: 'always', attachSummary: false, autoInject: false, retrievalHint: false }),
})
const created = await rpc('session/create', { request: {} })
const sessionId = created.sessionId
await say(sessionId, '从现在起，每次回答控制在 120 字以内。')

for (const [index, step] of script.entries()) {
  const page = await say(sessionId, step.q)
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages.at(-1)
  const answer = last === undefined ? '' : (last.data?.message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('')
  const marker = /\[attach:(n\d+|root|here)\]/.exec(answer)
  console.log(`turn ${String(index + 1).padStart(2)} ${step.kind.padEnd(13)} marker ${String(marker === null ? '-' : marker[1]).padEnd(6)} ${step.q.slice(0, 26)}`)
}

const treeResponse = await fetch(`${base}/api/token-tree/tree?view=nodes&session=${encodeURIComponent(sessionId)}`, { headers: { cookie } })
const nodes = (await treeResponse.json()).nodes ?? []
const byTurn = new Map()
for (const node of nodes) if (node.kind === 'answer' && typeof node.turn === 'number') byTurn.set(node.turn, node)
const questions = nodes.filter(node => node.kind === 'question').sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
const rootId = nodes.find(node => node.kind === 'note')?.id

let correct = 0
const rows = []
for (const [index, step] of script.entries()) {
  const question = questions[index]
  const parentId = question?.parentId ?? null
  const parentTurn = nodes.find(node => node.id === parentId)?.turn ?? null
  const expectedId = step.expect === 'root' ? rootId : step.expect === 'here' ? byTurn.get(index)?.id : byTurn.get(step.expect)?.id
  const ok = parentId === expectedId
  if (ok) correct++
  rows.push({ turn: index + 1, kind: step.kind, expected: step.expect, parentId, parentTurn, ok })
  console.log(`${ok ? '✓' : '✗'} ${step.kind.padEnd(13)} 期望 ${String(step.expect).padEnd(5)} 实际 ${String(parentId).padEnd(5)}(第${parentTurn}轮)`)
}
console.log(`\n混合会话命中 ${correct}/${script.length} = ${Math.round(correct / script.length * 100)}%`)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ sessionId, rows, correct }, undefined, 2))
console.log('written ' + outPath)
