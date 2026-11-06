/**
 * Recognition of the placement/summary markers the prompt asks the model to append.
 *
 * The markers are instructions to the plugin, not part of the answer or the question. They must
 * only be recognized at the **end** of a text block, and only when they stand on their own line:
 * an answer that explains the syntax (`use [attach:n4] to ...`) must keep its example intact.
 * Markers inside fenced code blocks are examples too and are left alone.
 *
 * @module dsh-token-tree/plugin/markers
 */

/** A placement marker at the end of one line. */
const ATTACH_LINE = /^[ \t]*\[attach:(n\d+|root|here)\]\s*$/
/** A summary marker at the end of one line; summaries are capped by the prompt. */
const SUMMARY_LINE = /^[ \t]*\[summary:([^\]\n]{0,120})\]\s*$/

/** What one trailing-marker scan found. */
export interface TrailingMarkers {
  /** Text with the trailing marker lines removed. */
  text: string
  /** Placement target, when the last lines carried one. */
  attach?: string
  /** Aspect summary, when the last lines carried one. */
  summary?: string
}

/**
 * Whether a line is inside a fenced code block, according to the fences above it.
 *
 * The scan is deliberately simple: only triple-backtick fences toggle, which is what the prompt's
 * examples and ordinary answers use. An unclosed fence is treated as code through the end, so a
 * marker line after an unclosed fence is not eaten.
 * @param lines - all lines of the text.
 * @param index - line to classify.
 * @returns True when the line is part of a fenced block.
 */
function insideFence(lines: readonly string[], index: number): boolean {
  let fenced = false
  for (let cursor = 0; cursor < index; cursor++) {
    if (/^\s*```/.test(lines[cursor])) fenced = !fenced
  }
  return fenced
}

/**
 * Remove the markers that the prompt asks for, but only from the end of one text block.
 *
 * The parser walks upward from the last non-empty line, accepting only whole marker lines that are
 * not inside a fence. The first non-marker line stops the scan, so quoted examples in the middle of
 * an answer are never touched. Internal whitespace and code blocks are preserved.
 * @param text - assistant or user text.
 * @returns Cleaned text and any markers found.
 */
export function readTrailingMarkers(text: string): TrailingMarkers {
  if (text.length === 0) return { text }
  const lines = text.split('\n')
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end--
  let attach: string | undefined
  let summary: string | undefined
  let removed = false
  while (end > 0) {
    if (insideFence(lines, end - 1)) break
    const line = lines[end - 1]
    const wholeAttach = ATTACH_LINE.exec(line)
    if (wholeAttach !== null) {
      attach ??= wholeAttach[1]
      removed = true
      end--
      continue
    }
    const wholeSummary = SUMMARY_LINE.exec(line)
    if (wholeSummary !== null) {
      summary ??= wholeSummary[1].trim().slice(0, 120)
      removed = true
      end--
      continue
    }
    // The prompt says "on its own line", but models often put the marker at the end of the same
    // line as the answer. Accept only a marker suffix here, never an inline mention.
    const suffixAttach = /^(.*?)\s*\[attach:(n\d+|root|here)\]\s*$/.exec(line)
    if (suffixAttach !== null) {
      attach ??= suffixAttach[2]
      removed = true
      const prefix = suffixAttach[1].replace(/\s+$/, '')
      if (prefix.trim() === '') end--
      else lines[end - 1] = prefix
      continue
    }
    const suffixSummary = /^(.*?)\s*\[summary:([^\]\n]{0,120})\]\s*$/.exec(line)
    if (suffixSummary !== null) {
      summary ??= suffixSummary[2].trim().slice(0, 120)
      removed = true
      const prefix = suffixSummary[1].replace(/\s+$/, '')
      if (prefix.trim() === '') end--
      else lines[end - 1] = prefix
      continue
    }
    break
  }
  if (!removed) return { text }
  while (end > 0 && lines[end - 1].trim() === '') end--
  return {
    text: lines.slice(0, end).join('\n'),
    ...(attach === undefined ? {} : { attach }),
    ...(summary === undefined ? {} : { summary }),
  }
}
