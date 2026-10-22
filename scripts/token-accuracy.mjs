#!/usr/bin/env node
/**
 * Which count is right: the local tokenizer, or the characters/2.5 estimate?
 *
 * Ground truth is what the provider billed: `usage.inputTokens + cacheReadTokens +
 * cacheWriteTokens` on each assistant step is the size of the prompt that was sent.
 * This reconstructs, for a step, the text that step added over the previous one, counts
 * it both ways, and compares against the observed delta.
 *
 * Only single-step turns are used (no tool calls), so the delta is exactly "previous
 * answer + this question" and nothing else is moving.
 *
 * Usage:
 *   node scripts/token-accuracy.mjs --session <session-dir>
 *   node scripts/token-accuracy.mjs            # newest session with enough turns
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { estimateTokens } from '../src/core/tokens.ts'
import { TokenRatio } from '../src/core/ratio.ts'
import { loadTokenizer } from './tokenizer-lib.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const tokenizerPath = argOf('tokenizer', 'C:/Users/ASUS/.dsh/token-tree/deepseek_v4_tokenizer/tokenizer.json')
const tokenizer = loadTokenizer(tokenizerPath)

/** Every session directory, newest first. */
function sessionDirs() {
  const root = 'C:/Users/ASUS/.dsh/sessions'
  const out = []
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const session of readdirSync(projectDir)) {
      const file = join(projectDir, session, 'session.v4.jsonl.zstd')
      try {
        out.push({ file, session, at: statSync(file).mtimeMs })
      } catch {
        // No log for this session.
      }
    }
  }
  out.sort((left, right) => right.at - left.at)
  return out
}

/** Decode one session log into records. */
function decode(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
  }
  let text = ''
  for (let index = 0; index < starts.length; index++) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8')
    } catch {
      // Torn tail frame.
    }
  }
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // Partial last line.
    }
  }
  return records.map(record => record.event ?? record)
}

/** Text of one message record. */
function textOf(record) {
  const content = record?.data?.content ?? record?.data?.message?.content ?? []
  if (typeof content === 'string') return content
  return content.filter(part => part?.type === 'text').map(part => part.text).join('')
}

/** The estimate the plugin actually used before this change. */
const estimate = text => estimateTokens(text)

const file = argOf('session', undefined)
const candidates = file === undefined ? sessionDirs() : [{ file: file.endsWith('.zstd') ? file : join(file, 'session.v4.jsonl.zstd') }]

for (const candidate of candidates.slice(0, 5)) {
  const records = decode(candidate.file)
  const steps = []
  const messages = []
  for (const record of records) {
    if (record.type === 'user/message' && record.data?.source?.kind === 'user') messages.push({ kind: 'user', text: textOf(record) })
    if (record.type === 'assistant/message') {
      const usage = record.data?.usage
      messages.push({ kind: 'assistant', text: textOf(record) })
      if (usage !== undefined) {
        steps.push({
          index: steps.length,
          total: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          input: usage.inputTokens ?? 0,
          toolCalls: 0,
          messagesSoFar: messages.length,
        })
      }
    }
  }
  // Only steps where exactly one user and one assistant message were added since the
  // previous step — those deltas are unambiguous.
  const rows = []
  // The learned ratio is trained online: estimate first, then observe the exact count, so
  // its numbers are honest (it never sees the sample it is scored on).
  const ratio = new TokenRatio()
  for (let index = 1; index < steps.length; index++) {
    const added = steps[index].messagesSoFar - steps[index - 1].messagesSoFar
    if (added !== 2) continue
    const previous = steps[index - 1].total
    const delta = steps[index].total - previous
    const assistantText = messages[steps[index].messagesSoFar - 2]?.text ?? ''
    const userText = messages[steps[index].messagesSoFar - 1]?.text ?? ''
    if (userText === '') continue
    const text = `${assistantText}${userText}`
    const official = tokenizer.count(text)
    rows.push({ delta, official, learned: ratio.estimate(text), estimate: estimate(text) })
    ratio.observe(text, official)
  }
  if (rows.length < 3) continue

  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
  const mae = key => mean(rows.map(row => Math.abs(row[key] - row.delta)))
  const signed = key => mean(rows.map(row => row[key] - row.delta))
  console.log(`\nsession ${candidate.session.slice(-8)} · ${rows.length} comparable steps`)
  console.log('  step   billedΔ   official   learned   estimate')
  rows.slice(0, 8).forEach((row, index) => {
    console.log(`  ${String(index + 1).padStart(4)} ${String(row.delta).padStart(9)}`
      + ` ${String(row.official).padStart(10)} ${String(row.learned).padStart(9)} ${String(row.estimate).padStart(10)}`)
  })
  console.log(`  MAE: official ${mae('official').toFixed(1)} · learned ${mae('learned').toFixed(1)} · estimate ${mae('estimate').toFixed(1)}`)
  console.log(`  signed: official ${signed('official').toFixed(1)} · learned ${signed('learned').toFixed(1)} · estimate ${signed('estimate').toFixed(1)}`)
  const { wide, narrow } = ratio.coefficients()
  console.log(`  learned ratio: ${wide.toFixed(3)} tok/wide-char, ${narrow.toFixed(3)} tok/narrow-char, ${ratio.observations} samples`)
}
