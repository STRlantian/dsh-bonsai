/**
 * Lossless-ish prompt compression: remove what carries no content, and nothing else.
 *
 * Three rules, each chosen because it cannot change what a sentence means:
 *
 * 1. Layout noise: trailing spaces, runs of blank lines, decorative rules.
 * 2. Filler at the edge of a sentence: leading "其实 / 那么 / 也就是说", trailing "呢 / 吧 / 啊".
 * 3. Never touch code, commands, diffs, paths, numbers or negations.
 *
 * Deliberately *not* done: dropping content words, dropping punctuation inside prose, random token
 * dropping. Chinese function characters like 的/是/不 carry meaning or change it when removed, and a
 * token dropped at random is a number or a `-` 4% of the time.
 */

/** A part of the text, marked when it must be passed through untouched. */
interface Segment {
  code: boolean
  text: string
}

/** Characters that may end a Chinese sentence. */
const SENTENCE_END = '。！？；…'

/** Filler words that add no information at the start of a sentence. */
const LEAD_FILLERS = ['其实', '那么', '然后', '也就是说', '总的来说', '简单来说', '总之', '不过']

/** Sentence-final particles that add tone, not content. */
const TAIL_PARTICLES = ['呢', '吧', '啊', '嘛', '啦', '呀', '哦', '噢']

/** Negations: removing one flips the meaning, so they are never treated as filler. */
const NEGATIONS = ['不', '没', '无', '勿', '未', '非', '别', '莫']

/**
 * Whether a line is code, command output, a diff or a path list.
 *
 * These lines are copied byte for byte: a dropped character in `client.js` or in a `git diff` hunk
 * is a wrong instruction, not a shorter one.
 * @param line - one line of text.
 * @returns True when the line must not be rewritten.
 */
function protectedLine(line: string): boolean {
  if (/^\s{4,}\S/.test(line)) return true
  if (/^\s*[$>]\s/.test(line)) return true
  if (/^\s*(PS [A-Z]:|C:\\|D:\\|\/[\w.-]+\/)/.test(line)) return true
  if (/^\s*(\+\+\+|---|\+|-|@@)\s/.test(line)) return true
  if (/^\s*[|[├└│]/.test(line)) return true
  if (/^\s*```/.test(line)) return true
  // A line that is mostly ASCII punctuation or symbols is a table, a path or a command.
  const symbols = (line.match(/[{}()[\];:,./\\|=<>+*$#@%^~`"']/g) ?? []).length
  if (line.length > 0 && symbols / line.length > 0.3) return true
  return false
}

/**
 * Split the text into prose and code, so each can be treated differently.
 * @param text - the whole text.
 * @returns Segments in order; fenced blocks and protected lines are marked as code.
 */
function segmentsOf(text: string): Segment[] {
  const segments: Segment[] = []
  let buffer: string[] = []
  let inFence = false
  const flush = (code: boolean): void => {
    if (buffer.length === 0) return
    segments.push({ code, text: buffer.join('\n') })
    buffer = []
  }
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      flush(inFence)
      inFence = !inFence
      segments.push({ code: true, text: line })
      continue
    }
    if (inFence || protectedLine(line)) {
      flush(false)
      segments.push({ code: true, text: line })
      continue
    }
    buffer.push(line)
  }
  flush(inFence)
  return segments
}

/**
 * Trim filler from one prose paragraph.
 * @param text - prose without code.
 * @param removed - accumulator for the characters taken out.
 * @returns The paragraph with edge filler removed.
 */
function trimFillers(text: string, removed: { count: number }): string {
  let out = text
  // Leading filler: only at the start of a sentence, and only when a negation is not involved.
  for (const filler of LEAD_FILLERS) {
    const pattern = new RegExp(`(^|[。！？；\\n])\\s*${filler}[，,\\s]*`, 'g')
    out = out.replace(pattern, (_match, before: string) => {
      removed.count += filler.length
      return before
    })
  }
  // Trailing particle right before a sentence end, never after a negation.
  for (const particle of TAIL_PARTICLES) {
    const pattern = new RegExp(`([^${NEGATIONS.join('')}])\\s*${particle}(?=[。！？；\\n]|$)`, 'g')
    out = out.replace(pattern, (_match, before: string) => {
      removed.count += particle.length
      return before
    })
  }
  return out
}

/**
 * Compress text for a prompt without changing its meaning.
 *
 * @param text - markdown-ish text from a node, a file or a tool result.
 * @returns The compressed text, the characters removed, and whether anything changed.
 */
export function compressForPrompt(text: string): { text: string; removed: number } {
  if (text.length === 0) return { text, removed: 0 }
  const removed = { count: 0 }
  const parts: string[] = []
  for (const segment of segmentsOf(text)) {
    if (segment.code) {
      parts.push(segment.text)
      continue
    }
    let body = segment.text
    // Layout: trailing spaces, runs of blank lines, decorative rules.
    const beforeLayout = body.length
    body = body.replace(/[ \t]+$/gm, '')
    body = body.replace(/\n{3,}/g, '\n\n')
    body = body.replace(/^[ \t]*([-=*_~#])\1{3,}[ \t]*$/gm, '')
    removed.count += beforeLayout - body.length
    body = trimFillers(body, removed)
    parts.push(body)
  }
  return { text: parts.join('\n'), removed: removed.count }
}
