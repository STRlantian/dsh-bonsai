#!/usr/bin/env node
/**
 * Remove the placement/summary markers from answers already stored in a session log.
 *
 * The prompt asks the model to end its answer with `[attach:…]` / `[summary: …]` so the plugin can
 * place the next question; the plugin now rewrites the answer on the fly, but transcripts written
 * before that fix still show the markers. This edits the assistant message text inside its own frame
 * (frames are the log's commit units, so they are never merged or reordered) and keeps a backup.
 *
 * Dry run by default; `--write` rewrites; `--session <id>` limits the run.
 *
 * Usage: node scripts/clean-marker-text.mjs [--session <id>] [--write]
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
const write = args.includes('--write')
const root = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions')
const ATTACH = /\[attach:(n\d+|root|here)\]/g
const SUMMARY = /\[summary:[^\]]{0,120}\]/g

/** Strip both markers and the blank lines they leave behind. */
function clean(text) {
  return text.replace(ATTACH, '').replace(SUMMARY, '').replace(/\n{3,}/g, '\n\n').trim()
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
