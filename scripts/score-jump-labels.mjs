#!/usr/bin/env node
/**
 * Score attachment on the jump-only set.
 *
 * Replays the labelled session, then appends each question and records where it lands. The expected
 * parent is identified by turn, so the result does not depend on node ids. Reports per item plus a
 * total, and honours TOKEN_TREE_* experiment flags if they are set.
 *
 * Usage: node scripts/score-jump-labels.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const labels = JSON.parse(readFileSync('docs/experiments/jump-labels.json', 'utf8'))
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

const dir = join(sessionsRoot, '--D-Python-AI--')
const id = readdirSync(dir).find(name => name.includes(labels.session))
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

const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
let correct = 0
for (const item of labels.items) {
  // A fresh replay per item: appending several questions to one tree would let each one inherit the
  // previous question as its default parent, which is not the state a real turn starts from.
  const service = new TokenTreeService({ config, logger })
  const session = { id: 'jump', snapshotEvents: () => events }
  for (const event of events) service.handleEvent(session, event)
  let seq = 1_000_000
  const push = (type, data) => { service.handleEvent(session, { type, seq: ++seq, time: Date.now(), data }) }
  const turn = Math.max(0, ...[...service.stateOf('jump').tree.nodes.values()].map(node => node.metadata?.turn ?? 0)) + 1
  push('turn/start', { turn })
  push('user/message', { role: 'user', id: 'jump-' + seq, source: { kind: 'user' }, content: [{ type: 'text', text: item.question }] })
  const question = [...service.stateOf('jump').tree.nodes.values()].find(node => node.kind === 'question' && node.content === item.question)
  const parent = question === undefined ? undefined : service.stateOf('jump').tree.nodes.get(question.parentId)
  const parentTurn = parent?.metadata?.turn ?? null
  const ok = item.expectedTurn === parentTurn
  if (ok) correct++
  console.log(`${ok ? '✓' : '✗'} 期望第${String(item.expectedTurn).padStart(2)}轮 · 实际 ${String(parent?.id ?? '-').padEnd(5)}(第${parentTurn}轮) · ${item.question}`)
}
console.log(`\n跳跃集命中 ${correct}/${labels.items.length} = ${Math.round(correct / labels.items.length * 100)}%`)
