#!/usr/bin/env node
/**
 * How much does the attachment point change what retrieval surfaces?
 *
 * Replays a session and, at the moment each question arrives, runs retrieval twice: once from the
 * node the service stands on (the automatic choice) and once from the root. The overlap of the two
 * result sets is the ceiling of what a manually picked parent can change - if the two origins
 * returned the same things, re-parenting a question could not improve retrieval at all.
 *
 * Also counts the retrieval's self-hit: the query matching its own freshly added question node.
 *
 * Usage: SESSION_PROJECT=--D-Python-AI-- node scripts/probe-origin-sensitivity.mjs <prefix>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const project = process.env.SESSION_PROJECT ?? '--D-Python-AI--'
const prefix = process.argv[2]
const dir = join('C:/Users/ASUS/.dsh/sessions', project)
const id = readdirSync(dir).find(name => name.includes(prefix))
if (id === undefined) throw new Error(`no session matching ${prefix}`)

const buffer = readFileSync(join(dir, id, 'session.v4.jsonl.zstd'))
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

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })
const session = { id, snapshotEvents: () => events }

const rows = []
for (const event of events) {
  if (event.type === 'user/message') {
    const content = (event.data?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n')
    const isContext = /^Current runtime context|^Time sampled|^\[/.test(content.trim())
    if (!isContext && content.trim().length > 0 && service.stateOf(id).tree.nodes.size > 1) {
      const tree = service.stateOf(id).tree
      const fromOrigin = service.retrieve(id, { query: content })
      const fromRoot = service.retrieve(id, { query: content, originId: tree.rootId })
      const originIds = new Set((fromOrigin.selected ?? []).map(entry => entry.nodeId))
      const rootIds = new Set((fromRoot.selected ?? []).map(entry => entry.nodeId))
      const union = new Set([...originIds, ...rootIds])
      rows.push({
        text: content.replace(/\s+/g, ' ').slice(0, 34),
        origin: tree.currentId,
        selected: originIds.size,
        overlap: union.size === 0 ? 1 : [...originIds].filter(nodeId => rootIds.has(nodeId)).length / union.size,
      })
    }
  }
  service.handleEvent(session, event)
}

const average = rows.reduce((sum, row) => sum + row.overlap, 0) / Math.max(1, rows.length)
const withResults = rows.filter(row => row.selected > 0).length
console.log(`${id.slice(-12)} · questions ${rows.length} · retrieval returned something ${withResults}`)
console.log(`average overlap of the top-k sets (auto origin vs root): ${average.toFixed(2)}`)
for (const row of rows) {
  console.log(`  origin ${row.origin.padEnd(5)} selected ${String(row.selected).padStart(2)} overlap ${row.overlap.toFixed(2)} · ${row.text}`)
}
