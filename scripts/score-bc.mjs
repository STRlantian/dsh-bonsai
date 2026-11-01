#!/usr/bin/env node
/**
 * Score the B/C run by matching the scripted question text to the question node.
 *
 * The runner's list of question nodes includes the first instruction turn (it was classified as a
 * topic), so indexing by position is off by one. Matching by text removes that.
 *
 * Usage: node scripts/score-bc.mjs <run.json> <port> <token>
 */
import { readFileSync } from 'node:fs'

const SCRIPT = [
  { q: '请用大约 150 字介绍注意力机制', expectAnswerTurn: null },
  { q: '那 Q 具体是什么', expectAnswerTurn: 1 },
  { q: '那 K 具体是什么', expectAnswerTurn: 1 },
  { q: '那 V 具体是什么', expectAnswerTurn: 1 },
  { q: '请用大约 150 字介绍位置编码', expectAnswerTurn: null },
  { q: '正弦编码具体怎么算', expectAnswerTurn: 5 },
  { q: '可学习编码有什么缺点', expectAnswerTurn: 5 },
]

const [runPath, portArg, token] = process.argv.slice(2)
const run = JSON.parse(readFileSync(runPath, 'utf8'))
const base = `http://127.0.0.1:${portArg}`
const signIn = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (signIn.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
const response = await fetch(`${base}/api/token-tree/tree?view=nodes&session=${encodeURIComponent(run.sessionId)}`, { headers: { cookie } })
const nodes = (await response.json()).nodes ?? []
const questions = nodes.filter(node => node.kind === 'question')
const answerByTurn = new Map(nodes.filter(node => node.kind === 'answer').map(node => [node.turn, node.id]))
const questionOf = text => questions.find(node => String(node.preview ?? '').includes(text))

let correct = 0
let probes = 0
for (const step of SCRIPT) {
  if (step.expectAnswerTurn === null) continue
  const question = questionOf(step.q)
  if (question === undefined) { console.log(`?? 没找到问题：${step.q}`); continue }
  probes++
  const expected = answerByTurn.get(step.expectAnswerTurn) ?? null
  const ok = question.parentId === expected
  if (ok) correct++
  const parentTurn = nodes.find(node => node.id === question.parentId)?.turn ?? null
  console.log(`${ok ? '✓' : '✗'} ${step.q} → 应挂 第${step.expectAnswerTurn}轮回答(${expected}) 实际 ${question.parentId}(轮次 ${parentTurn})`)
}
console.log(`\nB/C 追问正确 ${correct}/${probes} · 摘要 ${run.summaryMode ? '开' : '关'} · 摘要条数 ${run.rows.filter(row => row.summary !== null).length}/${run.rows.length}`)
