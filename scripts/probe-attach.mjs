#!/usr/bin/env node
/**
 * Replay the log through the live ingest path and explain each attachment.
 *
 * Before a question is ingested, its scores against the current node and every answer are
 * printed, so a wrong branch can be explained with numbers rather than guessed at.
 *
 * Usage: node scripts/probe-attach.mjs <session-prefix> [project]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { embedText } from '../src/core/embedding.ts'

const prefix = process.argv[2]
const project = process.argv[3] ?? '--D-dsh-token-tree--'
const root = 'C:/Users/ASUS/.dsh/sessions'
const dir = join(root, project)

let file = ''
let sessionId = ''
for (const id of readdirSync(dir)) {
  if (!id.includes(prefix)) continue
  const candidate = join(dir, id, 'session.v4.jsonl.zstd')
  if (statSync(candidate).isFile()) { file = candidate; sessionId = id }
}
if (file === '') throw new Error(`no session matching ${prefix}`)

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
const seen = []
const session = { id: sessionId, snapshotEvents: () => seen.slice() }

const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text')
  .map(block => block.text)
  .join(' ')
  .replace(/\s+/g, ' ')

console.log(`config: attachThreshold=${config.attachThreshold} attachMargin=${config.attachMargin} newTopicBelow=${config.newTopicBelow} attachments=${config.attachments}\n`)

let questionIndex = 0
for (const event of events) {
  if (event.type === 'user/message' && (event.data?.source?.kind === 'user')) {
    const question = textOf(event.data.content).slice(0, 48)
    questionIndex++
    const state = service.stateOf(sessionId)
    const tree = state.tree
    if (tree.nodes.size > 1) {
      const embedding = embedText(question)
      const context = service.attachmentContext(state, question, embedding)
      const currentId = tree.currentId
      const currentScore = service.attachmentScore(context, tree.node(currentId))
      const rows = []
      for (const node of tree.nodes.values()) {
        if (node.kind !== 'answer' || node.id === currentId) continue
        rows.push({ id: node.id, score: service.attachmentScore(context, node), preview: (node.summary ?? node.content).replace(/\s+/g, ' ').slice(0, 24) })
      }
      rows.sort((left, right) => right.score - left.score)
      const top = rows.slice(0, 2).map(row => `${row.id}=${row.score.toFixed(3)}(${row.preview})`).join(' · ')
      console.log(`Q${questionIndex} "${question}"`)
      console.log(`    current ${currentId}=${currentScore.toFixed(3)} · answers: ${top || 'none'}`)
    } else {
      console.log(`Q${questionIndex} "${question}" → (opens the tree)`)
    }
  }
  seen.push(event)
  service.handleEvent(session, event)
}
