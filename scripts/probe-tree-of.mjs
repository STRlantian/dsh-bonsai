#!/usr/bin/env node
/**
 * Rebuild one session's tree offline with the plugin's own code, and report what it decided.
 *
 * Reads the durable log, replays the events through `TokenTreeService.backfillFromSession`, then
 * prints the node tree (kind, parent, preview, tokens) plus the fold evidence: placeholders in
 * the log and the billed prompt per turn.
 *
 * Usage: node scripts/probe-tree-of.mjs <session-id-prefix> [project]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const prefix = process.argv[2]
const project = process.argv[3] ?? '--D-dsh-token-tree--'
const root = 'C:/Users/ASUS/.dsh/sessions'

const dir = join(root, project)
let file = ''
let sessionId = ''
for (const id of readdirSync(dir)) {
  if (!id.includes(prefix)) continue
  const candidate = join(dir, id, 'session.v4.jsonl.zstd')
  if (statSync(candidate).isFile()) {
    file = candidate
    sessionId = id
  }
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
    if (event?.type) events.push({ type: event.type, seq: event.seq, data: event.data })
  } catch {}
}

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })
service.backfillFromSession({ id: sessionId, snapshotEvents: () => events })

const tree = service.treeOf(sessionId)
const nodes = [...tree.nodes.values()]
const byId = new Map(nodes.map(node => [node.id, node]))

const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text')
  .map(block => block.text)
  .join(' ')
  .replace(/\s+/g, ' ')
  .slice(0, 60)

console.log(`session ${sessionId} · ${events.length} events · ${nodes.length} nodes\n`)
console.log('id     kind           turn  parent  tokens  preview')
for (const node of nodes) {
  console.log(
    `${node.id.padEnd(6)} ${String(node.kind).padEnd(14)} ${String(node.metadata.turn ?? '-').padStart(4)}  `
    + `${String(node.parentId ?? '-').padEnd(6)}  ${String(node.tokens).padStart(6)}  ${(node.summary ?? node.content).replace(/\s+/g, ' ').slice(0, 56)}`,
  )
}

// Children per parent: a runaway branch means everything hangs off one node.
const children = new Map()
for (const node of nodes) {
  const key = node.parentId ?? '__root__'
  children.set(key, (children.get(key) ?? 0) + 1)
}
const forks = [...children.entries()].filter(([, count]) => count > 1)
console.log(`\nroots: ${children.get('__root__') ?? 0} · fork points: ${forks.length} · max fan-out: ${Math.max(0, ...children.values())}`)

// Fold evidence, straight from the log.
const placeholders = events.filter(event => event.type === 'user/message' && JSON.stringify(event.data ?? {}).includes('已折叠'))
const shadowed = new Set()
for (const event of events) for (const seq of event.sourceEventSeqs ?? []) shadowed.add(seq)
console.log(`fold placeholders: ${placeholders.length} · shadowed seqs: ${shadowed.size}`)

const prompts = []
for (const event of events) {
  const usage = event.type === 'assistant/message' ? event.data?.usage : undefined
  if (usage === undefined) continue
  prompts.push((usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
}
console.log(`prompt per call: ${prompts.join(' → ')}`)
console.log(`tool calls: ${events.filter(event => event.type === 'tool/call').length} · tool results: ${events.filter(event => event.type === 'tool/result').length}`)
