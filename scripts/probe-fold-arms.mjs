#!/usr/bin/env node
/**
 * Project the prompt with folding on and off, from one real session log.
 *
 * No model is involved: the measured prompt of each step comes from the provider's own usage
 * record, and folding is a local surface rewrite, so the two arms differ in exactly one variable.
 * The projection is: prompt_t = (measured prompt of turn 1 - its own node tokens) + the tokens of
 * the turns still visible at turn t, where a policy may replace whole turns with one placeholder.
 *
 * Usage: node scripts/probe-fold-arms.mjs <project> <prefix>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const projectName = process.argv[2] ?? '--D-Python-AI--'
const prefix = process.argv[3] ?? '2ba794ae'
const dir = join('C:/Users/ASUS/.dsh/sessions', projectName)
const id = readdirSync(dir).find(name => name.includes(prefix))
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

// Measured prompt per turn, straight from the provider.
const measured = new Map()
for (const event of events) {
  if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
  const turn = event.data.turn
  const prompt = (event.data.usage.inputTokens ?? 0) + (event.data.usage.cacheReadTokens ?? 0)
  measured.set(turn, (measured.get(turn) ?? 0) + prompt)
}
const turns = [...measured.keys()].sort((left, right) => left - right)
if (turns.length < 4) { console.log(`${prefix}: too few turns (${turns.length})`); process.exit(0) }

// Tokens each turn contributes to the visible surface.
const perTurn = new Map()
for (const node of tree.nodes.values()) {
  if (tree.hidden(node.id)) continue
  const turn = typeof node.metadata.turn === 'number' ? node.metadata.turn : 0
  if (turn <= 0) continue
  perTurn.set(turn, (perTurn.get(turn) ?? 0) + node.tokens)
}
const placeholder = 40
const first = turns[0]
const base = measured.get(first) - (perTurn.get(first) ?? 0)

/** Project total prompt tokens when a policy folds every turn older than `keep`. */
function project(keep, threshold) {
  let total = 0
  let folded = new Set()
  for (const turn of turns) {
    const visible = turns.filter(candidate => candidate <= turn && !folded.has(candidate))
    let prompt = base + visible.reduce((sum, candidate) => sum + (perTurn.get(candidate) ?? 0), 0)
    total += prompt
    // The policy fires only past its threshold, then folds everything older than the keep window.
    if (prompt <= threshold) continue
    const candidates = turns.filter(candidate => candidate <= turn && candidate !== first && !folded.has(candidate))
    if (candidates.length > keep) {
      for (const candidate of candidates.slice(0, candidates.length - keep)) folded.add(candidate)
    }
  }
  return total
}

const plain = turns.reduce((sum, turn) => sum + (measured.get(turn) ?? 0), 0)
console.log(`\n${prefix} · turns ${turns.length} · measured prompt total ${plain}`)
const policies = [
  ['threshold 40000, keep 3 (default)', 3, 40000],
  ['threshold 20000, keep 2', 2, 20000],
  ['threshold 10000, keep 1', 1, 10000],
  ['always, keep 1', 1, 0],
  ['always, keep 0 (only the current turn)', 0, 0],
]
for (const [label, keep, threshold] of policies) {
  const projected = project(keep, threshold)
  const saved = plain - projected
  console.log(`  ${label.padEnd(38)} ${String(projected).padStart(8)} tokens · saved ${String(saved).padStart(8)} (${(saved / plain * 100).toFixed(1)}%)`)
}
