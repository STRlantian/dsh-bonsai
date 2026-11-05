#!/usr/bin/env node
/**
 * Repair session logs whose fold events were appended outside an open turn.
 *
 * The host's durable-log reader rejects a `tool/result` surface replacement that sits outside an
 * open turn ("tool/result is outside an open turn"), and the plugin used to append folds after
 * `turn/end` for two days. The fix moves each offending replacement to just before the `turn/end`
 * that closed its turn, which is where the current code appends it.
 *
 * Dry run by default. `--write` rewrites the file, keeping a `.bak-<time>` copy next to it and
 * writing one zstd frame with the same jsonl lines.
 *
 * Usage: node scripts/repair-fold-order.mjs [--session <id>] [--write]
 */
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const only = argOf('session', undefined)
const write = args.includes('--write')
const root = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')

/** Decompress every frame and keep the raw jsonl lines in order. */
function readLines(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
  }
  const lines = []
  for (let index = 0; index < starts.length; index++) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    let chunk = ''
    try { chunk = zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8') } catch { continue }
    for (const line of chunk.split('\n')) if (line.trim()) lines.push(line)
  }
  return lines
}

/** Move replacement events that sit outside a turn to just before that turn's close. */
function repair(lines) {
  const parsed = lines.map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  })
  const events = parsed.map(record => record?.event ?? record)
  const types = new Map()
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event?.type !== undefined) types.set(event.seq, event.type)
  }
  const isToolReplacement = index => {
    const event = events[index]
    const op = event?.surfaceOp
    if (op === null || typeof op !== 'object' || op.op !== 'replace') return false
    const seqs = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    return seqs.some(seq => types.get(seq) === 'tool/result')
  }

  const keep = []
  const moves = new Map()
  let open = false
  let pendingEnd = null
  for (let index = 0; index < lines.length; index++) {
    const event = events[index]
    if (event?.type === 'turn/start') { open = true; pendingEnd = null }
    if (event?.type === 'turn/end') { pendingEnd = index }
    if (!open && isToolReplacement(index) && pendingEnd !== null) {
      // Park it until the turn's closing line has been emitted, then insert before that line.
      const list = moves.get(pendingEnd) ?? []
      list.push(lines[index])
      moves.set(pendingEnd, list)
      continue
    }
    if (event?.type === 'turn/end') {
      for (const line of moves.get(index) ?? []) keep.push(line)
      moves.delete(index)
    }
    if (event?.type === 'turn/start') pendingEnd = null
    if (event?.type === 'turn/end') open = false
    keep.push(lines[index])
  }
  const moved = [...moves.values()].reduce((sum, list) => sum + list.length, 0)
  // Anything still parked had no closing turn before it; keep it as it was.
  for (const list of moves.values()) for (const line of list) keep.push(line)
  return { lines: keep, moved }
}

const results = []
for (const project of readdirSync(root, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  for (const name of readdirSync(join(root, project.name))) {
    if (only !== undefined && !name.includes(only)) continue
    const file = join(root, project.name, name, 'session.v4.jsonl.zstd')
    let lines
    try { lines = readLines(file) } catch { continue }
    if (lines.length === 0) continue
    const outcome = repair(lines)
    if (outcome.moved === 0) continue
    results.push({ file, name: name.replace(/^session-/, '').slice(0, 8), moved: outcome.moved, lines: outcome.lines, original: lines })
  }
}

if (results.length === 0) {
  console.log('没有需要修复的会话')
  process.exit(0)
}
console.log(`需要修复的会话: ${results.length}（${write ? '写入' : '试运行，加 --write 才写'}）`)
for (const result of results) {
  console.log(`  ${result.name} · 移动 ${result.moved} 个折叠事件`)
  if (!write) continue
  const backup = `${result.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(result.file, backup)
  const payload = Buffer.from(result.lines.join('\n') + '\n', 'utf8')
  writeFileSync(result.file, zstdCompressSync(payload))
  const after = repair(readLines(result.file))
  console.log(`     → 已写入（备份 ${backup}）· 复查剩余 ${after.moved}`)
}
void statSync
