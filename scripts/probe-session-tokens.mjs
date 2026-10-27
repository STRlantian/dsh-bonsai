#!/usr/bin/env node
/**
 * Compare token usage between two sessions.
 *
 * Usage: node scripts/probe-session-tokens.mjs <session-prefix> [<session-prefix> ...]
 *
 * Reads the usage blocks the host records on every assistant message, so the numbers are the
 * provider's, not an estimate. Also reports what the plugin visibly contributed: extra injected
 * messages, tool-schema characters and fold events.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const project = process.env.SESSION_PROJECT ?? '--D-Python-AI--'
const dir = join('C:/Users/ASUS/.dsh/sessions', project)

function readSession(prefix) {
  const id = readdirSync(dir).find(name => name.includes(prefix))
  if (id === undefined) throw new Error(`no session matching ${prefix}`)
  const buffer = readFileSync(join(dir, id, 'session.v4.jsonl.zstd'))
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) starts.push(i)
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
  return { id, events }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n')
}

function summarise(prefix) {
  const { id, events } = readSession(prefix)
  const usage = events.filter(event => event.type === 'assistant/message').map(event => event.data.usage).filter(Boolean)
  const sum = key => usage.reduce((total, entry) => total + (entry[key] ?? 0), 0)
  const perTurn = new Map()
  for (const event of events.filter(event => event.type === 'assistant/message')) {
    const data = event.data
    if (data.usage === undefined) continue
    const turn = data.turn ?? 0
    const current = perTurn.get(turn) ?? { prompt: 0, cache: 0, output: 0, steps: 0 }
    current.prompt += data.usage.inputTokens ?? 0
    current.cache += data.usage.cacheReadTokens ?? 0
    current.output += data.usage.outputTokens ?? 0
    current.steps += 1
    perTurn.set(turn, current)
  }
  const users = events.filter(event => event.type === 'user/message')
  const injected = users.filter(event => {
    const text = textOf(event.data?.content)
    return /^Current runtime context|^Time sampled|^\[盆栽\]|^\[token-tree\]|^session-log/.test(text.trim())
  })
  const pluginHints = users.filter(event => textOf(event.data?.content).includes('[盆栽]'))
  const surfaces = events.filter(event => JSON.stringify(event.data ?? {}).includes('surfaceOp'))
  const headers = events.filter(event => event.type === 'request/header')
  let tools = null
  let schemaChars = null
  for (const header of headers) {
    const data = header.data ?? {}
    const list = data.tools ?? data.toolSchemas
    if (Array.isArray(list)) {
      tools = list.length
      schemaChars = JSON.stringify(list).length
      break
    }
  }
  return {
    id: id.slice(-12),
    steps: usage.length,
    turns: perTurn.size,
    input: sum('inputTokens'),
    cache: sum('cacheReadTokens'),
    output: sum('outputTokens'),
    total: sum('totalTokens'),
    perTurn,
    users: users.length,
    injected: injected.length,
    pluginHints: pluginHints.length,
    surfaces: surfaces.length,
    tools,
    schemaChars,
  }
}

const rows = process.argv.slice(2).map(summarise)
for (const row of rows) {
  console.log(`\n== ${row.id} ==`)
  console.log(`steps ${row.steps} · turns ${row.turns} · tools ${row.tools ?? '?'} (${row.schemaChars ?? '?'} schema chars)`)
  console.log(`user messages ${row.users} (host injections ${row.injected}, plugin hints ${row.pluginHints}) · surface ops ${row.surfaces}`)
  console.log(`input ${row.input} · cache read ${row.cache} · output ${row.output} · total ${row.total}`)
  const promptPerStep = row.input + row.cache
  console.log(`prompt per step ≈ ${Math.round(promptPerStep / row.steps)} tokens · cache share ${(row.cache / Math.max(1, promptPerStep) * 100).toFixed(1)}%`)
  const turns = [...row.perTurn.entries()].sort((left, right) => left[0] - right[0])
  console.log('per turn (prompt = input + cache):')
  for (const [turn, value] of turns) {
    console.log(`  turn ${String(turn).padStart(2)} · steps ${value.steps} · prompt ${value.prompt + value.cache} (cache ${value.cache}) · output ${value.output}`)
  }
}
