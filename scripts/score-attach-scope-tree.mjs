#!/usr/bin/env node
/**
 * Score an attach-scope run against the plugin's own tree, not a guess at node ids.
 *
 * The plugin serves the real payload at /api/token-tree/tree, where every node carries its turn.
 * The runner's session shape is fixed: turns 1-5 are the seeds, turns 6-15 alternate
 * continuation_i / new-topic_i. So a continuation at row i should name the answer of turn
 * floor(i/2)+1, and a new topic should name nothing.
 *
 * Usage: node scripts/score-attach-scope-tree.mjs <json> <port> <token>
 */
import { readFileSync } from 'node:fs'

const [jsonPath, portArg, token] = process.argv.slice(2)
const base = `http://127.0.0.1:${portArg}`
const data = JSON.parse(readFileSync(jsonPath, 'utf8'))
const signIn = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (signIn.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
if (cookie === '') throw new Error('no cookie')

let continuation = { total: 0, correct: 0, marked: 0 }
let newTopic = { total: 0, marked: 0 }

for (const run of data.runs) {
  const response = await fetch(`${base}/api/token-tree/tree?view=nodes&session=${encodeURIComponent(run.sessionId)}`, { headers: { cookie } })
  const payload = await response.json()
  const nodes = payload.nodes ?? []
  const answerByTurn = new Map()
  for (const node of nodes) {
    if (node.kind === 'answer' && typeof node.turn === 'number') answerByTurn.set(node.turn, node.id)
  }
  console.log(`session ${run.sessionId.slice(-8)} · nodes ${nodes.length} · answers by turn ${[...answerByTurn.keys()].sort((a, b) => a - b).join(',')}`)
  for (const [index, row] of run.rows.entries()) {
    if (row.kind === 'continuation') {
      continuation.total++
      if (row.marker !== null) continuation.marked++
      const expected = answerByTurn.get(Math.floor(index / 2) + 1)
      const correct = expected !== undefined && row.marker === expected
      if (correct) continuation.correct++
      console.log(`  continuation expected ${String(expected ?? '-').padEnd(5)} marker ${String(row.marker ?? '-').padEnd(5)} ${correct ? 'ok' : 'miss'}`)
      continue
    }
    newTopic.total++
    if (row.marker !== null) newTopic.marked++
    console.log(`  new-topic     marker ${String(row.marker ?? '-').padEnd(5)} ${row.marker === null ? 'ok' : 'wrong'}`)
  }
}

const rate = value => (value.total === 0 ? '0%' : Math.round(value.marked / value.total * 100) + '%')
console.log('\n== scored against the plugin tree ==')
console.log(`continuation: marked ${continuation.marked}/${continuation.total} (${rate(continuation)}) · correct ${continuation.correct}/${continuation.total}`)
console.log(`new topics  : wrongly marked ${newTopic.marked}/${newTopic.total} (${rate(newTopic)})`)
