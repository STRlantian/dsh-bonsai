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

/** Outcome of folding a whole turn: a range plus the placeholder that replaces it. */
export interface TurnFold {
  /** First visible seq of the turn. */
  startSeq: number
  /** Last visible seq of the turn. */
  endSeq: number
  /** Turns covered (always 1 today; kept for the placeholder text). */
  turns: number
  /** Every visible seq the replacement shadows, as the host requires. */
  seqs: number[]
  /** Payload for the appended `user/message`. */
  data: Record<string, unknown>
}

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

/** Event types that carry model-visible messages. */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message'])

/**
 * Placeholder that stands in for a folded turn.
 * @param turns - how many turns the placeholder covers.
 * @returns One line telling the model where the originals are.
 */
export function turnPlaceholder(turns: number): string {
  return `[已折叠] 之前的 ${turns} 轮对话已从上下文移除以节省 token；原文完整保存在对话树中，需要细节时调用 retrieve_context 取回，不要凭印象编造。`
}

/**
 * Choose whole turns to fold.
 *
 * Each turn's visible range is replaced by a single placeholder, so an assistant tool call and
 * its result always disappear together. Only turns entirely older than the keep window are
 * taken, and the prompt head (system messages before the first user message) is never touched.
 *
 * @param events - durable events in log order.
 * @param visible - seqs currently visible to the model.
 * @param keepTurns - most recent turns to leave alone.
 * @returns One replacement per foldable turn, oldest first.
 */
export function planTurnFold(events: readonly FoldEvent[], visible: readonly number[], keepTurns: number): TurnFold[] {
  const indexOf = new Map<number, number>()
  visible.forEach((seq, index) => indexOf.set(seq, index))
  const byTurn = new Map<number, number[]>()
  let current = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = (event.data?.turn as number | undefined) ?? current + 1
      continue
    }
    if (!SURFACE_TYPES.has(event.type)) continue
    const index = indexOf.get(event.seq)
    if (index === undefined) continue
    const data = event.data ?? {}
    // A placeholder from an earlier fold is not a conversation turn.
    if ((data.source as { kind?: string } | undefined)?.kind === 'token-tree') continue
    const turn = typeof data.turn === 'number' ? data.turn : current
    if (turn <= 0) continue
    const list = byTurn.get(turn)
    if (list === undefined) byTurn.set(turn, [index])
    else list.push(index)
  }
  const turns = [...byTurn.keys()].sort((left, right) => left - right)
  if (turns.length === 0) return []
  const kept = new Set(keepTurns <= 0 ? [] : turns.slice(-keepTurns))
  // The first surface node belongs to the prompt head and may only be rewritten by a
  // system/message over exactly that node, so the opening turn is left alone.
  const earliest = turns[0]
  const chosen = turns.filter(turn => turn !== earliest && !kept.has(turn))
  if (chosen.length === 0) return []
  const folds: TurnFold[] = []
  for (const turn of chosen) {
    const indices = [...(byTurn.get(turn) as number[])].sort((left, right) => left - right)
    // A single span must be contiguous: interleaved turns cannot be replaced as one range.
    if (indices[indices.length - 1] - indices[0] + 1 !== indices.length) continue
    const seqs = indices.map(index => visible[index])
    folds.push({
      startSeq: seqs[0],
      endSeq: seqs[seqs.length - 1],
      turns: 1,
      seqs,
      data: {
        role: 'user',
        id: globalThis.crypto.randomUUID(),
        content: [{ type: 'text', text: turnPlaceholder(1) }],
        source: { kind: 'token-tree', id: 'fold' },
      },
    })
  }
  return folds
}