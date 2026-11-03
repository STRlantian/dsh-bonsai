#!/usr/bin/env node
/**
 * Precompute BGE chunk similarity for the experiment questions, so the plugin's own scoring can use
 * it without carrying the model.
 *
 * For every question (18 labelled + 8 paraphrase probes) and every answer, the value stored is the
 * highest cosine between the question and any chunk of that answer. Output: a JSON map
 * question -> { answerId: score }.
 *
 * Usage: node scripts/build-bge-map.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { pipeline, env } from '@huggingface/transformers'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

env.cacheDir = 'D:/dsh-token-tree/.cache/transformers'
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')

const dir = join(sessionsRoot, '--D-Python-AI--')
const id = readdirSync(dir).find(name => name.includes('2ba794ae'))
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
const session = { id: 'bge-map', snapshotEvents: () => events }
for (const event of events) service.handleEvent(session, event)
const tree = service.stateOf('bge-map').tree
const answers = [...tree.nodes.values()].filter(node => node.kind === 'answer')

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

// Embed every answer's chunks once.
const chunkVectors = []
for (const answer of answers) {
  const chunks = chunkText(answer.content)
  const result = await extractor(chunks, { pooling: 'mean', normalize: true })
  chunkVectors.push({ answerId: answer.id, vectors: result.tolist() })
}

const labels = JSON.parse(readFileSync('docs/experiments/learning-labels.json', 'utf8'))
const paraphrase = JSON.parse(readFileSync('docs/experiments/paraphrase-labels.json', 'utf8'))
const questions = []
for (const label of labels.labels) {
  const node = tree.nodes.get(label.question)
  if (node !== undefined) questions.push(node.content)
}
for (const item of paraphrase.items) questions.push(item.question)

const map = {}
for (const question of questions) {
  const [vector] = (await extractor([question], { pooling: 'mean', normalize: true })).tolist()
  const scores = {}
  for (const entry of chunkVectors) {
    let best = 0
    for (const chunk of entry.vectors) {
      const value = cosine(vector, chunk)
      if (value > best) best = value
    }
    scores[entry.answerId] = Number(best.toFixed(4))
  }
  map[question] = scores
}
writeFileSync('docs/experiments/bge-map.json', JSON.stringify(map, undefined, 2) + '\n', 'utf8')
console.log('questions mapped:', questions.length, '· answers per question:', answers.length)
