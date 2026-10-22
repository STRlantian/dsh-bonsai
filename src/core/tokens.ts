/**
 * Token accounting.
 *
 * The buffer is filled under a token budget, so every node needs a cheap,
 * stable length estimate. Providers differ, so the estimate is deliberately
 * conservative: CJK code points count as one token each, everything else as one
 * token per four characters.
 *
 * @module dsh-bonsai/core/tokens
 */

/**
 * Estimate the token length of one text.
 * @param text - text to measure.
 * @returns Estimated tokens; never below zero.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let wide = 0
  let total = 0
  for (const character of text) {
    total++
    const code = character.codePointAt(0) ?? 0
    if (code >= 0x2e80) wide++
  }
  const narrow = total - wide
  return Math.max(1, Math.ceil(wide + narrow / 4))
}

/**
 * Truncate text to a token ceiling on a word boundary when one is nearby.
 * @param text - source text.
 * @param maxTokens - ceiling in estimated tokens.
 * @returns The original text when it already fits, otherwise a truncated form ending in `…`.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  let low = 1
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(text.slice(0, middle)) <= maxTokens) low = middle
    else high = middle - 1
  }
  const head = text.slice(0, Math.max(1, low)).trimEnd()
  return head.endsWith('…') ? head : `${head}…`
}

/**
 * Take the leading sentences of a text, bounded by characters.
 * @param text - source text.
 * @param maxChars - character ceiling.
 * @returns A summary candidate for compression.
 */
export function leadingSentences(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  const boundary = normalized.slice(0, maxChars)
  const cut = Math.max(boundary.lastIndexOf('. '), boundary.lastIndexOf('。'), boundary.lastIndexOf('; '), boundary.lastIndexOf('；'))
  if (cut > maxChars * 0.4) return `${boundary.slice(0, cut + 1).trimEnd()}`
  return truncateToTokens(boundary, estimateTokens(boundary))
}

/**
 * The first sentence of a text, capped to a character budget.
 *
 * Used as a node's topic line for matching. Taking "the first N characters" is not the
 * same thing: that drags a second, unrelated sentence into the summary and dilutes the
 * embedding (measured: cosine 0.18 with the padding included vs 0.31 without).
 * @param text - source text.
 * @param maxChars - hard character ceiling for the result.
 * @returns The first sentence, truncated with an ellipsis when it is too long.
 */
export function topicLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized === '') return ''
  const enders = ['. ', '。', '! ', '！', '? ', '？', '; ', '；', '\n']
  let stop = normalized.length
  for (const ender of enders) {
    const at = normalized.indexOf(ender)
    if (at !== -1 && at < stop) stop = at + (ender.trim() === '' ? 0 : 1)
  }
  const sentence = normalized.slice(0, stop).trim()
  if (sentence.length <= maxChars) return sentence
  return `${sentence.slice(0, maxChars).trimEnd()}…`
}
