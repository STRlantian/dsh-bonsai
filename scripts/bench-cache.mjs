#!/usr/bin/env node
/**
 * Measure what the tree does to the model's context and prompt cache.
 *
 * Two numbers decide whether this plugin pays for itself:
 *
 *   1. **Injected context** — how many tokens the memory block adds per turn.
 *   2. **Cache hit rate** — `cacheRead / (input + cacheRead + cacheWrite)`.
 *
 * Both are recoverable from a session log: every `assistant/message` carries the
 * provider's usage counters, and every injected block is recorded as a `user/message`
 * whose `source.kind` is `token-tree`. This script decodes the zstd log (one frame
 * per flush, so the frames are split on the magic bytes), then prints per-turn rows
 * plus a summary that answers "does the injection cost cache".
 *
 * Usage:
 *   node scripts/bench-cache.mjs                    # newest session for this workspace
 *   node scripts/bench-cache.mjs <session-dir>      # a specific session
 *   node scripts/bench-cache.mjs --last 20          # only the last N turns
 *   node scripts/bench-cache.mjs --json             # machine-readable summary
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const INJECTED_KIND = 'token-tree'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** Split a multi-frame zstd file on the frame magic. */
function framesOf(buffer) {
  const frames = []
  let start = 0
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (buffer.compare(MAGIC, 0, 4, index, index + 4) !== 0) continue
    if (index > start) frames.push(buffer.subarray(start, index))
    start = index
  }
  frames.push(buffer.subarray(start))
  return frames
}

/** Decode every frame of a session log into JSONL text. */
function decodeSession(file) {
  const buffer = readFileSync(file)
  let text = ''
  for (const frame of framesOf(buffer)) {
    try {
      text += zstdDecompressSync(frame).toString('utf8')
    } catch {
      // A torn trailing frame is normal while the session is being written.
    }
  }
  return text
}

/** Newest session directory that has a log. */
function newestSession() {
  const base = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh'), 'sessions')
  const candidates = []
  for (const workspace of readdirSync(base)) {
    const workspacePath = join(base, workspace)
    for (const session of readdirSync(workspacePath)) {
      const dir = join(workspacePath, session)
      const file = join(dir, 'session.v4.jsonl.zstd')
      try {
        const stats = statSync(file)
        candidates.push({ dir, file, mtime: stats.mtimeMs })
      } catch {
        // no log yet
      }
    }
  }
  candidates.sort((left, right) => right.mtime - left.mtime)
  return candidates[0]?.dir
}

/** Rough token estimate for one injected block, matching the plugin's own rule. */
function tokensOf(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
  const rest = text.length - cjk
  return Math.ceil(cjk * 1.5 + rest / 4)
}

/** Text of one message's content array. */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

const argv = process.argv.slice(2)
const jsonFlag = argv.includes('--json')
const lastIndex = argv.indexOf('--last')
const last = lastIndex === -1 ? undefined : Number(argv[lastIndex + 1])
const explicit = argv.find(argument => !argument.startsWith('--') && Number.isNaN(Number(argument)))

const sessionDir = explicit ?? newestSession()
if (sessionDir === undefined) {
  console.error('bench-cache: no session log found')
  process.exit(1)
}

const file = join(sessionDir, 'session.v4.jsonl.zstd')
const events = decodeSession(file).split('\n').filter(line => line.trim().length > 0).map(line => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}).filter(Boolean)

