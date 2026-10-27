#!/usr/bin/env node
/**
 * Would anchoring each question at the answer it depends on help retrieval?
 *
 * Compares two origins for the same query, at the same point in the session:
 *   - the answer the question actually hung under (what a perfect manual anchor gives), and
 *   - the answer of the previous turn (what the automatic attachment uses in practice).
 * Reports whether the needed answer shows up in the retrieved set, and at which rank.
 *
 * Also counts how often the two differ at all: if the dependency is almost always the previous
 * turn, manual anchoring has nothing to add.
 *
 * Usage: SESSION_PROJECT=--D-Python-AI-- node scripts/probe-anchor-retrieval.mjs <prefix>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const project = process.env.SESSION_PROJECT ?? '--D-Python-AI--'
const prefix = process.argv[2]
const dir = join('C:/Users/ASUS/.dsh/sessions', project)
const id = readdirSync(dir).find(name => name.includes(prefix))
if (id === undefined) throw new Error(`no session matching ${prefix}`)

const buffer = readFileSync(join(dir, id, 'session.v4.jsonl.zstd'))
const starts = []
for (let index = 0; index + 4 <= buffer.length; index++) {
  if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
}
let text = ''
for (let index = 0; index < starts.length; index++) {
  const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
  try { text += zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8') } catch {}
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
service.backfillFromSession({ id, snapshotEvents: () => events })
const tree = service.stateOf(id).tree
const nodes = [...tree.nodes.values()]
const idNumber = node => Number(node.id.slice(1))
const answers = nodes.filter(node => node.kind === 'answer').sort((left, right) => idNumber(left) - idNumber(right))

/** Nearest answer ancestor of a question. */
function dependencyOf(question) {
  let cursor = question.parentId === null ? undefined : tree.nodes.get(question.parentId)
  let guard = 0
  while (cursor !== undefined && cursor.kind !== 'answer' && guard < 30) {
    cursor = cursor.parentId === null ? undefined : tree.nodes.get(cursor.parentId)
    guard++
  }
  return cursor
}

const questions = nodes.filter(node => node.kind === 'question' && node.parentId !== null).sort((left, right) => idNumber(left) - idNumber(right))
let compared = 0
let differences = 0
let anchoredHit = 0
let previousHit = 0
let anchoredRank1 = 0
let previousRank1 = 0
const rows = []

for (const question of questions) {
  const dependency = dependencyOf(question)
  if (dependency === undefined) continue
  const previous = answers.filter(answer => idNumber(answer) < idNumber(question)).at(-1)
  if (previous === undefined) continue
  compared++
  if (previous.id === dependency.id) continue
  differences++

  const anchored = service.retrieve(id, { query: question.content, originId: dependency.id })
  const fromPrevious = service.retrieve(id, { query: question.content, originId: previous.id })
  const anchoredIds = (anchored.selected ?? []).map(entry => entry.nodeId)
  const previousIds = (fromPrevious.selected ?? []).map(entry => entry.nodeId)
  const anchoredIndex = anchoredIds.indexOf(dependency.id)
  const previousIndex = previousIds.indexOf(dependency.id)
  if (anchoredIndex >= 0) anchoredHit++
  if (previousIndex >= 0) previousHit++
  if (anchoredIndex === 0) anchoredRank1++
  if (previousIndex === 0) previousRank1++
  rows.push({
    question: question.content.replace(/\s+/g, ' ').slice(0, 36),
    anchored: anchoredIndex,
    previous: previousIndex,
  })
}

console.log(`${id.slice(-12)} · questions ${compared} · dependency differs from the previous answer ${differences} (${(differences / Math.max(1, compared) * 100).toFixed(0)}%)`)
if (differences > 0) {
  console.log(`dependency found in retrieval — anchored origin: ${anchoredHit}/${differences} (rank 1: ${anchoredRank1})`)
  console.log(`dependency found in retrieval — previous-answer origin: ${previousHit}/${differences} (rank 1: ${previousRank1})`)
}
for (const row of rows.slice(0, 8)) {
  console.log(`  anchored ${row.anchored < 0 ? '-' : row.anchored + 1} · previous ${row.previous < 0 ? '-' : row.previous + 1} · ${row.question}`)
}
