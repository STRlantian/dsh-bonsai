#!/usr/bin/env node
/**
 * Edge-semantic label set for `semanticJump`.
 *
 * Each item is a counterfactual parent→question edge:
 *   positive: the answer that actually introduced the concept (expectedTurn)
 *   negative: the current/last answer (wrongTurn)
 *
 * `semanticJump` should give the positive edge a lower jump than the negative one. The set is
 * generated from the existing learning/paraphrase/jump labels so it can be regenerated.
 *
 * Usage: node scripts/experiment-semantic-jump.mjs
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

const tree = replay('--D-Python-AI--', '2ba794ae', 'semantic-jump')
const answers = [...tree.nodes.values()].filter(node => node.kind === 'answer')
const byId = new Map(answers.map(node => [node.id, node]))
const byTurn = new Map()
for (const node of answers) {
  if (typeof node.metadata?.turn === 'number' && !byTurn.has(node.metadata.turn)) byTurn.set(node.metadata.turn, node)
}
const learning = JSON.parse(readFileSync('docs/experiments/learning-labels.json', 'utf8'))
const paraphrase = JSON.parse(readFileSync('docs/experiments/paraphrase-labels.json', 'utf8'))
const jump = JSON.parse(readFileSync('docs/experiments/jump-labels.json', 'utf8'))

const items = []
for (const label of learning.labels) {
  const question = tree.nodes.get(label.question)
  const target = byId.get(label.expected)
  if (question === undefined || target === undefined || typeof target.metadata?.turn !== 'number') continue
  const wrong = byTurn.get(target.metadata.turn === 18 ? 17 : 18)
  if (wrong === undefined) continue
  items.push({ set: 'learning', question: question.content, expectedTurn: target.metadata.turn, wrongTurn: wrong.metadata.turn })
}
for (const item of paraphrase.items) {
  const target = byTurn.get(item.targetTurn)
  const wrong = byTurn.get(item.targetTurn === 18 ? 17 : 18)
  if (target === undefined || wrong === undefined) continue
  items.push({ set: 'paraphrase', question: item.question, expectedTurn: target.metadata.turn, wrongTurn: wrong.metadata.turn })
}
for (const item of jump.items) {
  const target = byTurn.get(item.expectedTurn)
  const wrong = byTurn.get(item.expectedTurn === 18 ? 17 : 18)
  if (target === undefined || wrong === undefined) continue
  items.push({ set: 'jump', question: item.question, expectedTurn: target.metadata.turn, wrongTurn: wrong.metadata.turn })
}

const outDir = fileURLToPath(new URL('../docs/experiments/', import.meta.url))
writeFileSync(`${outDir}semantic-jump-labels.json`, JSON.stringify({
  session: '2ba794ae',
  note: 'Counterfactual parent edges. positive = expectedTurn, negative = wrongTurn (the current/last answer unless the target is 18). semanticJump should be lower on the positive edge.',
  items,
}, undefined, 2) + '\n')

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
    if (current.length + sentence.length > size && current.length > 0) { chunks.push(current); current = '' }
    current += sentence
  }
  if (current.trim().length > 0) chunks.push(current)
  return chunks.length === 0 ? [text] : chunks
}

const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' })
const bgeWhole = async texts => (await extractor(texts.map(text => text.slice(0, 1500)), { pooling: 'mean', normalize: true })).tolist()
const bgeChunks = async texts => {
  const all = []
  for (const text of texts) all.push((await extractor(chunkText(text), { pooling: 'mean', normalize: true })).tolist())
  return all
}
const meanAll = (query, chunks) => chunks.length === 0 ? 0 : chunks.reduce((sum, chunk) => sum + cosine(query, chunk), 0) / chunks.length

function evaluate(name, score) {
  let correct = 0
  let positive = 0
  let negative = 0
  for (const item of items) {
    const expected = byTurn.get(item.expectedTurn)
    const wrong = byTurn.get(item.wrongTurn)
    const pos = score(item.question, expected)
    const neg = score(item.question, wrong)
    positive += pos
    negative += neg
    if (pos > neg) correct++
  }
  return { name, n: items.length, accuracy: correct / items.length, positive: positive / items.length, negative: negative / items.length, margin: (positive - negative) / items.length }
}

const hashQuery = new Map()
const bgeQuery = new Map()
for (const item of items) {
  if (!hashQuery.has(item.question)) hashQuery.set(item.question, embedText(item.question))
  if (!bgeQuery.has(item.question)) bgeQuery.set(item.question, (await bgeWhole([item.question]))[0])
}
const bgeAnswerWhole = new Map()
const bgeAnswerChunks = new Map()
for (const answer of answers) {
  bgeAnswerWhole.set(answer.id, (await bgeWhole([answer.content]))[0])
  bgeAnswerChunks.set(answer.id, (await bgeChunks([answer.content]))[0])
}

const results = [
  evaluate('hash', (question, answer) => cosine(hashQuery.get(question), embedText(answer.content))),
  evaluate('bge-whole', (question, answer) => cosine(bgeQuery.get(question), bgeAnswerWhole.get(answer.id))),
  evaluate('bge-chunk-meanAll', (question, answer) => meanAll(bgeQuery.get(question), bgeAnswerChunks.get(answer.id))),
]

const md = [
  '# semanticJump edge labels',
  '',
  `Generated from ${items.length} counterfactual edges (${items.filter(x => x.set === 'learning').length} learning, ${items.filter(x => x.set === 'paraphrase').length} paraphrase, ${items.filter(x => x.set === 'jump').length} jump).`,
  '',
  'Positive edge: question → the answer that introduced the concept. Negative edge: question → the current/last answer (turn 18, or 17 when the target is 18).',
  '',
  '| scoring | accuracy | mean positive similarity | mean negative similarity | margin |',
  '|---|---:|---:|---:|---:|',
  ...results.map(row => `| ${row.name} | ${(row.accuracy * 100).toFixed(1)}% | ${row.positive.toFixed(3)} | ${row.negative.toFixed(3)} | ${row.margin.toFixed(3)} |`),
  '',
  'Higher margin is better: the correct parent should be more similar than the current/last answer.',
  '',
].join('\n') + '\n'
writeFileSync(`${outDir}semantic-jump-results.md`, md)
writeFileSync(`${outDir}semantic-jump-results.json`, JSON.stringify({ generatedAt: new Date().toISOString(), model: 'Xenova/bge-small-zh-v1.5', results, items }, undefined, 2) + '\n')

console.log(`semanticJump edge labels: ${items.length} counterfactual edges`)
for (const row of results) {
  console.log(`${row.name.padEnd(18)} accuracy ${(row.accuracy * 100).toFixed(1)}%  pos ${row.positive.toFixed(3)}  neg ${row.negative.toFixed(3)}  margin ${row.margin.toFixed(3)}`)
}
