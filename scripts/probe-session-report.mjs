#!/usr/bin/env node
/**
 * One report for a session: the tree it built, the folds it applied, and what each call cost.
 *
 * Usage: node scripts/probe-session-report.mjs <session-prefix> [project]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const prefix = process.argv[2]
const project = process.argv[3] ?? '--D-dsh-token-tree--'
const dir = join('C:/Users/ASUS/.dsh/sessions', project)

let file = ''
let sessionId = ''
for (const id of readdirSync(dir)) {
  if (!id.includes(prefix)) continue
  file = join(dir, id, 'session.v4.jsonl.zstd')
  sessionId = id
}
if (file === '') throw new Error(`no session matching ${prefix}`)

const buffer = readFileSync(file)
const starts = []
for (let i = 0; i + 4 <= buffer.length; i++) {
  if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
}
let text = ''
for (let i = 0; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
  try { text += zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8') } catch {}
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

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })
const session = { id: sessionId, snapshotEvents: () => events }
service.backfillFromSession(session)

const tree = service.stateOf(sessionId).tree
const nodes = [...tree.nodes.values()]
const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text')
  .map(block => block.text)
  .join(' ')

console.log(`session ${sessionId.slice(-8)} · ${events.length} events · ${nodes.length} nodes · history ${service.historyTokens(sessionId)} tok · path ${service.conversationTokens(sessionId)} tok\n`)
console.log('id     kind           turn  parent  tokens  reasoning  preview')
for (const node of nodes) {
  const reasoning = node.metadata.reasoningTokens ?? 0
  console.log(
    `${node.id.padEnd(6)} ${String(node.kind).padEnd(14)} ${String(node.metadata.turn ?? '-').padStart(4)}  `
    + `${String(node.parentId ?? '-').padEnd(6)}  ${String(node.tokens).padStart(6)}  ${String(reasoning).padStart(9)}  ${(node.summary ?? node.content).replace(/\s+/g, ' ').slice(0, 40)}`,
  )
}

const children = new Map()
for (const node of nodes) {
  const key = node.parentId ?? '__root__'
  children.set(key, (children.get(key) ?? 0) + 1)
}
const roots = nodes.filter(node => node.parentId === null || node.parentId === tree.rootId)
console.log(`\nroot children: ${roots.map(node => `${node.id}(${(node.summary ?? node.content).slice(0, 14)})`).join(', ')}`)

const placeholders = events.filter(event => JSON.stringify(event.data ?? {}).includes('已折叠'))
const shadowed = new Set()
for (const event of events) for (const seq of event.sourceEventSeqs ?? []) shadowed.add(seq)
console.log(`fold placeholders: ${placeholders.length} · shadowed seqs: ${shadowed.size}`)

console.log('\ncall  turn  input  cacheRead  cacheWrite  total  hit%')
let turn = 0
let index = 0
for (const event of events) {
  if (event.type === 'turn/start') turn = event.data?.turn ?? turn + 1
  if (event.type !== 'assistant/message' || event.data?.usage === undefined) continue
  const usage = event.data.usage
  const input = usage.inputTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const total = input + cacheRead + cacheWrite
  index++
  console.log(`${String(index).padStart(4)} ${String(turn).padStart(5)} ${String(input).padStart(6)} ${String(cacheRead).padStart(10)} ${String(cacheWrite).padStart(11)} ${String(total).padStart(6)} ${(total === 0 ? 0 : (cacheRead / total * 100)).toFixed(1).padStart(5)}`)
}
