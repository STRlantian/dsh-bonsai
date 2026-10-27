#!/usr/bin/env node
/**
 * What would the file region have saved?
 *
 * Replays a session and, at every `read` tool result, asks whether the *same file* had already been
 * read and was unchanged since. Those reads are the ones a file region can answer without a tool
 * call at all: the model would get the current text from retrieval instead of reading again.
 *
 * Usage: node scripts/probe-file-region.mjs <project> <prefix>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const project = process.argv[2] ?? '--D-dsh-token-tree--'
const prefix = process.argv[3] ?? '37bfb65c'
const dir = join('C:/Users/ASUS/.dsh/sessions', project)
const id = readdirSync(dir).find(name => name.includes(prefix))
const buffer = readFileSync(join(dir, id, 'session.v4.jsonl.zstd'))
const starts = []
for (let index = 0; index + 4 <= buffer.length; index++) {
  if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
}
let text = ''
for (let index = 0; index < starts.length; index++) {
  const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
  try { text += zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8') } catch {}
}
const events = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try {
    const record = JSON.parse(line)
    const event = record.event ?? record
    if (event?.type) events.push(event)
  } catch {}
}

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })
service.backfillFromSession({ id, snapshotEvents: () => events })

// Walk the log in order, pairing calls with results and checking the file's state at that moment.
const calls = new Map()
const indexed = new Map() // path -> mtime of the content the region would hold
let reads = 0
let sourceable = 0
let sourceableTokens = 0
let changedSinceRead = 0
const byPath = new Map()

for (const event of events) {
  if (event.type === 'tool/call') {
    let args = {}
    try { args = JSON.parse(event.data?.arguments ?? '{}') } catch {}
    const path = args.file_path ?? args.path
    if (typeof path === 'string') calls.set(event.data.callId, { name: event.data.name, path })
    continue
  }
  if (event.type !== 'tool/result') continue
  const callId = event.data?.message?.toolCallId
  const call = calls.get(callId)
  if (call === undefined || call.name !== 'read') continue
  const content = (event.data?.message?.content ?? []).map(part => part.text ?? '').join('\n')
  if (content.length === 0) continue
  reads += 1
  let mtime = 0
  try { mtime = statSync(call.path).mtimeMs } catch { mtime = 0 }
  const previous = indexed.get(call.path)
  if (previous !== undefined && mtime !== 0 && Math.abs(previous - mtime) < 1) {
    // Same content is already in the region: a tool call was avoidable.
    sourceable += 1
    const tokens = service.estimateTokens(content)
    sourceableTokens += tokens
    byPath.set(call.path, (byPath.get(call.path) ?? 0) + 1)
  } else if (previous !== undefined) {
    changedSinceRead += 1
  }
  indexed.set(call.path, mtime)
}

console.log(`session ${id.slice(-12)} · read results ${reads} · files ${indexed.size}`)
console.log(`answerable from the region (same file, unchanged): ${sourceable} (${(sourceable / Math.max(1, reads) * 100).toFixed(0)}%)`)
console.log(`their content tokens: ${sourceableTokens} (avg ${Math.round(sourceableTokens / Math.max(1, sourceable))} per read)`)
console.log(`re-reads after the file changed: ${changedSinceRead}`)
const top = [...byPath.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5)
for (const [path, count] of top) console.log(`  ${count}× ${path}`)
