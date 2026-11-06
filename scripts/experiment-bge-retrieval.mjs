#!/usr/bin/env node
/**
 * Full retrieval comparison: hash vs BGE node/query vectors, with and without BGE edge costs.
 *
 * The earlier experiment ranked answer nodes by cosine alone. This one runs the actual
 * `retrieveContext` scoring (path weight, ancestor boost, threshold, top-k) so the edge-cost
 * effect of switching node embeddings is included.
 *
 * Usage: node scripts/experiment-bge-retrieval.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

import { pipeline, env } from '@huggingface/transformers'

import { embedText } from '../src/core/embedding.ts'
import { computeEdgeCost } from '../src/core/weight.ts'
import { retrieveContext } from '../src/core/retrieve.ts'
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

const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' })

async function bgeVectors(texts) {
  return (await extractor(texts.map(text => text.slice(0, 1500)), { pooling: 'mean', normalize: true })).tolist()
}

const learning = JSON.parse(readFileSync('docs/experiments/learning-labels.json', 'utf8'))
const paraphrase = JSON.parse(readFileSync('docs/experiments/paraphrase-labels.json', 'utf8'))
const jump = JSON.parse(readFileSync('docs/experiments/jump-labels.json', 'utf8'))

function buildItems(tree) {
  const answers = [...tree.nodes.values()].filter(node => node.kind === 'answer')
  const byId = new Map(answers.map(node => [node.id, node]))
  const byTurn = new Map()
  for (const node of answers) {
    if (typeof node.metadata?.turn === 'number' && !byTurn.has(node.metadata.turn)) byTurn.set(node.metadata.turn, node)
  }
  const items = []
  for (const label of learning.labels) {
    const question = tree.nodes.get(label.question)
    const target = byId.get(label.expected)
    if (question !== undefined && target !== undefined) items.push({ set: 'learning', question: question.content, target })
  }
  for (const item of paraphrase.items) {
    const target = byTurn.get(item.targetTurn)
    if (target !== undefined) items.push({ set: 'paraphrase', question: item.question, target })
  }
  for (const item of jump.items) {
    const target = byTurn.get(item.expectedTurn)
    if (target !== undefined) items.push({ set: 'jump', question: item.question, target })
  }
  return items
}

function metrics(tree, items, queryVectors) {
  const result = { learning: { n: 0, rank1: 0, top3: 0, mrr: 0 }, paraphrase: { n: 0, rank1: 0, top3: 0, mrr: 0 }, jump: { n: 0, rank1: 0, top3: 0, mrr: 0 }, all: { n: 0, rank1: 0, top3: 0, mrr: 0 } }
  for (const item of items) {
    const retrieved = retrieveContext(tree, {
      query: item.question,
      queryEmbedding: queryVectors.get(item.question),
      originId: tree.currentId,
      budgetTokens: 1_000_000_000,
      topK: 999,
      threshold: 0,
      admitRelevance: 0,
      includeRoot: true,
      summaryMatch: false,
    })
    const rank = retrieved.selected.findIndex(node => node.nodeId === item.target.id) + 1
    for (const key of [item.set, 'all']) {
      const row = result[key]
      row.n++
      if (rank === 1) row.rank1++
      if (rank > 0 && rank <= 3) row.top3++
      row.mrr += rank > 0 ? 1 / rank : 0
    }
  }
  for (const row of Object.values(result)) row.mrr /= Math.max(1, row.n)
  return result
}

const hashTree = replay('--D-Python-AI--', '2ba794ae', 'bge-retrieval-hash')
const hashItems = buildItems(hashTree)
const hashVectors = new Map(hashItems.map(item => [item.question, embedText(item.question)]))
const hashMetrics = metrics(hashTree, hashItems, hashVectors)

const bgeTree = replay('--D-Python-AI--', '2ba794ae', 'bge-retrieval-bge')
const bgeItems = buildItems(bgeTree)
const bgeTexts = [...bgeTree.nodes.values()].map(node => node.content)
const bgeNodeVectors = await bgeVectors(bgeTexts)
const bgeSummaryVectors = await bgeVectors([...bgeTree.nodes.values()].map(node => node.summary ?? ''))
for (const [index, node] of [...bgeTree.nodes.values()].entries()) {
  node.embedding = bgeNodeVectors[index]
  if (node.summary !== undefined) node.summaryEmbedding = bgeSummaryVectors[index]
}
const bgeVectorsByQuestion = new Map()
for (const item of bgeItems) {
  if (!bgeVectorsByQuestion.has(item.question)) bgeVectorsByQuestion.set(item.question, (await bgeVectors([item.question]))[0])
}

// Retrieval-only BGE: node/query vectors changed, edge prices stay as they were under hash.
const retrievalOnly = metrics(bgeTree, bgeItems, bgeVectorsByQuestion)

// Measure what replacing the node vectors does to edge prices before mutating the tree.
const edgeDeltas = []
for (const edge of bgeTree.edges.values()) {
  const parent = bgeTree.node(edge.from)
  const child = bgeTree.node(edge.to)
  const next = computeEdgeCost(parent, child, bgeTree.params, { hasSibling: parent.children.length > 1 })
  edgeDeltas.push({
    jumpHash: edge.components.semanticJump,
    jumpBge: next.components.semanticJump,
    costHash: edge.cost,
    costBge: next.cost,
  })
}
const edgeSummary = {
  edges: edgeDeltas.length,
  meanJumpHash: edgeDeltas.reduce((sum, row) => sum + row.jumpHash, 0) / Math.max(1, edgeDeltas.length),
  meanJumpBge: edgeDeltas.reduce((sum, row) => sum + row.jumpBge, 0) / Math.max(1, edgeDeltas.length),
  meanCostHash: edgeDeltas.reduce((sum, row) => sum + row.costHash, 0) / Math.max(1, edgeDeltas.length),
  meanCostBge: edgeDeltas.reduce((sum, row) => sum + row.costBge, 0) / Math.max(1, edgeDeltas.length),
  jumpDown: edgeDeltas.filter(row => row.jumpBge < row.jumpHash).length,
  jumpUp: edgeDeltas.filter(row => row.jumpBge > row.jumpHash).length,
  jumpSame: edgeDeltas.filter(row => row.jumpBge === row.jumpHash).length,
}

// Full BGE: also reprice every edge with the BGE node vectors.
for (const edge of bgeTree.edges.values()) {
  const parent = bgeTree.node(edge.from)
  const child = bgeTree.node(edge.to)
  const next = computeEdgeCost(parent, child, bgeTree.params, { hasSibling: parent.children.length > 1 })
  edge.cost = next.cost
  edge.components = next.components
}
const full = metrics(bgeTree, bgeItems, bgeVectorsByQuestion)

const out = {
  generatedAt: new Date().toISOString(),
  model: 'Xenova/bge-small-zh-v1.5',
  sets: { learning: hashItems.filter(x => x.set === 'learning').length, paraphrase: hashItems.filter(x => x.set === 'paraphrase').length, jump: hashItems.filter(x => x.set === 'jump').length },
  hash: hashMetrics,
  bge: retrievalOnly,
  bgeEdges: full,
  edgeSummary,
}

console.log('hash full retrieval')
for (const [key, value] of Object.entries(hashMetrics)) console.log(' ', key, value.n, 'rank1', value.rank1, 'top3', value.top3, 'MRR', value.mrr.toFixed(3))
console.log('BGE node/query, hash edge prices')
for (const [key, value] of Object.entries(retrievalOnly)) console.log(' ', key, value.n, 'rank1', value.rank1, 'top3', value.top3, 'MRR', value.mrr.toFixed(3))
console.log('BGE node/query and BGE edge prices')
for (const [key, value] of Object.entries(full)) console.log(' ', key, value.n, 'rank1', value.rank1, 'top3', value.top3, 'MRR', value.mrr.toFixed(3))
console.log('edge semanticJump (hash -> BGE)')
console.log(`  mean ${edgeSummary.meanJumpHash.toFixed(3)} -> ${edgeSummary.meanJumpBge.toFixed(3)}, down ${edgeSummary.jumpDown}, up ${edgeSummary.jumpUp}, same ${edgeSummary.jumpSame}`)
console.log(`  mean cost ${edgeSummary.meanCostHash.toFixed(3)} -> ${edgeSummary.meanCostBge.toFixed(3)}`)

const outDir = fileURLToPath(new URL('../docs/experiments/', import.meta.url))
writeFileSync(`${outDir}bge-retrieval.json`, JSON.stringify(out, undefined, 2) + '\n')
