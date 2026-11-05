#!/usr/bin/env node
/**
 * Compare the old trigger (whole visible history above a threshold) with the new one (the block about
 * to be folded must be large in absolute terms and relative to the keep window).
 *
 * Both rules run on the same measured per-turn token sizes, and both fold the same way: every turn
 * older than the keep window leaves the prompt as one placeholder. Cost uses the measured price
 * relation - a fold turn re-reads the visible prompt at the miss price, every other turn pays a cache
 * read at 1/50 of that plus its new tokens.
 *
 * Usage: node scripts/probe-fold-block.mjs [--floor 40000] [--ratio 5] [--keep 3] [--old-floor 40000]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const floor = Number(argOf('floor', '40000'))
const ratio = Number(argOf('ratio', '5'))
const keep = Number(argOf('keep', '3'))
const oldFloor = Number(argOf('old-floor', '40000'))
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const PLACEHOLDER = 60

function load(file) {
  const buffer = readFileSync(file)
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
  return events
}

function measure(events) {
  const service = new TokenTreeService({ config, logger })
  const session = { id: 'block', snapshotEvents: () => events }
  for (const event of events) service.handleEvent(session, event)
  const perTurn = new Map()
  for (const node of service.stateOf('block').tree.nodes.values()) {
    if (node.kind === 'note') continue
    const turn = node.metadata?.turn
    if (typeof turn !== 'number' || turn <= 0) continue
    perTurn.set(turn, (perTurn.get(turn) ?? 0) + node.tokens)
  }
  return perTurn
}

function visibleTokens(perTurn, folded, until) {
  let total = 0
  for (const [turn, tokens] of perTurn) {
    if (turn > until) continue
    total += folded.has(turn) ? PLACEHOLDER : tokens
  }
  return total
}

/** One policy: `gate` sees the visible size, the block, and the kept window. */
function simulate(perTurn, gate) {
  const turns = [...perTurn.keys()].sort((left, right) => left - right)
  const earliest = turns[0]
  const folded = new Set()
  let breaks = 0
  let cost = 0
  let previous = 0
  let peak = 0
  for (const turn of turns) {
    const visibleBefore = visibleTokens(perTurn, folded, turn)
    const candidates = turns.filter(candidate => candidate !== earliest && candidate < turn && !folded.has(candidate))
    const keptTurns = candidates.slice(-keep)
    const blockTurns = candidates.filter(candidate => !keptTurns.includes(candidate))
    const block = blockTurns.reduce((sum, candidate) => sum + (perTurn.get(candidate) ?? 0), 0)
    const kept = visibleBefore - block
    let broke = false
    if (blockTurns.length > 0 && gate(visibleBefore, block, kept)) {
      for (const candidate of blockTurns) folded.add(candidate)
      broke = true
      breaks++
    }
    const visible = visibleTokens(perTurn, folded, turn)
    peak = Math.max(peak, visible)
    cost += broke ? visible : 0.1 * previous + (visible - previous)
    previous = visible
  }
  return { breaks, peak, cost, mean: cost / Math.max(1, turns.length) }
}

const rows = []
for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  for (const name of readdirSync(join(sessionsRoot, project.name))) {
    const file = join(sessionsRoot, project.name, name, 'session.v4.jsonl.zstd')
    let events
    try { events = load(file) } catch { continue }
    const perTurn = measure(events)
    if (perTurn.size < 8) continue
    const old = simulate(perTurn, (visible) => visible >= oldFloor)
    const fresh = simulate(perTurn, (_visible, block, kept) => block >= floor && block >= ratio * kept)
    const none = simulate(perTurn, () => false)
    if (old.breaks + fresh.breaks === 0) continue
    rows.push({ id: name.replace(/^session-/, '').slice(0, 8), turns: perTurn.size, old, fresh, none })
  }
}

rows.sort((left, right) => right.turns - left.turns)
console.log(`旧：整段可见历史 ≥ ${oldFloor} · 新：待折块 ≥ ${floor} 且 ≥ ${ratio}×保留窗口 · 保留 ${keep} 轮\n`)
console.log(`${'会话'.padEnd(10)} ${'轮'.padStart(4)} ${'策略'.padEnd(5)} ${'折叠'.padStart(4)} ${'平均上下文'.padStart(10)} ${'成本'.padStart(12)} ${'相对旧'.padStart(7)}`)
const totals = { old: { cost: 0, breaks: 0 }, fresh: { cost: 0, breaks: 0 }, none: { cost: 0, breaks: 0 } }
for (const row of rows.slice(0, 8)) {
  const line = (label, value) => `${row.id.padEnd(10)} ${String(row.turns).padStart(4)} ${label.padEnd(5)} ${String(value.breaks).padStart(4)} ${String(Math.round(value.mean)).padStart(10)} ${String(Math.round(value.cost)).padStart(12)} ${(value.cost / row.old.cost * 100).toFixed(0).padStart(6)}%`
  console.log(line('旧', row.old))
  console.log(line('新', row.fresh))
  console.log(line('不折', row.none))
}
for (const row of rows) {
  for (const key of ['old', 'fresh', 'none']) {
    totals[key].cost += row[key].cost
    totals[key].breaks += row[key].breaks
  }
}
console.log(`\n=== 汇总（${rows.length} 个会话）===`)
for (const [label, key] of [['旧', 'old'], ['新', 'fresh'], ['不折', 'none']]) {
  console.log(`${label.padEnd(4)} 折叠 ${String(totals[key].breaks).padStart(5)} 次 · 成本 ${(totals[key].cost / totals.old.cost * 100).toFixed(1).padStart(6)}%`)
}
