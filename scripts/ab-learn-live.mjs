#!/usr/bin/env node
/**
 * Live check of letting the model place the turns of a learning conversation.
 *
 * Replays the 18 questions from the labelled attention session (docs/experiments/learning-labels.json)
 * into a fresh session with a short-answer instruction, then scores where each question actually
 * landed against where the label says it should: the answer that introduced the concept, the root for
 * a new topic, or the current line for a requirement turn.
 *
 * Usage: node scripts/ab-learn-live.mjs --port <port> --token <token>
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
const outPath = argOf('out', 'docs/experiments/learn-live.json')
const summaryMode = argOf('summary', 'on') === 'on'
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

const labels = JSON.parse(readFileSync('docs/experiments/learning-labels.json', 'utf8'))
// The old session's node ids map to turn numbers: answer(1) = n3, answer(k) = n(2k+1).
const turnOfAnswer = id => (Number(id.slice(1)) - 1) / 2
const questions = labels.labels.map(label => ({ id: label.question, expected: label.expected, confidence: label.confidence }))

await signIn()
await fetch(`${base}/api/token-tree/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ attachPrompt: 'any', attachChoices: 10, attachGate: 'always', attachSummary: summaryMode, autoInject: false, retrievalHint: false }),
})
const created = await rpc('session/create', { request: {} })
const sessionId = created.sessionId
// One instruction turn, recorded as a constraint; the questions themselves stay untouched.
await say(sessionId, '从现在开始，每次回答控制在 60 字以内，并在最后按注入的提示写一行标记。')

// The questions themselves, in order: the labels reference the old ids, the text comes from the log.
const source = JSON.parse(readFileSync('docs/experiments/learning-questions.json', 'utf8'))
const rows = []
for (const [index, question] of questions.entries()) {
  const text = source.questions[index]
  const page = await say(sessionId, text)
  const answer = lastAssistantText(page)
  const marker = /\[attach:(n\d+|root|here)\]/.exec(answer)
  const summary = /\[summary:[^\]]*\]/.exec(answer)
  rows.push({ turn: index + 1, expected: question.expected, marker: marker === null ? null : marker[1], summary: summary === null ? null : summary[0].slice(0, 40), answer: answer.slice(0, 60) })
  console.log(`turn ${String(index + 1).padStart(2)} expected ${String(question.expected).padEnd(5)} marker ${String(marker === null ? '-' : marker[1]).padEnd(5)} ${marker === null ? '' : ''}`)
}

// Where did each question actually land? Ask the plugin's tree.
const treeResponse = await fetch(`${base}/api/token-tree/tree?view=nodes&session=${encodeURIComponent(sessionId)}`, { headers: { cookie } })
const tree = await treeResponse.json()
const nodes = tree.nodes ?? []
const byTurn = new Map()
for (const node of nodes) {
  if (node.kind === 'answer' && typeof node.turn === 'number') byTurn.set(node.turn, node.id)
}
const questionNodes = nodes.filter(node => node.kind === 'question' && typeof node.turn === 'number').sort((a, b) => a.turn - b.turn)
const kindOf = new Map(nodes.map(node => [node.id, node.kind]))
let correct = 0
for (const [index, row] of rows.entries()) {
  const questionNode = questionNodes[index]
  const rootId = nodes.find(node => node.kind === 'note')?.id
  const parentKind = kindOf.get(questionNode?.parentId) ?? (questionNode?.parentId === rootId ? 'note' : 'unknown')
  const actual = questionNode?.parentId === rootId || parentKind === 'note' ? 'root' : questionNode.parentId
  // Map an expected old answer id to this session's answer of the same turn.
  const expected = row.expected === 'root' || row.expected === 'here'
    ? null
    : byTurn.get(turnOfAnswer(row.expected))
  const ok = row.expected === 'root'
    ? actual === 'root'
    : row.expected === 'here'
      ? parentKind === 'answer'
      : actual === expected
  if (ok) correct++
  row.actual = actual
  row.ok = ok
  console.log(`${ok ? '✓' : '✗'} turn ${row.turn} expected ${row.expected} → actual ${actual} (${parentKind})`)
}
console.log(`\ncorrect ${correct}/${rows.length} | marked ${rows.filter(row => row.marker !== null).length}`)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify({ sessionId, rows, correct }, undefined, 2))
console.log('written ' + outPath)
