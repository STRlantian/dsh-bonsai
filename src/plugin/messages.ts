/**
 * Message plumbing between the tree and the harness.
 *
 * Two rules shape this module. First, context the plugin injects is model-visible
 * and therefore must be reconstructable from the session log — which it is,
 * because the loop appends every admitted injected message as `user/message`.
 * Second, the plugin must never mistake its own injection for a fresh learner
 * question, so every injected message carries the producer kind
 * {@link INJECTED_SOURCE_KIND} and ingestion skips messages carrying it.
 *
 * @module dsh-token-tree/plugin/messages
 */

import type { ContentBlockLike, UserMessageLike } from './dsh.ts'

/** Producer kind stamped on every message this plugin injects. */
export const INJECTED_SOURCE_KIND = 'token-tree'

/** Per-process counter keeping injected message ids unique. */
let messageCounter = 0

/**
 * Read the text of a message's content blocks.
 * @param content - message content, of unknown shape.
 * @returns Concatenated text blocks, trimmed.
 */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n').trim()
}

/**
 * Build the message this plugin injects.
 * @param text - block text; callers keep it short.
 * @returns A user-role message tagged with this plugin's producer kind.
 */
export function buildInjectedMessage(text: string): UserMessageLike {
  messageCounter++
  const content: ContentBlockLike[] = [{ type: 'text', text }]
  return {
    id: `tokentree-${Date.now().toString(36)}-${messageCounter}`,
    role: 'user',
    content,
    source: { kind: INJECTED_SOURCE_KIND, plugin: 'dsh-token-tree' },
  }
}

/**
 * Whether a message was produced by this plugin.
 * @param message - candidate message.
 * @returns `true` when the producer kind matches.
 */
export function isInjected(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const source = (message as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return false
  return (source as { kind?: unknown }).kind === INJECTED_SOURCE_KIND
}

/**
 * Read a message-like value out of a session event payload.
 * @param value - candidate payload field.
 * @returns The message record, or `undefined`.
 */
export function asMessage(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  return typeof record.role === 'string' ? record : undefined
}

/**
 * Render the supervisor's guidance as a model-facing block.
 * @param reasons - evaluation reasons.
 * @param guidance - what the agent should do next.
 * @returns Block text under the plugin's marker prefix.
 */
export function supervisorMessage(reasons: readonly string[], guidance: string): string {
  const cause = reasons.length === 0 ? 'the turn stopped making progress' : reasons.join('; ')
  return `[token-tree supervisor] ${cause}.\n${guidance}\n`
    + 'Use the tree tools (`tree_query`, `tree_backtrack`, `tree_reflect`) instead of repeating the failed call.'
}
