#!/usr/bin/env node
/**
 * Score the live learning run by turn numbers instead of node ids.
 *
 * Ids differ between the labelled session and the live one (a tool call shifts parity), so the label
 * is translated to the turn whose answer introduced the concept, and the live tree is asked which
 * answer a question actually hangs under.
 *
 * Usage: node scripts/score-learn-live.mjs <run.json> <port> <token>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const [runPath, portArg, token] = process.argv.slice(2)
const run = JSON.parse(readFileSync(runPath, 'utf8'))
const labels = JSON.parse(readFileSync('docs/experiments/learning-labels.json', 'utf8'))
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')

function replay(project, prefix) {
  const dir = join(sessionsRoot, project)
  const id = readdirSync(dir).find(name => name.includes(prefix))
  const buffer = readFileSync(join(dir, id, 'session.v4.jsonl.zstd'))
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
  const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
  const service = new TokenTreeService({ config: Config['~standard'].validate({ logEdgeUpdates: false }).value, logger })
  const session = { id, snapshotEvents: () => events }
  for (const event of events) service.handleEvent(session, event)
  return { id, tree: service.stateOf(id).tree }
}

// The labels are sequential: question k hangs under the answer of question k-1, except question 6,
// which returns to the answer of question 1 ("from the original motivation again"), and question 8,
// a requirement turn that stays on the previous line.
const EXPECTED_INDEX_OF = index => (index === 5 ? 0 : index - 1)

const base = `http://127.0.0.1:${portArg}`
const signIn = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (signIn.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
const response = await fetch(`${base}/api/token-tree/tree?view=nodes&session=${encodeURIComponent(run.sessionId)}`, { headers: { cookie } })
const payload = await response.json()
const nodes = payload.nodes ?? []
const kindOf = new Map(nodes.map(node => [node.id, node.kind]))
const rootId = nodes.find(node => node.kind === 'note')?.id
const answerByTurn = new Map(nodes.filter(node => node.kind === 'answer').map(node => [node.turn, node.id]))
const questions = nodes.filter(node => node.kind === 'question').sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))

let correct = 0
const rows = []
for (const [index, label] of labels.labels.entries()) {
  const question = questions[index]
  if (question === undefined) continue
  const parentId = question.parentId
  const wanted = questions[EXPECTED_INDEX_OF(index)]
  const expected = wanted === undefined
    ? rootId
    : (nodes.filter(node => node.kind === 'answer' && node.parentId === wanted.id)[0]?.id ?? rootId)
  const ok = parentId === expected
  if (ok) correct++
  rows.push({ label: label.question, turn: question.turn, expected, actual: parentId, ok })
  console.log(`${ok ? '✓' : '✗'} 第 ${index + 1} 问(标注 ${label.question}) 期望 ${expected} 实际 ${parentId} [${kindOf.get(parentId)}]`)
}
console.log(`\ncorrect ${correct}/${rows.length}`)
