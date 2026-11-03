#!/usr/bin/env node
/**
 * BGE with chunking: long answers get split, every chunk is embedded, and an answer is scored by its
 * best chunk instead of by the first 512 tokens.
 *
 * Same two sets as probe-bge.mjs (18 labelled questions, 8 paraphrase probes). Reports rank-1 and
 * top-3 for three aggregations: best chunk, mean of the three best chunks, and mean of all chunks.
 * Brute force over every chunk is used on purpose: with a few hundred chunks it costs milliseconds,
 * so an ANN index would be machinery without a payoff at this size.
 *
 * Usage: node scripts/probe-bge-chunk.mjs
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

/** Split into chunks of roughly `size` characters, preferring sentence boundaries. */
function chunkText(text, size = 300) {
  const sentences = text.split(/(?<=[。！？；\n])/u).filter(sentence => sentence.trim().length > 0)
  const chunks = []
  let buffer = ''
  for (const sentence of sentences) {
    if (buffer.length + sentence.length > size && buffer.length > 0) {
      chunks.push(buffer)
      buffer = ''
    }
    buffer += sentence
  }
  if (buffer.trim().length > 0) chunks.push(buffer)
  return chunks.length === 0 ? [text] : chunks
}

const cosine = (left, right) => {
  let dot = 0
  let a = 0
  let b = 0
  for (let index = 0; index < left.length; index++) { dot += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2 }
  return dot / Math.sqrt(a * b)
}

const started = Date.now()
const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' })
console.log('model loaded in', Date.now() - started, 'ms')
const embed = async texts => {
  const result = await extractor(texts, { pooling: (process.env.BGE_POOLING ?? 'mean'), normalize: true })
  return result.tolist()
}

async function evaluate(label, tree, items) {
  const answers = [...tree.nodes.values()].filter(node => node.kind === 'answer')
  const chunkStart = Date.now()
  const perAnswer = []
  let chunkCount = 0
  for (const answer of answers) {
    const chunks = chunkText(answer.content)
    chunkCount += chunks.length
    const vectors = await embed(chunks)
    perAnswer.push({ answer, chunks, vectors })
  }
  console.log(`${label}: ${answers.length} 个回答 → ${chunkCount} 个 chunk，嵌入耗时 ${Date.now() - chunkStart} ms`)

  const scoreOf = (questionVector, entry) => {
    const scores = entry.vectors.map(vector => cosine(questionVector, vector)).sort((left, right) => right - left)
    const best = scores[0] ?? 0
    const top3 = scores.slice(0, 3)
    const meanTop3 = top3.length === 0 ? 0 : top3.reduce((sum, value) => sum + value, 0) / top3.length
    const meanAll = scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length
    return { best, meanTop3, meanAll }
  }

  const stats = { best: { rank1: 0, top3: 0 }, meanTop3: { rank1: 0, top3: 0 }, meanAll: { rank1: 0, top3: 0 } }
  let total = 0
  for (const item of items) {
    const targetIndex = perAnswer.findIndex(entry => entry.answer.metadata?.turn === item.targetTurn)
    if (targetIndex < 0) continue
    const [questionVector] = await embed([item.question])
    total++
    for (const key of Object.keys(stats)) {
      const scored = perAnswer.map((entry, index) => ({ index, score: scoreOf(questionVector, entry)[key] }))
        .sort((left, right) => right.score - left.score)
      const rank = scored.findIndex(row => row.index === targetIndex) + 1
      if (process.env.PER_ITEM === '1' && key === 'meanAll') console.log('  item', item.question.slice(0, 20), '→ rank', rank, '(target turn ' + item.targetTurn + ')')
      if (rank === 1) stats[key].rank1++
      if (rank > 0 && rank <= 3) stats[key].top3++
    }
  }
  for (const [key, value] of Object.entries(stats)) {
    console.log(`${label} · ${key.padEnd(8)} rank1 ${value.rank1}/${total} · top3 ${value.top3}/${total}`)
  }
}

const learning = replay('--D-Python-AI--', '2ba794ae', 'bge-chunk')
const labels = JSON.parse(readFileSync('docs/experiments/learning-labels.json', 'utf8'))
const labelItems = []
for (const label of labels.labels) {
  const question = learning.nodes.get(label.question)
  if (question === undefined || label.expected === 'root') continue
  const target = learning.nodes.get(label.expected)
  if (target === undefined) continue
  labelItems.push({ question: question.content, targetTurn: target.metadata?.turn })
}
await evaluate('18 条标注（17 条）', learning, labelItems)

const paraphrase = JSON.parse(readFileSync('docs/experiments/paraphrase-labels.json', 'utf8'))
await evaluate('同义改写 8 条', learning, paraphrase.items.map(item => ({ question: item.question, targetTurn: item.targetTurn })))
