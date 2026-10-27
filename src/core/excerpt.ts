/**
 * Representations for a node too long to inject whole.
 *
 * Code and numbers must never be paraphrased: a summary that drops a bracket or a constant is
 * worse than no summary, because it invites a confident wrong edit. So the long tier does not
 * summarise at all - it says what the node is about (a referent line) and points at the tree for
 * anything precise. The middle tier stays extractive: sentences copied verbatim, the relevant ones
 * first.
 */

/**
 * Split text into sentences, keeping code fences as single opaque units.
 *
 * Prose sentences end at a Chinese or English terminator; a fenced block is one unit so it can
 * never be cut in half by an excerpt.
 * @param text - the content to split.
 * @returns Units in order.
 */
export function sentencesOf(text: string): string[] {
  const out: string[] = []
  let fence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fence = !fence
      out.push(line)
      continue
    }
    if (fence) {
      out.push(line)
      continue
    }
    if (line.trim().length === 0) continue
    const parts = line.match(/[^。！？；?!]+[。！？；?!]?/g) ?? [line]
    for (const part of parts) {
      const trimmed = part.trim()
      if (trimmed.length > 0) out.push(trimmed)
    }
  }
  return out
}

/** Terms worth matching: words of two or more characters, plus CJK bigrams. */
function termsOf(query: string): string[] {
  const terms = new Set<string>()
  for (const word of query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
    if (word.length >= 2) terms.add(word)
  }
  const cjk = query.replace(/[^\u4e00-\u9fff]/g, '')
  for (let index = 0; index + 2 <= cjk.length; index++) terms.add(cjk.slice(index, index + 2))
  return [...terms]
}

/**
 * What a node is about, in one line - the part that says what "it" refers to.
 * @param text - node content.
 * @param maxChars - cap for the line.
 * @returns The first sentence, cut at a character boundary.
 */
export function referentLine(text: string, maxChars = 180): string {
  const first = sentencesOf(text).find(part => !/^\s*```/.test(part) && part.trim().length > 0) ?? text
  const normalized = first.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, maxChars).replace(/[，,、\s]+$/, '') + '…'
}

/**
 * Verbatim excerpt: the head, then the sentences that match the question.
 *
 * Sentences are copied, never rewritten. A fenced block is never cut: if it does not fit, it is
 * dropped whole rather than broken.
 * @param text - node content.
 * @param query - the question being answered.
 * @param budgetTokens - token budget for the excerpt.
 * @param countTokens - token counter.
 * @returns The excerpt plus how much of it is the head.
 */
export function excerptFor(
  text: string,
  query: string,
  budgetTokens: number,
  countTokens: (value: string) => number,
): string {
  // A fenced block is one unit: half a code block is a wrong instruction, and an unbalanced fence
  // breaks the markdown around it. Units are rebuilt here so a block can only appear whole.
  const units: string[] = []
  let fence: string[] = []
  let inFence = false
  for (const part of sentencesOf(text)) {
    if (/^\s*```/.test(part)) {
      fence.push(part)
      inFence = !inFence
      if (!inFence) { units.push(fence.join('\n')); fence = [] }
      continue
    }
    if (inFence) { fence.push(part); continue }
    units.push(part)
  }
  if (fence.length > 0) units.push(fence.join('\n'))
  // A source with an unclosed fence produces an odd unit; emitting it would break the markdown
  // around the excerpt, so it is dropped instead of half-closed.
  const sentences = units.filter(unit => ((unit.match(/```/g) ?? []).length % 2) === 0)
  const terms = termsOf(query)
  const head: string[] = []
  let used = 0
  const headBudget = Math.max(120, Math.floor(budgetTokens * 0.4))
  for (const sentence of sentences) {
    const tokens = countTokens(sentence)
    if (used + tokens > headBudget) break
    head.push(sentence)
    used += tokens
  }
  const picked: string[] = []
  for (const sentence of sentences) {
    if (head.includes(sentence)) continue
    const lower = sentence.toLowerCase()
    let hits = 0
    for (const term of terms) if (lower.includes(term)) hits++
    if (hits === 0) continue
    const tokens = countTokens(sentence)
    if (used + tokens > budgetTokens) continue
    picked.push(sentence)
    used += tokens
  }
  return [...head, ...picked].join('\n')
}

/** A line telling the model the text was reduced and where the original is. */
export function reductionNote(path: string, lines: number, kept: 'excerpt' | 'referent'): string {
  const what = kept === 'excerpt' ? '节选（逐字，非摘要）' : '仅标识'
  return `[${path}：${what}，原文 ${lines} 行在树里；代码、数字、原文措辞以树中为准，需要时用 retrieve_context 取回]`
}
