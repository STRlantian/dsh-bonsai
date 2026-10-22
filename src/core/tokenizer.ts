/**
 * The real tokenizer, when the user supplies one.
 *
 * Every budget decision in this plugin was until now based on a characters-per-token
 * estimate. That estimate is fine for ranking nodes against each other, but it is the
 * wrong instrument for the one decision that costs money: "is this conversation big
 * enough that injecting memory is worth a round trip?" A Chinese sentence measured
 * 1.65 characters per token, English prose 5.83 — one constant cannot serve both.
 *
 * The file the user supplied is a HuggingFace `tokenizer.json` (byte-level BPE). This
 * module reads that format directly: no native dependency, no Python, no network.
 * It is a counter, not an encoder — nothing here needs to feed ids to a model.
 *
 * @module dsh-bonsai/core/tokenizer
 */
import { readFileSync } from 'node:fs'

/** GPT-2 style byte ↔ printable-unicode alphabet used by byte-level BPE. */
const BYTE_TO_CHAR: string[] = (() => {
  const visible = new Set<number>()
  for (let code = 33; code <= 126; code++) visible.add(code)
  for (let code = 161; code <= 172; code++) visible.add(code)
  for (let code = 174; code <= 255; code++) visible.add(code)
  const table: string[] = new Array(256)
  let extra = 0
  for (let code = 0; code < 256; code++) {
    if (visible.has(code)) table[code] = String.fromCharCode(code)
    else {
      table[code] = String.fromCharCode(256 + extra)
      extra++
    }
  }
  return table
})()

/**
 * Map UTF-8 text to the byte-level alphabet.
 * @param text - source text.
 * @returns One character per byte.
 */
function toByteAlphabet(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  let out = ''
  for (const byte of bytes) out += BYTE_TO_CHAR[byte]
  return out
}

/** One `Split` step of a pre-tokenizer. */
function splitStep(pattern: string, behavior: string): (text: string) => string[] {
  const regex = new RegExp(pattern, 'gu')
  return (text: string): string[] => {
    const pieces: string[] = []
    let cursor = 0
    regex.lastIndex = 0
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      if (match[0] === '') {
        regex.lastIndex++
        continue
      }
      if (match.index > cursor) pieces.push(text.slice(cursor, match.index))
      if (behavior === 'Isolated') pieces.push(match[0])
      cursor = match.index + match[0].length
    }
    if (cursor < text.length) pieces.push(text.slice(cursor))
    return pieces.filter(piece => piece.length > 0)
  }
}

/** The shape of the `tokenizer.json` fields this module reads. */
interface TokenizerSpec {
  model: {
    type: string
    vocab: Record<string, number>
    merges: string[]
  }
  pre_tokenizer?: {
    pretokenizers?: { type: string; pattern?: { Regex?: string }; behavior?: string }[]
  }
  added_tokens?: { content: string; special?: boolean }[]
}

/** A loaded tokenizer. */
export interface Tokenize {
  /** Number of tokens in the text, excluding any BOS/EOS the model would add. */
  count(text: string): number
  /** Pieces produced for the text (mainly for tests and probes). */
  pieces(text: string): string[]
}

/**
 * Compile a tokenizer from a parsed `tokenizer.json`.
 * @param spec - parsed file contents.
 * @returns The counter.
 */
export function compileTokenizer(spec: TokenizerSpec): Tokenize {
  const vocab = new Set(Object.keys(spec.model.vocab))
  const ranks = new Map<string, number>()
  spec.model.merges.forEach((merge, index) => ranks.set(merge, index))

  const specials = (spec.added_tokens ?? [])
    .filter(entry => entry.special === true)
    .map(entry => entry.content)
    .sort((left, right) => right.length - left.length)

  const steps: ((text: string) => string[])[] = []
  for (const step of spec.pre_tokenizer?.pretokenizers ?? []) {
    if (step.type === 'Split' && step.pattern?.Regex !== undefined) {
      steps.push(splitStep(step.pattern.Regex, step.behavior ?? 'Isolated'))
    } else if (step.type === 'ByteLevel') {
      steps.push(text => [toByteAlphabet(text)])
    } else {
      throw new Error(`token-tree: unsupported pre-tokenizer step "${step.type}"`)
    }
  }

  /** Byte-pair merge one pre-token into symbols. */
  const merge = (pretoken: string): string[] => {
    let symbols = [...pretoken]
    while (symbols.length > 1) {
      let bestRank = Number.POSITIVE_INFINITY
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

  /** Split on special tokens first, exactly like the reference implementation. */
  const splitSpecials = (text: string): { text: string; special: boolean }[] => {
    if (specials.length === 0) return [{ text, special: false }]
    const out: { text: string; special: boolean }[] = []
    let index = 0
    while (index < text.length) {
      const hit = specials.find(token => text.startsWith(token, index))
      if (hit !== undefined) {
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

  const pieces = (text: string): string[] => {
    const out: string[] = []
    for (const chunk of splitSpecials(text)) {
      if (chunk.special) {
        out.push(chunk.text)
        continue
      }
      let segments = [chunk.text]
      for (const step of steps) {
        const next: string[] = []
        for (const segment of segments) next.push(...step(segment))
        segments = next
      }
      for (const segment of segments) out.push(...merge(segment))
    }
    return out
  }

  return {
    count: text => pieces(text).length,
    pieces,
    ...(vocab.size === 0 ? {} : {}),
  }
}

/**
 * Load a tokenizer file.
 * @param path - path to `tokenizer.json`.
 * @returns The counter.
 */
export function loadTokenizerFile(path: string): Tokenize {
  const spec = JSON.parse(readFileSync(path, 'utf8')) as TokenizerSpec
  if (spec.model?.type !== 'BPE') throw new Error(`token-tree: unsupported tokenizer model "${spec.model?.type}"`)
  return compileTokenizer(spec)
}
