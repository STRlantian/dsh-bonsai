/**
 * Range selection for history folding.
 *
 * A fold hides old `tool/result` messages from the model by appending a replacement event
 * with a `surfaceOp: replace` intent. The log stays append-only and the originals remain
 * replayable; only what the model sees changes.
 *
 * Deliberately conservative: tool results only (their structure is easy to preserve: same
 * turn, step and callId, new `content`), the system-prompt head is never touched, and the
 * most recent turns are kept verbatim.
 *
 * @module dsh-token-tree/plugin/fold
 */

/** One replacement to append. */
export interface FoldReplacement {
  /** Event being shadowed. */
  seq: number
  /** Event type of that entry (always `tool/result` today). */
  type: string
  /** Original payload with only `message.content` swapped for the placeholder. */
  data: Record<string, unknown>
}

/** Minimal shape of an event the planner reads. */
export interface FoldEvent {
  type: string
  seq: number
  data?: Record<string, unknown>
}

/**
 * Placeholder text for a folded tool result.
 * @param toolName - tool that produced it.
 * @returns One line telling the model where the original went.
 */
export function foldPlaceholder(toolName: string): string {
  return `[已折叠] ${toolName} 的完整输出已从上下文移除以节省 token；原文保存在对话树中，需要细节时调用 retrieve_context 取回。`
}

/**
 * Choose which tool results to fold.
 *
 * @param events - durable events in log order.
 * @param visible - seqs currently visible to the model; defaults to every event.
 * @param keepTurns - most recent turns to leave alone.
 * @returns Replacements to append, oldest first. Empty when there is nothing safe to fold.
 */
export function planFold(events: readonly FoldEvent[], visible: readonly number[], keepTurns: number): FoldReplacement[] {
  const seen = new Set(visible)
  const tools = events.filter(event => event.type === 'tool/result' && seen.has(event.seq))
  if (tools.length === 0) return []

  // Turn boundaries: a tool result belongs to the turn recorded in its payload.
  const turnOf = (event: FoldEvent): number => {
    const data = event.data ?? {}
    const direct = typeof data.turn === 'number' ? data.turn : undefined
    if (direct !== undefined) return direct
    const message = data.message as { turn?: unknown } | undefined
    return typeof message?.turn === 'number' ? message.turn : 0
  }
  const turns = [...new Set(tools.map(turnOf))].sort((left, right) => left - right)
  const keep = new Set(keepTurns <= 0 ? [] : turns.slice(-keepTurns))
  const older = tools.filter(event => !keep.has(turnOf(event)))

  return older.map(event => {
    const data = { ...(event.data ?? {}) }
    const message = { ...((data.message as Record<string, unknown> | undefined) ?? {}) }
    const toolName = typeof message.toolCallId === 'string' ? String((data.toolName as string | undefined) ?? 'tool') : 'tool'
    message.content = [{ type: 'text', text: foldPlaceholder(toolName) }]
    data.message = message
    return { seq: event.seq, type: event.type, data }
  })
}
