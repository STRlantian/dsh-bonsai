#!/usr/bin/env node
/**
 * Re-score an attach-scope run from the session log.
 *
 * The runner guessed node ids from the record stream, but the host also records context injections
 * that never become nodes; every expected id was off by a constant. This script rebuilds the ids the
 * way the plugin allocates them (root first, then one per ingested message) and re-scores the markers
 * already recorded.
 *
 * Session shape is fixed by the runner: five seeds, then ten probes alternating
 * continuation_i / new-topic_i. So question order is [seed1..seed5, cont1, new1, cont2, new2, ...]
 * and the answer of a seed is the node right after its question.
 *
 * Usage: node scripts/score-attach-scope.mjs docs/experiments/attach-scope-follow.json
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
const data = JSON.parse(readFileSync(path, 'utf8'))
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')

function eventsOf(sessionId) {
  const suffix = sessionId.slice(-12)
  for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const dir = join(sessionsRoot, project.name)
    const found = readdirSync(dir).find(name => name.includes(suffix))
    if (found === undefined) continue
    const buffer = readFileSync(join(dir, found, 'session.v4.jsonl.zstd'))
    const starts = []
    for (let index = 0; index + 4 <= buffer.length; index++) {
      if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
    }
    let text = ''
    for (let index = 0; index < starts.length; index++) {
      const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
      try { text += zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8') } catch {}
    }
    const events = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        const event = record.event ?? record
        if (event?.type) events.push(event)
      } catch {}
    }
    return events
  }
  throw new Error('session not found: ' + sessionId)
}

const injected = event => {
  const source = event.data?.source ?? event.data?.message?.source
  if (source?.kind === 'token-tree') return true
  const text = (event.data?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('')
  return /^Current runtime context|^Time sampled|^\[/.test(text.trim())
}

/** Nodes in plugin allocation order: root n1, then one per user/assistant message and tool result. */
function nodeOrder(events) {
  const list = []
  let counter = 1
  for (const event of events) {
    if (event.type === 'user/message') {
      if (injected(event)) continue
      list.push({ kind: 'question', id: 'n' + (++counter) })
      continue
    }
    if (event.type === 'assistant/message') {
      list.push({ kind: 'answer', id: 'n' + (++counter) })
      continue
    }
    if (event.type === 'tool/result') counter++
  }
  return list
}

let continuation = { total: 0, correct: 0, marked: 0 }
let newTopic = { total: 0, marked: 0 }
for (const run of data.runs) {
  const nodes = nodeOrder(eventsOf(run.sessionId))
  const questions = nodes.filter(node => node.kind === 'question')
  const answerOf = question => {
    const at = nodes.indexOf(question)
    for (let index = at + 1; index < nodes.length; index++) if (nodes[index].kind === 'answer') return nodes[index].id
    return undefined
  }
  const seeds = questions.slice(0, 5)
  console.log(`session ${run.sessionId.slice(-8)} · nodes ${nodes.length} · questions ${questions.length}`)
  for (const [index, row] of run.rows.entries()) {
    if (row.kind === 'continuation') {
      continuation.total++
      if (row.marker !== null) continuation.marked++
      const expected = answerOf(seeds[Math.floor(index / 2)])
      const correct = row.marker === expected
      if (correct) continuation.correct++
      console.log(`  continuation expected ${String(expected).padEnd(5)} marker ${String(row.marker).padEnd(5)} ${correct ? 'ok' : 'miss'}`)
      continue
    }
    newTopic.total++
    if (row.marker !== null) newTopic.marked++
    console.log(`  new-topic     marker ${String(row.marker).padEnd(5)} ${row.marker === null ? 'ok' : 'wrong'}`)
  }
}

const fmt = value => (value.total === 0 ? '0%' : Math.round(value.marked / value.total * 100) + '%')
console.log('\n== scored from the session log ==')
console.log(`continuation: marked ${continuation.marked}/${continuation.total} (${fmt(continuation)}) · correct ${continuation.correct}/${continuation.total}`)
console.log(`new topics  : wrongly marked ${newTopic.marked}/${newTopic.total} (${fmt(newTopic)})`)
