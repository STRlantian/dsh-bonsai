#!/usr/bin/env node
/**
 * Find questions whose correct parent is probably NOT the previous answer.
 *
 * A "jump" candidate: the question names a term that the previous answer does not contain, but some
 * earlier answer does. The earlier answer is then a plausible parent, and any scorer that only stays
 * put will get it wrong. The output is a candidate list for hand review, not a finished label set.
 *
 * Usage: node scripts/find-jump-candidates.mjs [--min-turns 12] [--out docs/experiments/jump-candidates.json]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { contentFeatures } from '../src/core/embedding.ts'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const minTurns = Number(argOf('min-turns', '12'))
const outPath = argOf('out', 'docs/experiments/jump-candidates.json')
const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function loadEvents(path) {
  const buffer = readFileSync(path)
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
  return events
}

const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const candidates = []
for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  const dir = join(sessionsRoot, project.name)
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'session.v4.jsonl.zstd')
    let events
    try { events = loadEvents(file) } catch { continue }
    if (events.length === 0) continue
    const service = new TokenTreeService({ config, logger })
    const session = { id: name, snapshotEvents: () => events }
    try {
      for (const event of events) service.handleEvent(session, event)
    } catch { continue }
    const tree = service.stateOf(name).tree
    const questions = [...tree.nodes.values()].filter(node => node.kind === 'question').sort((a, b) => (a.metadata?.turn ?? 0) - (b.metadata?.turn ?? 0))
    if (questions.length < minTurns) continue
    const answers = [...tree.nodes.values()].filter(node => node.kind === 'answer')
    const byTurn = new Map(answers.map(node => [node.metadata?.turn, node]))
    const features = new Map(answers.map(node => [node.id, contentFeatures(node.content)]))
    const df = new Map()
    for (const set of features.values()) for (const term of set) df.set(term, (df.get(term) ?? 0) + 1)
    for (const question of questions) {
      const turn = question.metadata?.turn ?? 0
      const previous = byTurn.get(turn - 1)
      if (previous === undefined) continue
      const previousFeatures = features.get(previous.id) ?? new Set()
      // A rare term of the question that the previous answer lacks but an earlier answer has.
      const terms = [...contentFeatures(question.content)]
        .filter(term => term.length >= 2 && (df.get(term) ?? 0) >= 1 && (df.get(term) ?? 0) <= 2 && !previousFeatures.has(term))
      const hit = terms
        .map(term => ({ term, owners: answers.filter(answer => (answer.metadata?.turn ?? 0) < turn && features.get(answer.id)?.has(term)) }))
        .find(entry => entry.owners.length > 0)
      if (hit === undefined) continue
      const target = hit.owners[0]
      candidates.push({
        session: { project: project.name, id: name },
        question: question.id,
        turn,
        text: question.content.slice(0, 60),
        term: hit.term,
        target: target.id,
        targetTurn: target.metadata?.turn,
        previous: previous.id,
        currentParent: question.parentId,
      })
    }
  }
}

writeFileSync(outPath, JSON.stringify(candidates, undefined, 2) + '\n', 'utf8')
console.log('candidates:', candidates.length, '→', outPath)
for (const candidate of candidates.slice(0, 25)) {
  console.log(`  ${candidate.session.id.slice(-8)} 第${candidate.turn}轮 "${candidate.text}" 词=${candidate.term} 目标=${candidate.target}(第${candidate.targetTurn}轮) 当前父=${candidate.currentParent}`)
}
