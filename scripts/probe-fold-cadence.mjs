#!/usr/bin/env node
/**
 * Compare "fold whenever the threshold is crossed" with "fold at most once every N turns".
 *
 * The comparison models the plugin's own rule: at each turn end, if the model-visible history is at
 * or above `foldAboveTokens` and at least one turn sits outside the keep window, every such turn is
 * replaced by one placeholder. The visible history is the head plus the turns that have not been
 * folded, computed from the per-turn token sizes measured by replaying the real session.
 *
 * Because the trigger is re-evaluated every turn, a session whose keep window stays above the
 * threshold folds once per turn - one cache break per turn. The cadence variant suppresses a fold
 * until N turns have passed, so folds batch up and the prefix is rewritten less often, at the price
 * of carrying more tokens in between.
 *
 * Cost uses the price relation measured in the bill: cache read costs 1/10 of a fresh input token,
 * and a fold turn is charged the whole prompt because its prefix is cold.
 *
 * Usage: node scripts/probe-fold-cadence.mjs [--threshold 40000] [--keep 3] [--cadence 3,5,8]
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
const threshold = Number(argOf('threshold', '40000'))
const keep = Number(argOf('keep', '3'))
const cadences = argOf('cadence', '1,3,5,8').split(',').map(Number)
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value

function loadEvents(file) {
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

/** Per-turn token sizes measured by replay, plus the turns that folded in the real session. */
function measure(file) {
  const events = loadEvents(file)
  const service = new TokenTreeService({ config, logger })
  const session = { id: 'cadence', snapshotEvents: () => events }
  const observed = []
  let turn = 0
  for (const event of events) {
    service.handleEvent(session, event)
    if (event.type === 'turn/end') turn++
    const op = event.surfaceOp
    if (op !== null && typeof op === 'object' && op.op === 'replace' && !observed.includes(turn)) observed.push(turn)
  }
  const tree = service.stateOf('cadence').tree
  const perTurn = new Map()
  for (const node of tree.nodes.values()) {
    if (node.kind === 'note') continue
    const nodeTurn = node.metadata?.turn
    if (typeof nodeTurn !== 'number' || nodeTurn <= 0) continue
    perTurn.set(nodeTurn, (perTurn.get(nodeTurn) ?? 0) + node.tokens)
  }
  return { perTurn, observed }
}

/** Run one policy over the measured per-turn sizes. */
function simulate(perTurn, cadence, threshold) {
  const turns = [...perTurn.keys()].sort((left, right) => left - right)
  const head = perTurn.get(turns[0]) ?? 0
  const folded = new Set([turns[0]])
  let visible = head
  let breaks = 0
  let cost = 0
  let peak = visible
  let previousVisible = 0
  let lastFold = -Infinity
  for (const turn of turns.slice(1)) {
    visible += perTurn.get(turn) ?? 0
    let broke = false
    if (visible >= threshold && turn - lastFold >= cadence) {
      const candidates = turns.filter(candidate => candidate !== turns[0] && candidate < turn && !folded.has(candidate))
      const kept = new Set(candidates.slice(-keep))
      const victims = candidates.filter(candidate => !kept.has(candidate))
      if (victims.length > 0) {
        for (const victim of victims) { folded.add(victim); visible -= perTurn.get(victim) ?? 0 }
        broke = true
        breaks++
        lastFold = turn
      }
    }
    peak = Math.max(peak, visible)
    cost += broke ? visible : 0.1 * previousVisible + (visible - previousVisible)
    previousVisible = visible
  }
  return { breaks, peak, cost, mean: cost / Math.max(1, turns.length) }
}

const rows = []
for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  for (const name of readdirSync(join(sessionsRoot, project.name))) {
    const file = join(sessionsRoot, project.name, name, 'session.v4.jsonl.zstd')
    let measured
    try { measured = measure(file) } catch { continue }
    if (measured.perTurn.size < 8) continue
    // The sessions ran with different thresholds, so calibrate one per session: the value whose
    // simulated fold count reproduces what the log actually recorded.
    let best = null
    for (let candidate = 5000; candidate <= 400000; candidate += 5000) {
      const variant = simulate(measured.perTurn, 1, candidate)
      const error = Math.abs(variant.breaks - measured.observed.length)
      if (best === null || error < best.error) best = { candidate, error, variant }
    }
    const calibrated = best.candidate
    const current = simulate(measured.perTurn, 1, calibrated)
    if (current.breaks < 3) continue
    rows.push({ id: name.replace(/^session-/, '').slice(0, 8), turns: measured.perTurn.size, observed: measured.observed.length, calibrated, current, variants: cadences.filter(n => n > 1).map(n => ({ n, ...simulate(measured.perTurn, n, calibrated) })) })
  }
}
rows.sort((left, right) => right.current.breaks - left.current.breaks)
if (rows.length === 0) {
  console.log('没有找到需要的会话')
  process.exit(0)
}

console.log(`阈值 ${threshold} · 保留 ${keep} 轮 · 模拟的"当前"策略与日志里真实折叠次数对照\n`)
console.log(`${'会话'.padEnd(10)} ${'轮'.padStart(4)} ${'真实折叠'.padStart(8)} ${'策略'.padEnd(6)} ${'折叠'.padStart(4)} ${'峰值'.padStart(9)} ${'成本'.padStart(12)} ${'相对'.padStart(7)}`)
for (const row of rows.slice(0, 8)) {
  const base = row.current.cost
  const line = (label, value) => `${row.id.padEnd(10)} ${String(row.turns).padStart(4)} ${String(row.observed).padStart(8)} ${label.padEnd(6)} ${String(value.breaks).padStart(4)} ${String(value.peak).padStart(9)} ${String(Math.round(value.cost)).padStart(12)} ${(value.cost / base * 100).toFixed(0).padStart(6)}%`
  console.log(line('当前', row.current))
  for (const variant of row.variants) console.log(line(`N=${variant.n}`, variant))
}

const totals = new Map([['当前', { cost: 0, breaks: 0 }], ...cadences.filter(n => n > 1).map(n => [`N=${n}`, { cost: 0, breaks: 0 }])])
for (const row of rows) {
  totals.get('当前').cost += row.current.cost
  totals.get('当前').breaks += row.current.breaks
  for (const variant of row.variants) {
    totals.get(`N=${variant.n}`).cost += variant.cost
    totals.get(`N=${variant.n}`).breaks += variant.breaks
  }
}
console.log(`\n=== 汇总（${rows.length} 个会话 · 共 ${rows.reduce((sum, row) => sum + row.turns, 0)} 轮）===`)
const baseCost = totals.get('当前').cost
for (const [label, value] of totals) {
  console.log(`${label.padEnd(6)} 折叠 ${String(value.breaks).padStart(5)} 次 · 成本 ${(value.cost / baseCost * 100).toFixed(1).padStart(6)}%`)
}
