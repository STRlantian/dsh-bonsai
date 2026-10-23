#!/usr/bin/env node
/**
 * Dump what one session's model-visible conversation looks like after folding.
 *
 * Reads the durable log (so it shows the truth, not a stale page snapshot), prints each
 * message event in seq order with a short text, and marks which ones a surface replacement
 * shadows.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const target = process.argv[2]
const root = 'C:/Users/ASUS/.dsh/sessions'

const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text')
  .map(block => block.text)
  .join(' ')
  .replace(/\s+/g, ' ')
  .slice(0, 70)

for (const project of readdirSync(root)) {
  const dir = join(root, project)
  if (!statSync(dir).isDirectory()) continue
  for (const id of readdirSync(dir)) {
    if (target !== undefined && !id.includes(target)) continue
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
    const events = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        events.push(record.event ?? record)
      } catch {}
    }
    const shadowed = new Set()
    for (const event of events) {
      for (const seq of event.sourceEventSeqs ?? []) shadowed.add(seq)
    }
    console.log(`session ${id} · ${events.length} events · ${shadowed.size} shadowed seqs`)
    for (const event of events) {
      if (!['user/message', 'assistant/message', 'tool/result', 'turn/start', 'turn/end'].includes(event.type)) continue
      const data = event.data ?? {}
      let text = ''
      if (event.type === 'tool/result') {
        const content = data.message?.content ?? data.content
        text = textOf(content)
      } else if (event.type === 'assistant/message') {
        text = textOf(data.message?.content ?? data.content)
      } else if (event.type === 'user/message') {
        text = textOf(data.content)
      } else {
        text = JSON.stringify(data)
      }
      const marks = [
        shadowed.has(event.seq) ? 'SHADOWED' : '',
        event.surfaceOp === undefined ? '' : `surfaceOp=${JSON.stringify(event.surfaceOp)}`,
      ].filter(Boolean).join(' ')
      console.log(`${String(event.seq).padStart(4)} ${event.type.padEnd(17)} ${marks.padEnd(40)} ${text}`)
    }
    process.exit(0)
  }
}
