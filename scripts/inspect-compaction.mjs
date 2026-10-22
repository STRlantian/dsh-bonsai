#!/usr/bin/env node
/**
 * Scan one session log for compaction events and print what they did to the context.
 *
 * The point: compaction is the only path that lets the tree's recall advantage show up,
 * and it was never observed firing. This finds out whether it did, when, and how much
 * it removed, straight from the persisted log rather than from the UI's percentage.
 *
 * Usage:
 *   node scripts/inspect-compaction.mjs --session <session-dir>
 *   node scripts/inspect-compaction.mjs            # newest session under ~/.dsh/sessions
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

/** Split a multi-frame zstd file on the frame magic. */
function framesOf(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (buffer[index] === magic[0] && buffer[index + 1] === magic[1] && buffer[index + 2] === magic[2] && buffer[index + 3] === magic[3]) {
      starts.push(index)
    }
  }
  const out = []
  for (let index = 0; index < starts.length; index++) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    out.push(buffer.subarray(starts[index], end))
  }
  return out
}

/** Decode a session log into its JSON records. */
function recordsOf(file) {
  const buffer = readFileSync(file)
  const text = framesOf(buffer)
    .map(frame => {
      try {
        return zstdDecompressSync(frame).toString('utf8')
      } catch {
        return ''
      }
    })
    .join('')
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A torn tail line is normal in an append-only log.
    }
  }
  return records
}

const args = process.argv.slice(2)
const argOf = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

const root = join(homedir(), '.dsh', 'sessions')
let file = argOf('session')
if (file === undefined) {
  let newest = null
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const session of readdirSync(projectDir)) {
      const candidate = join(projectDir, session, 'session.v4.jsonl.zstd')
      try {
        const info = statSync(candidate)
        if (newest === null || info.mtimeMs > newest.mtimeMs) newest = { at: info.mtimeMs, path: candidate }
      } catch {
        // Not every session directory has a log.
      }
    }
  }
  if (newest === null) {
    console.error('no session log found')
    process.exit(1)
  }
  file = newest.path
}
if (file.endsWith('.zstd') === false) file = join(file, 'session.v4.jsonl.zstd')

console.log(`log: ${file}\n`)
const records = recordsOf(file)
console.log(`records: ${records.length}`)

const kinds = new Map()
for (const record of records) {
  const rec = record?.event ?? record
  const type = typeof rec?.type === 'string' ? rec.type : '?'
  kinds.set(type, (kinds.get(type) ?? 0) + 1)
}
const interesting = [...kinds.entries()].filter(([type]) => /compact|prune|summar/i.test(type))
console.log('compaction-ish events:', interesting.length === 0 ? 'none' : '')
for (const [type, count] of interesting) console.log(`  ${type}: ${count}`)

// Token usage per assistant message, so the drop can be seen in numbers.
const usages = []
for (const record of records) {
  const event = record?.event ?? record
  if (event?.type !== 'assistant/message') continue
  const usage = event.data?.usage
  if (usage === undefined) continue
  usages.push({
    seq: event.seq,
    input: usage.inputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    output: usage.outputTokens ?? 0,
    total: usage.totalTokens ?? 0,
  })
}
console.log(`\nassistant messages with usage: ${usages.length}`)
if (usages.length > 0) {
  console.log('  #  seq     input   cacheRead  cacheWrite   output    total  hit%')
  usages.forEach((entry, index) => {
    const billable = entry.input + entry.cacheRead + entry.cacheWrite
    const hit = billable === 0 ? 0 : entry.cacheRead / billable * 100
    console.log(
      String(index + 1).padStart(3),
      String(entry.seq).padEnd(7),
      String(entry.input).padStart(7),
      String(entry.cacheRead).padStart(10),
      String(entry.cacheWrite).padStart(11),
      String(entry.output).padStart(8),
      String(entry.total).padStart(8),
      hit.toFixed(2).padStart(6),
    )
  })
  const drops = []
  for (let index = 1; index < usages.length; index++) {
    const before = usages[index - 1].input + usages[index - 1].cacheRead
    const now = usages[index].input + usages[index].cacheRead
    if (before > 2000 && now < before * 0.8) drops.push({ index: index + 1, before, now })
  }
  console.log('\ncontext drops >20%:')
  if (drops.length === 0) console.log('  none — nothing was compacted')
  for (const drop of drops) console.log(`  message ${drop.index}: ${drop.before} → ${drop.now} tokens (-${((1 - drop.now / drop.before) * 100).toFixed(0)}%)`)
}

const compactionRecords = records.filter(record => /compact/i.test(JSON.stringify(record).slice(0, 400)))
console.log(`\nrecords mentioning "compact" in their head: ${compactionRecords.length}`)
for (const record of compactionRecords.slice(0, 5)) {
  const text = JSON.stringify(record)
  console.log(' ', text.length > 300 ? `${text.slice(0, 300)}…` : text)
}
