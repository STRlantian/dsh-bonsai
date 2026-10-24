#!/usr/bin/env node
/**
 * Report the shape of a session's tree: every root, every orphan, and the parent of each node.
 *
 * Usage: node scripts/probe-tree-roots.mjs <session-prefix> [project]
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
if (file === '') throw new Error('no session')

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
service.backfillFromSession({ id: sessionId, snapshotEvents: () => events })

const tree = service.stateOf(sessionId).tree
const nodes = [...tree.nodes.values()]
const byId = new Map(nodes.map(node => [node.id, node]))
const roots = nodes.filter(node => node.parentId === null)
const orphans = nodes.filter(node => node.parentId !== null && !byId.has(node.parentId))

console.log(`nodes ${nodes.length} · roots ${roots.length} · orphans ${orphans.length} · rootId ${tree.rootId}\n`)
for (const root of roots) {
  console.log(`root ${root.id} [${root.kind}] ${(root.summary ?? root.content).replace(/\s+/g, ' ').slice(0, 40)}`)
}
if (roots.length > 1) {
  console.log('\nchildren of each root:')
  for (const root of roots) {
    const kids = nodes.filter(node => node.parentId === root.id)
    console.log(`  ${root.id}: ${kids.length} child(ren) ${kids.slice(0, 6).map(node => node.id + '/' + node.kind).join(' ')}`)
  }
}
for (const node of orphans) {
  console.log(`orphan ${node.id} [${node.kind}] parent ${node.parentId} → ${(node.summary ?? node.content).replace(/\s+/g, ' ').slice(0, 40)}`)
}

console.log('\nid     kind           parent  turn  preview')
for (const node of nodes) {
  console.log(`${node.id.padEnd(6)} ${String(node.kind).padEnd(14)} ${String(node.parentId ?? 'null').padEnd(7)} ${String(node.metadata.turn ?? '-').padStart(4)}  ${(node.summary ?? node.content).replace(/\s+/g, ' ').slice(0, 44)}`)
}
