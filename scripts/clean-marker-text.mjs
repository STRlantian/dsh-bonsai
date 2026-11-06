#!/usr/bin/env node
/**
 * Remove the placement/summary markers from answers already stored in a session log.
 *
 * The prompt asks the model to end its answer with `[attach:…]` / `[summary: …]` so the plugin can
 * place the next question; the plugin now rewrites the answer on the fly, but transcripts written
 * before that fix still show the markers. This edits the assistant message text inside its own frame
 * (frames are the log's commit units, so they are never merged or reordered) and keeps a backup.
 *
 * Dry run by default; `--write` rewrites; `--session <id>` limits the run; `--skip <id>` excludes one
 * (the session the running host is appending to must not be rewritten under it).
 *
 * Usage: node scripts/clean-marker-text.mjs --session <id> [--write] [--skip <id>] [--all]
 */
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const only = argOf('session', undefined)
const skip = argOf('skip', undefined)
const write = args.includes('--write')
const all = args.includes('--all')
if (only === undefined && !all) {
  console.log('refusing to scan every session by default; pass --session <id> (or --all explicitly)')
  process.exit(1)
}
const root = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
const ATTACH_LINE = /^[ \t]*\[attach:(n\d+|root|here)\]\s*$/
const SUMMARY_LINE = /^[ \t]*\[summary:([^\]\n]{0,120})\]\s*$/

/** Whether a line is inside a fenced code block above it. */
function insideFence(lines, index) {
  let fenced = false
  for (let cursor = 0; cursor < index; cursor++) {
    if (/^\s*```/.test(lines[cursor])) fenced = !fenced
  }
  return fenced
}

/** Remove only markers at the very end of one text block, outside code fences. */
function clean(text) {
  if (text.length === 0) return text
  const lines = text.split('\n')
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end--
  let removed = false
  while (end > 0) {
    if (insideFence(lines, end - 1)) break
    const line = lines[end - 1]
    if (ATTACH_LINE.test(line) || SUMMARY_LINE.test(line)) {
      removed = true
      end--
      continue
    }
    const suffixAttach = /^(.*?)\s*\[attach:(n\d+|root|here)\]\s*$/.exec(line)
    if (suffixAttach !== null) {
      removed = true
      const prefix = suffixAttach[1].replace(/\s+$/, '')
      if (prefix.trim() === '') end--
      else lines[end - 1] = prefix
      continue
    }
    const suffixSummary = /^(.*?)\s*\[summary:([^\]\n]{0,120})\]\s*$/.exec(line)
    if (suffixSummary !== null) {
      removed = true
      const prefix = suffixSummary[1].replace(/\s+$/, '')
      if (prefix.trim() === '') end--
      else lines[end - 1] = prefix
      continue
    }
    break
  }
  if (!removed) return text
  while (end > 0 && lines[end - 1].trim() === '') end--
  return lines.slice(0, end).join('\n')
}

/** Rewrite the answer text inside one parsed line, or return undefined when nothing changes. */
function cleanLine(line) {
  if (!line.includes('assistant/message')) return undefined
  if (!/\[attach:(n\d+|root|here)\]|\[summary:/.test(line)) return undefined
  let record
  try { record = JSON.parse(line) } catch { return undefined }
  const event = record.event ?? record
  const message = event?.data?.message
  if (!Array.isArray(message?.content)) return undefined
  let changed = false
  const content = message.content.map(part => {
    if (part?.type !== 'text' || typeof part.text !== 'string') return part
    const cleaned = clean(part.text)
    if (cleaned === part.text) return part
    changed = true
    return { ...part, text: cleaned }
  })
  if (!changed) return undefined
  const nextEvent = { ...event, data: { ...event.data, message: { ...message, content } } }
  const nextRecord = record.event === undefined ? nextEvent : { ...record, event: nextEvent }
  return JSON.stringify(nextRecord)
}

/** Walk the frames; rebuild only the ones whose text changed. */
function cleanFile(file) {
  const buffer = readFileSync(file)
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xb5 && buffer[index + 2] === 0x2f && buffer[index + 3] === 0xfd) starts.push(index)
  }
  const frames = []
  let changed = 0
  for (let index = 0; index < starts.length; index++) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    const bytes = buffer.subarray(starts[index], end)
    let text = ''
    try { text = zstdDecompressSync(bytes).toString('utf8') } catch {}
    const lines = text.split('\n')
    let touched = false
    const next = lines.map(line => {
      const cleaned = cleanLine(line)
      if (cleaned === undefined) return line
      touched = true
      return cleaned
    })
    if (touched) { changed++; frames.push(zstdCompressSync(Buffer.from(next.join('\n'), 'utf8'))) }
    else frames.push(bytes)
  }
  return { frames, changed }
}

const results = []
for (const project of readdirSync(root, { withFileTypes: true })) {
  if (!project.isDirectory()) continue
  for (const name of readdirSync(join(root, project.name))) {
    if (only !== undefined && !name.includes(only)) continue
    if (skip !== undefined && name.includes(skip)) continue
    const file = join(root, project.name, name, 'session.v4.jsonl.zstd')
    let outcome
    try { outcome = cleanFile(file) } catch { continue }
    if (outcome.changed === 0) continue
    results.push({ file, name: name.replace(/^session-/, '').slice(0, 8), changed: outcome.changed, frames: outcome.frames })
  }
}

if (results.length === 0) {
  console.log('没有需要清理的会话')
  process.exit(0)
}
console.log(`需要清理的会话: ${results.length}（${write ? '写入' : '试运行，加 --write 才写'}）`)
for (const result of results) {
  console.log(`  ${result.name} · 改写的帧 ${result.changed}`)
  if (!write) continue
  const backup = `${result.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(result.file, backup)
  writeFileSync(result.file, Buffer.concat(result.frames))
  console.log(`     → 已写入（备份 ${backup.slice(backup.lastIndexOf('\\') + 1)}）`)
}
