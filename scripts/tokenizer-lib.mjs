#!/usr/bin/env node
/**
 * A small, dependency-free reader for a HuggingFace `tokenizer.json` (byte-level BPE).
 *
 * Why this exists: the plugin has to decide "is this conversation big enough that
 * retrieval is worth a round trip", and the only honest input to that decision is the
 * real token count of the messages, not a characters/2.5 estimate. The harness ships no
 * tokenizer, the bundled Python has no `transformers`, so the tokenizer file the user
 * supplied is parsed here directly.
 *
 * Scope: the subset of the format this tokenizer uses — a Sequence of regex Splits, a
 * ByteLevel step, byte-level BPE merges, and special added tokens. It is a counter, not
 * a full encoder: it never needs to produce ids in the right order for a model call.
 *
 * @module tokenizer-lib
 */
import { readFileSync } from 'node:fs'

/** GPT-2 style byte ↔ printable-unicode table (the ByteLevel alphabet). */
const BYTE_TO_CHAR = (() => {
  const direct = []
  for (let code = 0; code < 256; code++) direct.push(code)
  const visible = []
  for (let code = 33; code <= 126; code++) visible.push(code)
  for (let code = 161; code <= 172; code++) visible.push(code)
  for (let code = 174; code <= 255; code++) visible.push(code)
  const isVisible = new Set(visible)
  let extra = 0
  const table = new Array(256)
  for (const code of direct) {
    if (isVisible.has(code)) table[code] = String.fromCharCode(code)
    else {
      table[code] = String.fromCharCode(256 + extra)
      extra++
    }
  }
  return table
})()

/**
 * Convert a UTF-8 string to its byte-level alphabet form.
 * @param text - source text.
 * @returns The string with each byte mapped to its printable stand-in.
 */
export function bytesToUnicode(text) {
  const bytes = Buffer.from(text, 'utf8')
  let out = ''
  for (const byte of bytes) out += BYTE_TO_CHAR[byte]
  return out
}

/**
 * Convert a byte-level alphabet string back to UTF-8 text.
 * @param text - byte-level form.
 * @returns Decoded text.
 */
export function unicodeToBytes(text) {
  const inverse = new Map()
  for (let code = 0; code < 256; code++) inverse.set(BYTE_TO_CHAR[code], code)
  const bytes = []
  for (const char of text) {
    const byte = inverse.get(char)
    if (byte === undefined) return undefined
    bytes.push(byte)
  }
  return Buffer.from(bytes).toString('utf8')
}

/** One `Split` step of the pre-tokenizer. */
function splitStep(pattern, behavior) {
  const regex = new RegExp(pattern, 'gu')
  return text => {
    const pieces = []
    let cursor = 0
    regex.lastIndex = 0
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      if (match[0] === '') { regex.lastIndex++; continue }
      if (match.index > cursor) pieces.push(text.slice(cursor, match.index))
      if (behavior === 'Isolated') pieces.push(match[0])
      cursor = match.index + match[0].length
    }
    if (cursor < text.length) pieces.push(text.slice(cursor))
    return pieces.filter(piece => piece.length > 0)
  }
}

/**
 * Load and compile a tokenizer.
 * @param path - path to `tokenizer.json`.
 * @returns `{ count(text), tokens(text) }`.
 */
export function loadTokenizer(path) {
  const spec = JSON.parse(readFileSync(path, 'utf8'))
  if (spec.model?.type !== 'BPE') throw new Error(`unsupported tokenizer model: ${spec.model?.type}`)

  const vocab = new Map(Object.entries(spec.model.vocab).map(([piece, id]) => [piece, Number(id)]))
  const ranks = new Map()
  spec.model.merges.forEach((merge, index) => ranks.set(merge, index))

  const specials = (spec.added_tokens ?? [])
    .filter(entry => entry.special === true)
    .map(entry => entry.content)
    .sort((left, right) => right.length - left.length)

  const steps = []
  for (const step of spec.pre_tokenizer?.pretokenizers ?? []) {
    if (step.type === 'Split') steps.push(splitStep(step.pattern.Regex, step.behavior))
    else if (step.type === 'ByteLevel') steps.push(text => [bytesToUnicode(text)])
    else throw new Error(`unsupported pre-tokenizer step: ${step.type}`)
  }

  /** Merge one pre-token into BPE symbols. */
  const bpe = pretoken => {
    let symbols = [...pretoken]
    if (symbols.length === 0) return []
    for (;;) {
      let bestRank = Infinity
      let bestAt = -1
      for (let index = 0; index + 1 < symbols.length; index++) {
        const rank = ranks.get(`${symbols[index]} ${symbols[index + 1]}`)
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank
          bestAt = index
        }
      }
      if (bestAt === -1) break
      symbols = [
        ...symbols.slice(0, bestAt),
        symbols[bestAt] + symbols[bestAt + 1],
        ...symbols.slice(bestAt + 2),
      ]
    }
    return symbols
  }

  /** Split on special tokens first, as HF does. */
  const splitSpecials = text => {
    if (specials.length === 0) return [{ text, special: false }]
    const out = []
    let index = 0
    while (index < text.length) {
      let hit = null
      for (const token of specials) {
        if (text.startsWith(token, index)) { hit = token; break }
      }
      if (hit !== null) {
        out.push({ text: hit, special: true })
        index += hit.length
        continue
      }
      let next = text.length
      for (const token of specials) {
        const at = text.indexOf(token, index)
        if (at !== -1 && at < next) next = at
      }
      out.push({ text: text.slice(index, next), special: false })
      index = next
    }
    return out
  }

  /**
   * Token pieces for one text.
   * @param text - source text.
   * @returns Array of BPE pieces (one per token).
   */
  const tokens = text => {
    const pieces = []
    for (const chunk of splitSpecials(text)) {
      if (chunk.special) { pieces.push(chunk.text); continue }
      let segments = [chunk.text]
      for (const step of steps) {
        const next = []
        for (const segment of segments) next.push(...step(segment))
        segments = next
      }
      for (const segment of segments) pieces.push(...bpe(segment))
    }
    return pieces
  }

  return {
    /** Number of tokens (excluding any BOS/EOS the model would add). */
    count: text => tokens(text).length,
    tokens,
    /** Whether every produced piece is in the vocabulary — a correctness self-check. */
    unknownPieces: text => tokens(text).filter(piece => !vocab.has(piece)),
  }
}

// CLI: count text from the command line or stdin, for spot checks.
if (process.argv[1]?.endsWith('tokenizer-lib.mjs') === true || process.argv[1]?.endsWith('tokenizer-lib.js') === true) {
  const path = process.argv[2] ?? 'D:/dsh-token-tree/.tokenizer_tmp/deepseek_v4_tokenizer/tokenizer.json'
  const text = process.argv[3] ?? ''
  const tokenizer = loadTokenizer(path)
  if (text === '') {
    console.log('usage: node scripts/tokenizer-lib.mjs <tokenizer.json> "text"')
  } else {
    const pieces = tokenizer.tokens(text)
    console.log(JSON.stringify({ count: pieces.length, unknown: tokenizer.unknownPieces(text).slice(0, 5), pieces: pieces.slice(0, 20) }))
  }
}
