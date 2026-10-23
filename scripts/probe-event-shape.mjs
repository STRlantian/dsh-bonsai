#!/usr/bin/env node
/** Print the shape of a tool/result event and the turn markers around it. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const target = process.argv[2]
const root = 'C:/Users/ASUS/.dsh/sessions'
for (const project of readdirSync(root)) {
  const dir = join(root, project)
  if (!statSync(dir).isDirectory()) continue
  for (const id of readdirSync(dir)) {
    if (target !== undefined && id !== target) continue
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
      try { events.push(JSON.parse(line)) } catch {}
    }
    const kinds = new Map()
    for (const record of events) {
      const event = record?.event ?? record
      if (event?.type) kinds.set(event.type, (kinds.get(event.type) ?? 0) + 1)
    }
    console.log(`\n${id.slice(-8)}: ${[...kinds].map(([k, c]) => `${k}×${c}`).join(', ')}`)
    const tool = events.find(record => (record.event ?? record).type === 'tool/result')
    if (tool) {
      const event = tool.event ?? tool
      console.log('tool/result keys:', Object.keys(event.data ?? {}).join(', '))
      console.log('sample:', JSON.stringify(event).slice(0, 400))
    }
    const turn = events.find(record => (record.event ?? record).type === 'turn/start')
    if (turn) {
      const event = turn.event ?? turn
      console.log('turn/start data:', JSON.stringify(event.data).slice(0, 200))
    }
    process.exit(0)
  }
}
