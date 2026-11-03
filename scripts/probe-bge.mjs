#!/usr/bin/env node
/**
 * Offline check of BGE for synonymy: does a real embedding rank the intended answer where our
 * lexical score does not?
 *
 * Two sets: the 18 labelled learning questions and the 6 paraphrase probes (plus 2 controls). For
 * each item the script embeds the question and every answer, ranks answers by cosine, and reports the
 * rank of the intended answer. No plugin code is touched; this is a measurement, not a dependency.
 *
 * Usage: node scripts/probe-bge.mjs
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
  const result = await extractor(texts.map(text => text.slice(0, 1500)), { pooling: 'mean', normalize: true })
  return result.tolist()
}

async function evaluate(label, tree, items) {
  const answers = [...tree.nodes.values()].filter(node => node.kind === 'answer')
  const answerVectors = await embed(answers.map(node => node.content))
  let rank1 = 0
  let top3 = 0
  let total = 0
  for (const item of items) {
    const targetIndex = answers.findIndex(node => node.metadata?.turn === item.targetTurn)
    if (targetIndex < 0) continue
    const [vector] = await embed([item.question])
    const scored = answers.map((node, index) => ({ node, score: cosine(vector, answerVectors[index]) }))
      .sort((left, right) => right.score - left.score)
    const rank = scored.findIndex(row => row.node.id === answers[targetIndex].id) + 1
    total++
    if (rank === 1) rank1++
    if (rank > 0 && rank <= 3) top3++
    const best = scored[0]
    console.log(`${rank === 1 ? '✓' : '✗'} rank ${rank} · 目标第${answers[targetIndex].metadata?.turn}轮 · best 第${best.node.metadata?.turn}轮(${best.score.toFixed(3)}) · ${item.question.slice(0, 22)}`)
  }
  console.log(`${label}: rank1 ${rank1}/${total} · top3 ${top3}/${total}`)
}

const learning = replay('--D-Python-AI--', '2ba794ae', 'bge-learn')
const labels = JSON.parse(readFileSync('docs/experiments/learning-labels.json', 'utf8'))
const answerTurnOfId = id => learning.nodes?.get?.(id)?.metadata?.turn ?? undefined
const labelItems = []
for (const label of labels.labels) {
  const question = learning.nodes.get(label.question)
  if (question === undefined || label.expected === 'root') continue
  const target = learning.nodes.get(label.expected)
  if (target === undefined) continue
  labelItems.push({ question: question.content, targetTurn: target.metadata?.turn, label: label.question })
}
void answerTurnOfId
await evaluate('18 条标注（去掉 root 项）', learning, labelItems)

const paraphrase = JSON.parse(readFileSync('docs/experiments/paraphrase-labels.json', 'utf8'))
await evaluate('同义改写 8 条', learning, paraphrase.items.map(item => ({ question: item.question, targetTurn: item.targetTurn })))