/** Per-turn accumulation. */
const turns = new Map()
const injectedTotal = []
for (const event of events) {
  const data = event.data ?? {}
  if (event.type === 'assistant/message' && data.usage !== undefined) {
    const turn = typeof data.turn === 'number' ? data.turn : 0
    const usage = data.usage
    turns.set(turn, {
      turn,
      input: Number(usage.inputTokens ?? 0),
      cacheRead: Number(usage.cacheReadTokens ?? 0),
      cacheWrite: Number(usage.cacheWriteTokens ?? 0),
      output: Number(usage.outputTokens ?? 0),
      injected: 0,
    })
  }
  if (event.type === 'user/message') {
    const source = data.source
    if (source !== null && typeof source === 'object' && source.kind === INJECTED_KIND) {
      const estimate = tokensOf(textOfContent(data.content))
      injectedTotal.push(estimate)
      // Attribute the block to the turn it was injected for.
      const turn = turns.size === 0 ? 0 : Math.max(...turns.keys())
      const row = turns.get(turn)
      if (row !== undefined) row.injected += estimate
    }
  }
}

const rows = [...turns.values()].sort((left, right) => left.turn - right.turn)
if (rows.length === 0) {
  console.error('bench-cache: the session has no assistant usage records yet')
  process.exit(1)
}
const shown = last === undefined ? rows : rows.slice(-last)

const hitRate = row => {
  const total = row.input + row.cacheRead + row.cacheWrite
  return total === 0 ? 0 : row.cacheRead / total
}

if (!jsonFlag) {
  console.log(`session: ${sessionDir}`)
  console.log(`events:  ${events.length}, turns with usage: ${rows.length}\n`)
  console.log('turn   input    cacheRead  cacheWrite   hit%   injected')
  for (const row of shown) {
    console.log(
      String(row.turn).padStart(4),
      String(row.input).padStart(8),
      String(row.cacheRead).padStart(10),
      String(row.cacheWrite).padStart(11),
      (hitRate(row) * 100).toFixed(2).padStart(7),
      String(row.injected).padStart(11),
    )
  }
}

const totalInput = rows.reduce((sum, row) => sum + row.input, 0)
const totalRead = rows.reduce((sum, row) => sum + row.cacheRead, 0)
const totalWrite = rows.reduce((sum, row) => sum + row.cacheWrite, 0)
const totalInjected = rows.reduce((sum, row) => sum + row.injected, 0)
const overall = totalRead + totalInput + totalWrite === 0
  ? 0
  : totalRead / (totalRead + totalInput + totalWrite)

const byInjection = rows.filter(row => row.injected > 0)
const withoutInjection = rows.filter(row => row.injected === 0)
const mean = list => list.length === 0 ? 0 : list.reduce((sum, row) => sum + hitRate(row), 0) / list.length

const summary = {
  session: sessionDir,
  turns: rows.length,
  totalInput,
  totalCacheRead: totalRead,
  totalCacheWrite: totalWrite,
  totalInjected,
  injectedPerTurn: byInjection.length === 0 ? 0 : totalInjected / byInjection.length,
  hitRateOverall: overall,
  hitRateInjected: mean(byInjection),
  hitRatePlain: mean(withoutInjection),
  turnsWithInjection: byInjection.length,
}

if (jsonFlag) {
  console.log(JSON.stringify(summary, undefined, 2))
} else {
  console.log('\nsummary')
  console.log(`  turns                     ${summary.turns}`)
  console.log(`  new input tokens          ${summary.totalInput}`)
  console.log(`  cache read tokens         ${summary.totalCacheRead}`)
  console.log(`  cache write tokens        ${summary.totalCacheWrite}`)
  console.log(`  injected tokens (total)   ${summary.totalInjected}`)
  console.log(`  injected tokens / turn    ${summary.injectedPerTurn.toFixed(1)}`)
  console.log(`  hit rate overall          ${(summary.hitRateOverall * 100).toFixed(2)}%`)
  console.log(`  hit rate (with injection) ${(summary.hitRateInjected * 100).toFixed(2)}%  (${summary.turnsWithInjection} turns)`)
  console.log(`  hit rate (no injection)   ${(summary.hitRatePlain * 100).toFixed(2)}%  (${withoutInjection.length} turns)`)
  const delta = (summary.hitRateInjected - summary.hitRatePlain) * 100
  console.log(`  injected - plain          ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} points`)
}
