#!/usr/bin/env node
/**
 * How much of a session's context is file and command output?
 *
 * Counts tool results by tool, sums their tokens and reports what share of the derived history they
 * occupy - the number that decides whether folding them is a saving or a re-read.
 *
 * Usage: SESSION_PROJECT=--D-dsh-token-tree-- node scripts/probe-tool-share.mjs <prefix>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const project = process.env.SESSION_PROJECT ?? '--D-dsh-token-tree--'
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
service.backfillFromSession({ id, snapshotEvents: () => events })
const tree = service.stateOf(id).tree

const byTool = new Map()
let toolTokens = 0
let toolCount = 0
for (const node of tree.nodes.values()) {
  if (node.kind !== 'tool_result') continue
  const name = typeof node.metadata.toolName === 'string' ? node.metadata.toolName : 'tool'
  const current = byTool.get(name) ?? { calls: 0, tokens: 0 }
  current.calls += 1
  current.tokens += node.tokens
  byTool.set(name, current)
  toolTokens += node.tokens
  toolCount += 1
}

const history = service.historyTokens(id)
const answers = [...tree.nodes.values()].filter(node => node.kind === 'answer')
const questionTokens = [...tree.nodes.values()].filter(node => node.kind === 'question').reduce((sum, node) => sum + node.tokens, 0)
const answerTokens = answers.reduce((sum, node) => sum + node.tokens, 0)

console.log(`session ${id.slice(-12)} · nodes ${tree.nodes.size} · history ${history} tokens`)
console.log(`tool results ${toolCount} · ${toolTokens} tokens (${(toolTokens / Math.max(1, history) * 100).toFixed(1)}% of history)`)
console.log(`questions ${questionTokens} · answers ${answerTokens} (${(answerTokens / Math.max(1, history) * 100).toFixed(1)}%)`)
const rows = [...byTool.entries()].sort((left, right) => right[1].tokens - left[1].tokens)
for (const [name, stat] of rows) {
  console.log(`  ${name.padEnd(14)} calls ${String(stat.calls).padStart(3)} · ${String(stat.tokens).padStart(7)} tokens · avg ${Math.round(stat.tokens / stat.calls)}`)
}

// Folding status: how many of those tool results are inside a folded range now.
const folded = [...tree.nodes.values()].filter(node => node.kind === 'tool_result' && tree.hidden(node.id))
console.log(`tool results currently hidden: ${folded.length}`)
