#!/usr/bin/env node
/**
 * Rank answers by BGE for the jump-only set, as an upper bound on what a semantic selector could do.
 *
 * Same replay and chunking as probe-bge-chunk.mjs, but the items and their targets come from
 * docs/experiments/jump-labels.json. Reports rank-1 and top-3 for three aggregations.
 *
 * Usage: node scripts/probe-bge-jump.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { pipeline, env } from '@huggingface/transformers'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

env.cacheDir = 'D:/dsh-token-tree/.cache/transformers'
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
const labels = JSON.parse(readFileSync('docs/experiments/jump-labels.json', 'utf8'))

const dir = join(sessionsRoot, '--D-Python-AI--')
const id = readdirSync(dir).find(name => name.includes(labels.session))
const buffer = readFileSync(join(dir, id, 'session.v4.jsonl.zstd'))
const starts = []
for (let index = 0; index + 4 <= buffer.length; index++) {
  if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
}
const events = []
for (let index = 0; index < starts.length; index++) {
  const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
  let chunk = ''
  try { chunk = zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8') } catch {}
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    try { const record = JSON.parse(line); const event = record.event ?? record; if (event?.type) events.push(event) } catch {}
  }
}
const service = new TokenTreeService({ config: Config['~standard'].validate({ logEdgeUpdates: false }).value, logger })
const session = { id: 'jump', snapshotEvents: () => events }
for (const event of events) service.handleEvent(session, event)
const answers = [...service.stateOf('jump').tree.nodes.values()].filter(node => node.kind === 'answer')

function chunkText(text, size = 300) {
  const sentences = text.split(/(?<=[。！？；\n])/u).filter(sentence => sentence.trim().length > 0)
  const chunks = []
  let current = ''
  for (const sentence of sentences) {
    if (current.length + sentence.length > size && current.length > 0) { chunks.push(current); current = '' }
    current += sentence
  }
  if (current.trim().length > 0) chunks.push(current)
  return chunks.length === 0 ? [text] : chunks
}

const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' })
const cosine = (left, right) => {
  let dot = 0
  let a = 0
  let b = 0
  for (let index = 0; index < left.length; index++) { dot += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2 }
  return dot / Math.sqrt(a * b)
}

const perAnswer = []
for (const answer of answers) {
  const chunks = chunkText(answer.content)
  const result = await extractor(chunks, { pooling: 'mean', normalize: true })
  perAnswer.push({ answer, vectors: result.tolist() })
}

const stats = { best: { rank1: 0, top3: 0 }, meanTop3: { rank1: 0, top3: 0 }, meanAll: { rank1: 0, top3: 0 } }
let total = 0
for (const item of labels.items) {
  const [vector] = (await extractor([item.question], { pooling: 'mean', normalize: true })).tolist()
  const targetIndex = perAnswer.findIndex(entry => entry.answer.metadata?.turn === item.expectedTurn)
  if (targetIndex < 0) continue
  total++
  const ranks = {}
  for (const key of Object.keys(stats)) {
    const scored = perAnswer.map((entry, index) => {
      const scores = entry.vectors.map(chunk => cosine(vector, chunk)).sort((left, right) => right - left)
      const best = scores[0] ?? 0
      const top3 = scores.slice(0, 3)
      const meanTop3 = top3.length === 0 ? 0 : top3.reduce((sum, value) => sum + value, 0) / top3.length
      const meanAll = scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length
      return { index, score: key === 'best' ? best : key === 'meanTop3' ? meanTop3 : meanAll }
    }).sort((left, right) => right.score - left.score)
    const rank = scored.findIndex(row => row.index === targetIndex) + 1
    ranks[key] = rank
    if (rank === 1) stats[key].rank1++
    if (rank > 0 && rank <= 3) stats[key].top3++
  }
  console.log(`期望第${String(item.expectedTurn).padStart(2)}轮 · best ${ranks.best} / meanTop3 ${ranks.meanTop3} / meanAll ${ranks.meanAll} · ${item.question.slice(0, 24)}`)
}
for (const [key, value] of Object.entries(stats)) console.log(`${key.padEnd(8)} rank1 ${value.rank1}/${total} · top3 ${value.top3}/${total}`)
