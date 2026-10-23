#!/usr/bin/env node
/**
 * List sessions of one workspace with their titles.
 *
 * Session titles come from `session/title` events in the durable log; this prints id, title,
 * turn count and the largest billed prompt, newest first.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const project = process.argv[2] ?? 'D--dsh-token-tree'
const root = 'C:/Users/ASUS/.dsh/sessions'
const dir = join(root, project)
const rows = []

for (const id of readdirSync(dir)) {
  const file = join(dir, id, 'session.v4.jsonl.zstd')
  let buffer
  try { buffer = readFileSync(file) } catch { continue }
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
  }
  let text = ''
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try { text += zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8') } catch {}
  }
  let title = ''
  let turns = 0
  let maxPrompt = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line).event ?? JSON.parse(line) } catch { continue }
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
    if (event.type === 'turn/start') turns++
    const usage = event.type === 'assistant/message' ? event.data?.usage : undefined
    if (usage !== undefined) {
      maxPrompt = Math.max(maxPrompt, (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
    }
  }
  rows.push({ id, title, turns, maxPrompt, mtime: statSync(file).mtimeMs })
}

rows.sort((left, right) => right.mtime - left.mtime)
for (const row of rows.slice(0, 20)) {
  console.log(`${row.id.slice(-8)}  ${String(row.turns).padStart(3)} turns  ${String(row.maxPrompt).padStart(7)} tok  ${row.title || '(untitled)'}`)
}
