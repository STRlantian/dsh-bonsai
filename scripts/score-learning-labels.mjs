#!/usr/bin/env node
/**
 * Score the current attachment against the hand labels in docs/experiments/learning-labels.json.
 *
 * "expected" is the answer node that introduced the concept; "root" means the question opens a new
 * topic. The score reports the exact hit rate, and separately the rate over the labels the labeller
 * was confident about.
 *
 * Usage: node scripts/score-learning-labels.mjs [--session 2ba794ae]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const suffix = argOf('session', '2ba794ae')
const labels = JSON.parse(readFileSync('docs/experiments/learning-labels.json', 'utf8'))

const sessionsRoot = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
function load(project, prefix) {
  const dir = join(sessionsRoot, project)
  const id = readdirSync(dir).find(name => name.includes(prefix))
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
    try { const record = JSON.parse(line); const event = record.event ?? record; if (event?.type) events.push(event) } catch {}
  }
  return { id, events }
}

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const margin = Number(argOf('margin', '0.08'))
const config = Config['~standard'].validate({ logEdgeUpdates: false, attachMargin: margin }).value
const { id, events } = load('--D-Python-AI--', suffix)
const service = new TokenTreeService({ config, logger })
service.handleEvent({ id, snapshotEvents: () => events }, events[0])
for (const event of events) service.handleEvent({ id, snapshotEvents: () => events }, event)
const tree = service.stateOf(id).tree

const parentAnswer = question => {
  let cursor = question.parentId === null ? undefined : tree.nodes.get(question.parentId)
  let guard = 0
  while (cursor !== undefined && cursor.kind !== 'answer' && guard < 30) {
    cursor = cursor.parentId === null ? undefined : tree.nodes.get(cursor.parentId)
    guard++
  }
  return cursor
}

let exact = 0
let compared = 0
let confidentExact = 0
let confidentTotal = 0
const rows = []
for (const label of labels.labels) {
  const question = tree.nodes.get(label.question)
  if (question === undefined) continue
  const parent = parentAnswer(question)
  const actual = parent === undefined ? 'root' : parent.id
  const ok = actual === label.expected
  compared++
  if (ok) exact++
  if (label.confidence === 'high') {
    confidentTotal++
    if (ok) confidentExact++
  }
  rows.push({ ...label, actual, ok })
  console.log(`${ok ? '✓' : '✗'} ${label.question} 期望 ${label.expected.padEnd(4)} 实际 ${actual.padEnd(4)} [${label.confidence}] ${label.why}`)
}
console.log(`\n全部标注 ${exact}/${compared} = ${Math.round(exact / compared * 100)}%`)
console.log(`高置信标注 ${confidentExact}/${confidentTotal} = ${confidentTotal === 0 ? 0 : Math.round(confidentExact / confidentTotal * 100)}%`)
