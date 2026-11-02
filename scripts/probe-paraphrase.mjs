#!/usr/bin/env node
/**
 * Paraphrase probe: replay a session, then ask one synthetic question and see where it lands.
 *
 * Each item targets one answer. The paraphrase avoids the target's technical nouns, so the lexical
 * half should be weak; the controls keep the exact term. Three scoring variants are selected through
 * TOKEN_TREE_SEM_MODE (additive | fallback | none), which the service reads.
 *
 * Usage: node scripts/probe-paraphrase.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const labels = JSON.parse(readFileSync('docs/experiments/paraphrase-labels.json', 'utf8'))
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')

function load(project, prefix) {
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
  return { id, events }
}

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const source = load('--D-Python-AI--', labels.session)

let hits = 0
const rows = []
for (const item of labels.items) {
  const service = new TokenTreeService({ config, logger })
  const session = { id: 'para', snapshotEvents: () => [...source.events] }
  for (const event of source.events) service.handleEvent(session, event)
  const tree = service.stateOf('para').tree
  const target = [...tree.nodes.values()].find(node => node.kind === 'answer' && node.metadata?.turn === item.targetTurn)
  let seq = 100000
  const push = (type, data) => { service.handleEvent(session, { type, seq: ++seq, time: Date.now(), data }) }
  push('turn/start', { turn: 99 })
  push('user/message', { role: 'user', id: 'para-q', source: { kind: 'user' }, content: [{ type: 'text', text: item.question }] })
  const question = [...service.stateOf('para').tree.nodes.values()].find(node => node.kind === 'question' && node.content === item.question)
  const parentId = question?.parentId ?? null
  const parentTurn = [...service.stateOf('para').tree.nodes.values()].find(node => node.id === parentId)?.metadata?.turn ?? null
  const ok = target !== undefined && parentId === target.id
  if (ok) hits++
  rows.push({ ...item, target: target?.id ?? null, parentId, parentTurn, ok })
  console.log(`${ok ? '✓' : '✗'} ${item.kind.padEnd(10)} 应挂第${item.targetTurn}轮(${target?.id}) 实际 ${parentId}(轮次 ${parentTurn}) · ${item.question}`)
}
console.log(`\n命中 ${hits}/${labels.items.length} · 模式 ${process.env.TOKEN_TREE_SEM_MODE ?? 'additive'}`)
