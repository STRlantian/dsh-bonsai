#!/usr/bin/env node
/**
 * If the whole history were folded, could the tree still supply the right context?
 *
 * At the moment each question arrives, run retrieval exactly as the tool would and record its
 * results. Afterwards, look up where that question actually attached - the answer it followed up
 * on - and report at which rank (if any) retrieval offered it. With everything folded, the model
 * has nothing but this list, so the rank is the difference between a grounded answer and a guess.
 *
 * Usage: SESSION_PROJECT=--D-Python-AI-- node scripts/probe-retrieval-rank.mjs <prefix>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const project = process.env.SESSION_PROJECT ?? '--D-Python-AI--'
const prefix = process.argv[2]
const dir = join('C:/Users/ASUS/.dsh/sessions', project)
const id = readdirSync(dir).find(name => name.includes(prefix))
if (id === undefined) throw new Error(`no session matching ${prefix}`)

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
const session = { id, snapshotEvents: () => events }

const samples = []
for (const event of events) {
  if (event.type === 'user/message') {
    const content = (event.data?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n')
    const isContext = /^Current runtime context|^Time sampled|^\[/.test(content.trim())
    if (!isContext && content.trim().length > 0 && service.stateOf(id).tree.nodes.size > 1) {
      const result = service.retrieve(id, { query: content })
      samples.push({
        text: content.replace(/\s+/g, ' ').slice(0, 30),
        selected: (result.selected ?? []).map(entry => entry.nodeId),
        tokens: result.tokensUsed ?? 0,
      })
    }
  }
  service.handleEvent(session, event)
}

const tree = service.stateOf(id).tree
const questions = [...tree.nodes.values()].filter(node => node.kind === 'question')
const answerOf = question => {
  const parent = question.parentId === null ? undefined : tree.nodes.get(question.parentId)
  if (parent === undefined) return undefined
  if (parent.kind === 'answer') return parent
  // A follow-up often hangs under another question; walk back to the nearest answer.
  let cursor = parent
  let guard = 0
  while (cursor !== undefined && cursor.kind !== 'answer' && guard < 20) {
    cursor = cursor.parentId === null ? undefined : tree.nodes.get(cursor.parentId)
    guard++
  }
  return cursor
}

let compared = 0
let rank1 = 0
let inTop = 0
let missing = 0
for (let index = 0; index < samples.length; index++) {
  const sample = samples[index]
  const question = questions[index + 1]
  if (question === undefined) continue
  const answer = answerOf(question)
  if (answer === undefined) continue
  compared++
  const rank = sample.selected.indexOf(answer.id)
  if (rank === 0) rank1++
  if (rank >= 0) inTop++
  else missing++
  console.log(`  rank ${rank < 0 ? '-' : rank + 1} · selected ${sample.selected.length} · ${sample.tokens} tok · ${sample.text}`)
}

console.log(`\ncompared ${compared} questions`)
console.log(`answer found at rank 1: ${rank1} (${(rank1 / Math.max(1, compared) * 100).toFixed(0)}%)`)
console.log(`answer in the retrieved set: ${inTop} (${(inTop / Math.max(1, compared) * 100).toFixed(0)}%)`)
console.log(`answer absent: ${missing}`)
