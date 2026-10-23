#!/usr/bin/env node
/**
 * Split one attachment score into its parts, using the real texts of a session.
 *
 * Usage: node scripts/probe-score-parts.mjs <session-prefix> "<question text>"
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { contentFeatures, cosine, embedText } from '../src/core/embedding.ts'

const prefix = process.argv[2]
const question = process.argv[3]
const project = '--D-dsh-token-tree--'
const dir = join('C:/Users/ASUS/.dsh/sessions', project)

let file = ''
let sessionId = ''
for (const id of readdirSync(dir)) {
  if (!id.includes(prefix)) continue
  const candidate = join(dir, id, 'session.v4.jsonl.zstd')
  if (statSync(candidate).isFile()) { file = candidate; sessionId = id }
}
if (file === '') throw new Error('no session')

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
  try {
    const record = JSON.parse(line)
    const event = record.event ?? record
    if (event?.type) events.push(event)
  } catch {}
}

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })
const session = { id: sessionId, snapshotEvents: () => events }
for (const event of events) service.handleEvent(session, event)

const state = service.stateOf(sessionId)
const tree = state.tree
const embedding = embedText(question)
const context = service.attachmentContext(state, question, embedding)
const currentId = tree.currentId
const current = tree.node(currentId)
const nodes = [...tree.nodes.values()].filter(node => node.kind === 'answer')
const candidates = [current, ...nodes.filter(node => node.id !== currentId)]

console.log(`current ${currentId} (${current.kind})`)
for (const node of candidates) {
  const features = contentFeatures(node.content)
  let best = 0
  let shared = []
  for (const feature of context.questionFeatures) {
    if (!features.has(feature)) continue
    const weight = context.idf.get(feature) ?? 0
    shared.push(`${feature}:${weight.toFixed(2)}`)
    if (weight > best) best = weight
  }
  const semantic = Math.max(0, cosine(embedding, node.embedding))
  const lexical = context.maxIdf === 0 ? 0 : best / context.maxIdf
  const penalty = Math.min(1, Math.sqrt(context.referenceFeatures / Math.max(1, features.size)))
  const score = (0.45 * semantic + 0.55 * lexical) * penalty
  console.log(`${node.id.padEnd(5)} score=${score.toFixed(3)} semantic=${semantic.toFixed(3)} lexical=${lexical.toFixed(3)} penalty=${penalty.toFixed(2)} features=${features.size} shared=[${shared.slice(0, 6).join(' ')}]`)
}
