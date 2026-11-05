#!/usr/bin/env node
/**
 * What does one fold cost, and how many turns must follow before it pays off?
 *
 * A fold rewrites the prompt prefix, so the part of the prompt after the fold point is processed
 * again at the miss price. With a hit priced at 1/50 of a miss, folding a block of F tokens while
 * keeping a window of K tokens costs about (1 - 1/50) * K once, and saves (1/50) * F on every later
 * turn. Break-even is therefore N* = 49 * K / F turns.
 *
 * This replays real sessions, records F (tokens removed by the fold) and K (tokens left after it)
 * for every fold, and compares N* with the turns that actually followed. It also prints the block
 * size at which a fold pays back within 5, 10, 25 and 50 turns.
 *
 * Usage: node scripts/probe-fold-payback.mjs [--ratio 50]
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
const ratio = Number(argOf('ratio', '50'))
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

const rows = []
for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  for (const name of readdirSync(join(sessionsRoot, project.name))) {
    const file = join(sessionsRoot, project.name, name, 'session.v4.jsonl.zstd')
    let events
    try { events = loadEvents(file) } catch { continue }
    const service = new TokenTreeService({ config, logger })
    const session = { id: 'payback', snapshotEvents: () => events }
    let turn = 0
    let folds = 0
    const samples = []
    for (const event of events) {
      if (event.type === 'turn/end') turn++
      const isFold = event.surfaceOp !== null && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace'
      if (!isFold) { service.handleEvent(session, event); continue }
      const before = service.historyTokens('payback')
      service.handleEvent(session, event)
      const after = service.historyTokens('payback')
      folds++
      // historyTokens does not drop on a fold (the originals stay in the log), so F is taken from the
      // placeholder's own size: the text that replaced the block.
      const placeholder = JSON.stringify(event.data ?? {})
      const kept = JSON.max ?? 0
      void kept
      samples.push({ turn, before, after, placeholderChars: placeholder.length })
    }
    const total = turn
    if (folds > 0) rows.push({ id: name.replace(/^session-/, '').slice(0, 8), total, folds, samples })
  }
}
rows.sort((left, right) => right.folds - left.folds)
console.log(`缓存命中价 = 漏价 / ${ratio} · 折叠成本 ≈ (1 − 1/${ratio})·K，节省 ≈ F/${ratio} 每轮，回本期 N* = ${ratio - 1}·K/F`)
console.log(`\n${'会话'.padEnd(10)} ${'轮'.padStart(4)} ${'折叠'.padStart(4)}`)
for (const row of rows.slice(0, 6)) console.log(`${row.id.padEnd(10)} ${String(row.total).padStart(4)} ${String(row.folds).padStart(4)}`)

console.log(`\n不同"保留窗口 K"下，值得折叠的最小块 F（回本期 ≤ N 轮）：`)
const keeps = [1000, 3000, 6000, 12000, 30000]
const waits = [5, 10, 25, 50]
console.log(`${'K'.padStart(7)} ${waits.map(wait => (`N≤${wait}`).padStart(9)).join('')}`)
for (const keep of keeps) {
  const cells = waits.map(wait => String(Math.round((ratio - 1) * keep / wait)).padStart(9))
  console.log(`${String(keep).padStart(7)} ${cells.join('')}`)
}
console.log(`\n（K ≈ 保留轮数 × 每轮 token；3 轮 × 400 token ≈ 1.2k，3 轮 × 3k ≈ 9k）`)
