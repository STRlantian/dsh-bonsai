#!/usr/bin/env node
/**
 * How often is the automatic attachment decision weak?
 *
 * Replays a session and records, for every question, where the service attached it and with what
 * score. Turns whose score sits below the attach threshold (or that fell back to the root) are the
 * ones where a manual pick could change the branch - and therefore the only place where forcing a
 * manual anchor could improve retrieval.
 *
 * Usage: SESSION_PROJECT=--D-Python-AI-- node scripts/probe-anchor-value.mjs <prefix>
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
for (let i = 0; i + 4 <= buffer.length; i++) {
  if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
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

const decisions = []
const original = service.pickQuestionParent.bind(service)
service.pickQuestionParent = (state, questionText, embedding) => {
  const decision = original(state, questionText, embedding)
  decisions.push({
    text: questionText.replace(/\s+/g, ' ').slice(0, 40),
    parentId: decision.parentId,
    score: Number(decision.score.toFixed(3)),
    manual: decision.manual === true,
  })
  return decision
}

service.backfillFromSession({ id, snapshotEvents: () => events })

const rootId = service.stateOf(id).tree.rootId
const limit = config.attachThreshold
const margin = config.attachMargin
const newTopic = config.newTopicBelow

let rootCount = 0
let weakCount = 0
let strongCount = 0
const rows = []
for (const decision of decisions) {
  const atRoot = decision.parentId === rootId
  const weak = atRoot ? decision.score < newTopic : decision.score < limit
  if (atRoot) rootCount++
  if (weak) weakCount++
  else strongCount++
  rows.push({ ...decision, atRoot, weak })
}

console.log(`session ${id.slice(-12)} · questions ${decisions.length}`)
console.log(`attachThreshold ${limit} · attachMargin ${margin} · newTopicBelow ${newTopic}`)
console.log(`strong (confidence above threshold): ${strongCount}`)
console.log(`weak (root fallback or below threshold): ${weakCount}`)
console.log(`of those, root fallbacks: ${rootCount}`)
console.log('\nper question (score is the evidence for the chosen parent):')
for (const row of rows) {
  console.log(`  ${row.weak ? 'WEAK ' : '     '} ${String(row.score).padStart(5)} → ${row.parentId.padEnd(5)} ${row.atRoot ? '(root)' : '      '} ${row.text}`)
}
