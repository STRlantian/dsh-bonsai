#!/usr/bin/env node
/**
 * Estimate what folding would have saved on a real session.
 *
 * Replays the log, records history tokens per turn, and for each turn where the threshold is
 * crossed, prints the tokens held by turns older than the keep window — the amount folding
 * would take out of the next request.
 *
 * Usage: node scripts/probe-fold-estimate.mjs <session-prefix> [threshold] [keep]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const prefix = process.argv[2]
const threshold = Number(process.argv[3] ?? '40000')
const keep = Number(process.argv[4] ?? '3')
const project = '--D-dsh-token-tree--'
const dir = join('C:/Users/ASUS/.dsh/sessions', project)

let file = ''
let sessionId = ''
for (const id of readdirSync(dir)) {
  if (!id.includes(prefix)) continue
  const candidate = join(dir, id, 'session.v4.jsonl.zstd')
  if (statSync(candidate).isFile()) { file = candidate; sessionId = id }
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

const tokensByTurn = new Map()
let crossed = 0
let savedTotal = 0
for (const event of events) {
  service.handleEvent(session, event)
  if (event.type !== 'turn/end') continue
  const tree = service.stateOf(sessionId).tree
  tokensByTurn.clear()
  for (const node of tree.nodes.values()) {
    const turn = typeof node.metadata.turn === 'number' ? node.metadata.turn : 0
    if (turn <= 0) continue
    tokensByTurn.set(turn, (tokensByTurn.get(turn) ?? 0) + node.tokens)
  }
  const history = service.historyTokens(sessionId)
  const turns = [...tokensByTurn.keys()].sort((left, right) => left - right)
  const kept = new Set(turns.slice(-keep))
  const foldable = turns.filter(turn => !kept.has(turn)).reduce((sum, turn) => sum + (tokensByTurn.get(turn) ?? 0), 0)
  if (history < threshold) continue
  crossed++
  savedTotal += foldable
  console.log(`turn ${String(event.data?.turn).padStart(2)} · history ${String(history).padStart(6)} tok · foldable ${String(foldable).padStart(6)} tok · turns ${turns.length}`)
}

const final = service.historyTokens(sessionId)
console.log(`\nfinal history: ${final} tok · threshold ${threshold} · last ${keep} turns kept`)
console.log(`turns above threshold: ${crossed} · tokens that would leave the request: ${savedTotal}`)
console.log(`path-only metric would report: ${service.conversationTokens(sessionId)} tok`)
