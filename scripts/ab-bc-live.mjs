#!/usr/bin/env node
/**
 * The B/C scenario the aspect summary was meant for.
 *
 * An answer introduces two side concepts (Q/K/V, then 正弦编码/可学习编码); each is then asked about in
 * its own turn. Those follow-ups must hang under the answer that introduced them - as siblings - not
 * under each other. Two arms: the summary instruction on and off.
 *
 * Usage: node scripts/ab-bc-live.mjs --port <port> --token <token> --summary on|off
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
const summaryMode = argOf('summary', 'on') === 'on'
const outPath = argOf('out', `docs/experiments/bc-${summaryMode ? 'summary' : 'plain'}.json`)
if (port === 0 || token === '') throw new Error('usage: --port <port> --token <token> --summary on|off')
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
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error('turn did not finish: ' + text.slice(0, 40))
}
function lastAssistantText(page) {
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages[messages.length - 1]
  if (last === undefined) return ''
  return (last.data?.message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n')
}

const script = [
  { q: '请用大约 150 字介绍注意力机制，并在中间明确提到 Q、K、V 三个矩阵各自的作用。', expectParent: 0, kind: 'seed' },
  { q: '那 Q 具体是什么？一句话。', expectParent: 1, kind: 'sibling' },
  { q: '那 K 具体是什么？一句话。', expectParent: 1, kind: 'sibling' },
  { q: '那 V 具体是什么？一句话。', expectParent: 1, kind: 'sibling' },
  { q: '请用大约 150 字介绍位置编码，并在中间明确提到正弦编码与可学习编码两种做法。', expectParent: 0, kind: 'seed' },
  { q: '正弦编码具体怎么算？一句话。', expectParent: 5, kind: 'sibling' },
  { q: '可学习编码有什么缺点？一句话。', expectParent: 5, kind: 'sibling' },
]

await signIn()
await fetch(`${base}/api/token-tree/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ attachPrompt: 'any', attachChoices: 10, attachGate: 'always', attachSummary: summaryMode, autoInject: false, retrievalHint: false }),
})
const created = await rpc('session/create', { request: {} })
const sessionId = created.sessionId
await say(sessionId, '从现在起，每次回答控制在 120 字以内。')

const rows = []
for (const [index, step] of script.entries()) {
  const page = await say(sessionId, step.q)
  const answer = lastAssistantText(page)
  rows.push({
    turn: index + 1,
    kind: step.kind,
    q: step.q,
    expectParentTurn: step.expectParent,
    marker: (/\[attach:(n\d+|root|here)\]/.exec(answer) ?? [])[1] ?? null,
    summary: /\[summary:[^\]]*\]/.exec(answer)?.[0] ?? null,
  })
  console.log(`turn ${index + 1} ${step.kind.padEnd(7)} marker ${String(rows.at(-1).marker).padEnd(6)} summary ${rows.at(-1).summary === null ? '-' : 'yes'}`)
}

const treeResponse = await fetch(`${base}/api/token-tree/tree?view=nodes&session=${encodeURIComponent(sessionId)}`, { headers: { cookie } })
const nodes = (await treeResponse.json()).nodes ?? []
const questions = nodes.filter(node => node.kind === 'question').sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
const answerOfQuestion = new Map(questions.map(question => [question.id, nodes.find(node => node.kind === 'answer' && node.parentId === question.id)]))
const answerTurn = new Map(questions.map((question, index) => [answerOfQuestion.get(question.id)?.id, index + 1]))

let correct = 0
let probes = 0
for (const [index, row] of rows.entries()) {
  if (row.kind === 'seed') continue
  probes++
  const question = questions[index]
  const parentId = question?.parentId
  const wantAnswer = answerOfQuestion.get(questions[row.expectParentTurn - 1]?.id)
  const ok = parentId === wantAnswer?.id
  if (ok) correct++
  row.parentTurn = answerTurn.get(parentId) ?? null
  row.expectedAnswer = wantAnswer?.id ?? null
  row.actualParent = parentId ?? null
  row.ok = ok
  console.log(`${ok ? '✓' : '✗'} turn ${row.turn} 应挂 第${row.expectParentTurn}轮回答(${wantAnswer?.id}) 实际 ${parentId}${row.parentTurn === null ? '' : ' (第' + row.parentTurn + '轮回答)'}`)
}
console.log(`\nB/C 追问正确 ${correct}/${probes}`)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ sessionId, summaryMode, rows, correct, probes }, undefined, 2))
console.log('written ' + outPath)
