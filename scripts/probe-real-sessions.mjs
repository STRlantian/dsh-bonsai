#!/usr/bin/env node
/**
 * Did folding ever fire in real sessions?
 *
 * Scans the most recent session logs for our placeholder and reports, per session, the largest
 * billed prompt. This answers "does the default actually change anything in day-to-day use"
 * with the user's own data instead of another synthetic run.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? 'C:/Users/ASUS/.dsh/sessions'
const limit = Number(process.argv[3] ?? '12')

const files = []
for (const project of readdirSync(root)) {
  const dir = join(root, project)
  if (!statSync(dir).isDirectory()) continue
  for (const id of readdirSync(dir)) {
    const file = join(dir, id, 'session.v4.jsonl.zstd')
    try {
      files.push({ file, id, mtime: statSync(file).mtimeMs })
    } catch {}
  }
}
files.sort((left, right) => right.mtime - left.mtime)

const readEvents = file => {
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
    try { events.push(JSON.parse(line).event ?? JSON.parse(line)) } catch {}
  }
  return events
}

let foldedSessions = 0
let scanned = 0
const rows = []
for (const entry of files.slice(0, limit)) {
  let events
  try { events = readEvents(entry.file) } catch { continue }
  scanned++
  let placeholders = 0
  let maxPrompt = 0
  let turns = 0
  for (const event of events) {
    if (event.type === 'turn/start') turns++
    if (event.type === 'user/message' && JSON.stringify(event.data ?? {}).includes('已折叠')) placeholders++
    const usage = event.type === 'assistant/message' ? event.data?.usage : undefined
    if (usage !== undefined) {
      const total = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      maxPrompt = Math.max(maxPrompt, total)
    }
  }
  if (placeholders > 0) foldedSessions++
  rows.push({ id: entry.id.slice(-8), turns, maxPrompt, placeholders })
}

rows.sort((left, right) => right.maxPrompt - left.maxPrompt)
console.log('session   turns   maxPrompt   folded?')
for (const row of rows) {
  console.log(`${row.id}  ${String(row.turns).padStart(5)}  ${String(row.maxPrompt).padStart(9)}   ${row.placeholders > 0 ? 'yes' : 'no'}`)
}
console.log(`\nscanned ${scanned} sessions · folded in ${foldedSessions} · threshold is 60,000 tokens`)
