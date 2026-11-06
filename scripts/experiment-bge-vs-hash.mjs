#!/usr/bin/env node
/**
 * Replace the runtime hashed embedding with BGE and measure the difference on the labelled sets.
 *
 * This isolates the embedding: every answer node is ranked by cosine to the question, once with
 * `embedText()` (the shipping local hash) and once with BGE (whole answer, or a mean of chunk
 * vectors). It does not touch plugin code.
 *
 * Usage: node scripts/experiment-bge-vs-hash.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { pipeline, env } from '@huggingface/transformers'

import { embedText } from '../src/core/embedding.ts'
import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

env.cacheDir = 'D:/dsh-token-tree/.cache/transformers'
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')

function replay(project, prefix, sessionId) {
  const dir = join(sessionsRoot, project)
  const id = readdirSync(dir).find(name => name.includes(prefix))
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
  const session = { id: sessionId, snapshotEvents: () => events }
  for (const event of events) service.handleEvent(session, event)
  return service.stateOf(sessionId).tree
}

const cosine = (left, right) => {
  let dot = 0
  let a = 0
  let b = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    a += left[index] ** 2
    b += right[index] ** 2
  }
  return a === 0 || b === 0 ? 0 : dot / Math.sqrt(a * b)
}

function chunkText(text, size = 300) {
  const sentences = text.split(/(?<=[。！？；\n])/u).filter(sentence => sentence.trim().length > 0)
  const chunks = []
  let current = ''
  for (const sentence of sentences) {
    if (current.length + sentence.length > size && current.length > 0) {
      chunks.push(current)
      current = ''
    }
    current += sentence
  }
  if (current.trim().length > 0) chunks.push(current)
  return chunks.length === 0 ? [text] : chunks
}

const tree = replay('--D-Python-AI--', '2ba794ae', 'bge-vs-hash')
const answers = [...tree.nodes.values()].filter(node => node.kind === 'answer')
const answerById = new Map(answers.map(node => [node.id, node]))
const answerByTurn = new Map()
for (const node of answers) {
  const turn = node.metadata?.turn
  if (typeof turn === 'number' && !answerByTurn.has(turn)) answerByTurn.set(turn, node)
}

const learningLabels = JSON.parse(readFileSync('docs/experiments/learning-labels.json', 'utf8'))
const paraphraseLabels = JSON.parse(readFileSync('docs/experiments/paraphrase-labels.json', 'utf8'))
const jumpLabels = JSON.parse(readFileSync('docs/experiments/jump-labels.json', 'utf8'))

const sets = []
for (const label of learningLabels.labels) {
  const question = tree.nodes.get(label.question)
  const target = answerById.get(label.expected)
  if (question === undefined || target === undefined) continue
  sets.push({ set: 'learning', question: question.content, target, label: label.question })
}
for (const item of paraphraseLabels.items) {
  const target = answerByTurn.get(item.targetTurn)
  if (target === undefined) continue
  sets.push({ set: 'paraphrase', question: item.question, target, label: item.note ?? '' })
}
for (const item of jumpLabels.items) {
  const target = answerByTurn.get(item.expectedTurn)
  if (target === undefined) continue
  sets.push({ set: 'jump', question: item.question, target, label: '' })
}

const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' })
const bgeWhole = async texts => (await extractor(texts.map(text => text.slice(0, 1500)), { pooling: 'mean', normalize: true })).tolist()
const bgeChunks = async texts => {
  const all = []
  for (const text of texts) {
    const chunks = chunkText(text)
    const vectors = (await extractor(chunks, { pooling: 'mean', normalize: true })).tolist()
    const mean = new Array(vectors[0].length).fill(0)
    for (const vector of vectors) for (let index = 0; index < vector.length; index++) mean[index] += vector[index]
    for (let index = 0; index < mean.length; index++) mean[index] /= Math.max(1, vectors.length)
    all.push(mean)
  }
  return all
}

const answerTexts = answers.map(node => node.content)
const hashVectors = answerTexts.map(text => embedText(text))
const wholeVectors = await bgeWhole(answerTexts)
const chunkVectors = await bgeChunks(answerTexts)

const methods = [
  { id: 'hash', label: 'hash 256d (current)', embed: async texts => texts.map(text => embedText(text)), answerVectors: hashVectors },
  { id: 'bge', label: 'BGE whole answer', embed: async texts => bgeWhole(texts), answerVectors: wholeVectors },
  { id: 'bge-chunk', label: 'BGE chunk mean vector', embed: async texts => bgeChunks(texts), answerVectors: chunkVectors },
]

const rows = []
for (const method of methods) {
  for (const item of sets) {
    const [query] = await method.embed([item.question])
    const targetIndex = answers.findIndex(node => node.id === item.target.id)
    if (targetIndex < 0) continue
    const scored = answers.map((node, index) => ({ node, score: cosine(query, method.answerVectors[index]) }))
      .sort((left, right) => right.score - left.score)
    const rank = scored.findIndex(row => row.node.id === item.target.id) + 1
    rows.push({ method: method.id, set: item.set, question: item.question, target: item.target.id, targetTurn: item.target.metadata?.turn, rank, score: scored[rank - 1]?.score ?? 0, bestTurn: scored[0]?.node.metadata?.turn })
  }
}

const metrics = {}
for (const method of methods) {
  for (const set of ['learning', 'paraphrase', 'jump', 'all']) {
    const list = rows.filter(row => row.method === method.id && (set === 'all' || row.set === set))
    const rank1 = list.filter(row => row.rank === 1).length
    const top3 = list.filter(row => row.rank > 0 && row.rank <= 3).length
    const mrr = list.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0) / Math.max(1, list.length)
    metrics[`${method.id}:${set}`] = { total: list.length, rank1, top3, mrr }
  }
}

const header = ['method', 'set', 'total', 'rank1', 'top3', 'mrr']
const csv = [
  header.join(','),
  ...Object.entries(metrics).map(([key, value]) => {
    const [method, set] = key.split(':')
    return [method, set, value.total, value.rank1, value.top3, value.mrr.toFixed(4)].join(',')
  }),
].join('\n') + '\n'
const outDir = fileURLToPath(new URL('../docs/experiments/', import.meta.url))
writeFileSync(`${outDir}bge-vs-hash-embedding.csv`, csv)
writeFileSync(`${outDir}bge-vs-hash-embedding.json`, JSON.stringify({
  generatedAt: new Date().toISOString(),
  model: 'Xenova/bge-small-zh-v1.5',
  sets: { learning: 18, paraphrase: 8, jump: 15 },
  metrics,
  rows,
}, undefined, 2) + '\n')

const md = [
  '# BGE vs hashed embedding',
  '',
  'Same answer nodes from session `2ba794ae`, same questions and labels. Only the answer/question',
  'vector changes; ranking is cosine over all answer nodes. `bge-chunk` averages 300-character',
  'chunk vectors into one node vector. This is an embedding-only comparison, not the full retrieval',
  'score with path weights.',
  '',
  '| method | set | N | rank1 | top3 | MRR |',
  '|---|---|---:|---:|---:|---:|',
  ...Object.entries(metrics).map(([key, value]) => {
    const [method, set] = key.split(':')
    return `| ${method} | ${set} | ${value.total} | ${value.rank1} | ${value.top3} | ${value.mrr.toFixed(3)} |`
  }),
  '',
].join('\n') + '\n'
writeFileSync(`${outDir}bge-vs-hash-embedding.md`, md)

for (const method of methods) {
  console.log(`\n${method.label}`)
  for (const set of ['learning', 'paraphrase', 'jump', 'all']) {
    const value = metrics[`${method.id}:${set}`]
    console.log(`  ${set.padEnd(11)} N=${value.total} rank1=${value.rank1} top3=${value.top3} MRR=${value.mrr.toFixed(3)}`)
  }
}
