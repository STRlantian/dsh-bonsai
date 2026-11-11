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

/** Outcome of folding one contiguous run of turns: a range plus the placeholder that replaces it. */
export interface TurnFold {
  /** First visible seq of the run. */
  startSeq: number
  /** Last visible seq of the run. */
  endSeq: number
  /** Number of adjacent turns covered by this replacement. */
  turns: number
  /** First turn number in the run, for the size bookkeeping. */
  turn: number
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
 * One entry in the host's surface list.
 *
 * The host normally reports one seq per entry, but it may compress a run of adjacent
 * user/message nodes into an inclusive `[start, end]` range. The planner must expand those ranges
 * before it can cite or group individual nodes.
 */
export type SurfaceSeqLike = number | readonly [number, number]

/**
 * Expand one surface entry into individual sequence numbers.
 * @param entry - a seq, or an inclusive `[start, end]` range from the host.
 * @returns Every seq in the entry, in order; empty for a malformed range.
 */
export function expandSurfaceSeq(entry: SurfaceSeqLike): number[] {
  if (typeof entry === 'number') return Number.isSafeInteger(entry) ? [entry] : []
  const [start, end] = entry
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return []
  // A corrupt range must not allocate an unbounded array.
  if (end - start > 10_000) return []
  const seqs: number[] = []
  for (let seq = start; seq <= end; seq++) seqs.push(seq)
  return seqs
}

/**
 * Placeholder text for a folded tool result.
 * @param toolName - tool that produced it.
 * @returns One line telling the model where the original went.
 */
export function foldPlaceholder(toolName: string): string {
  return `[已折叠] ${toolName} 的完整输出已从上下文移除以节省 token；原文保存在对话树中，需要细节时先调用 retrieve_context 取候选索引，再用返回的 nodeId 取详情。`
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
export const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message'])

/**
 * Placeholder that stands in for a folded turn.
 * @param turns - how many turns the placeholder covers.
 * @returns One line telling the model where the originals are.
 */
/**
 * Tokens a fold would remove from the prompt.
 * @param folds - planned replacements.
 * @param turnTokens - measured tokens per turn.
 * @returns Summed block size in tokens.
 */
export function blockTokensOf(folds: readonly TurnFold[], turnTokens: ReadonlyMap<number, number>): number {
  let total = 0
  for (const fold of folds) {
    for (let turn = fold.turn; turn < fold.turn + fold.turns; turn++) total += turnTokens.get(turn) ?? 0
  }
  return total
}

/**
 * Tokens that stay in the prompt after a fold: the keep window, which is what a fold re-prices at
 * the miss price.
 * @param folds - planned replacements.
 * @param turnTokens - measured tokens per turn.
 * @returns Summed size of every turn the fold leaves in place.
 */
export function keptTokensOf(folds: readonly TurnFold[], turnTokens: ReadonlyMap<number, number>): number {
  // Only what sits after the fold point is re-priced: the prompt head before it stays cached, so
  // counting it would overstate the cost of a fold and make the rule needlessly conservative.
  const folded = new Set<number>()
  for (const fold of folds) {
    for (let turn = fold.turn; turn < fold.turn + fold.turns; turn++) folded.add(turn)
  }
  let start = Number.POSITIVE_INFINITY
  for (const fold of folds) start = Math.min(start, fold.turn)
  let total = 0
  for (const [turn, tokens] of turnTokens) {
    if (folded.has(turn) || turn < start) continue
    total += tokens
  }
  return total
}

/**
 * Whether a fold pays for itself.
 *
 * A fold costs about (1 - hit/miss) times the kept window once, and saves hit/miss times the folded
 * block on every later turn, so the break-even is roughly (miss/hit - 1) * kept / block turns. With a
 * hit at 1/50 of a miss that is 49 * kept / block, so demanding a block of "ratio" times the kept
 * window asks for about 49/ratio turns of remaining conversation.
 * @param block - tokens the fold would remove.
 * @param kept - tokens the fold leaves in place.
 * @param floor - absolute minimum block, 0 to disable.
 * @param ratio - block must be at least this many times the kept window, 0 to disable.
 * @returns True when folding is worth the cache break.
 */
export function foldWorthIt(block: number, kept: number, floor: number, ratio: number): boolean {
  if (floor > 0 && block < floor) return false
  if (ratio > 0 && block < ratio * kept) return false
  return true
}

/**
 * Optimal fold block for a cache-priced, steady-state conversation.
 *
 * Let `t` be tokens per turn, `K` the kept turns, `r = miss price / hit price`, and `T` the block
 * removed at a fold. A fold reprices the kept window `K*t` at miss once, while the growing block
 * costs hit-priced tokens each turn. Amortising over a cycle gives
 *
 *   cost/turn = t*(r-1)*K / T + T/2 + constant
 *
 * so the minimum is at
 *
 *   T* = t * sqrt(2*K*(r-1)).
 *
 * The current `foldBlockRatio` is a floor: the effective threshold is `max(T*, ratio*K*t)`. For
 * `K=2, r=50`, `T* / t = 14`; the default ratio 8 asks for `16*t`, close to optimal. `K=1` gives
 * `T* / t ≈ 9.9`, so a ratio-5 aggressive bundle folds too early.
 *
 * @param tokensPerTurn - average visible tokens added per turn.
 * @param keepTurns - turns kept after a fold.
 * @param missHitRatio - cache-miss price divided by cache-hit price, > 1.
 * @returns Optimal block size in tokens, or 0 for invalid input.
 */
export function optimalFoldThreshold(tokensPerTurn: number, keepTurns: number, missHitRatio: number): number {
  if (!(tokensPerTurn > 0) || !(keepTurns > 0) || !(missHitRatio > 1)) return 0
  return tokensPerTurn * Math.sqrt(2 * keepTurns * (missHitRatio - 1))
}

/** The corresponding optimal ratio `T* / kept`. */
export function optimalFoldRatio(keepTurns: number, missHitRatio: number): number {
  if (!(keepTurns > 0) || !(missHitRatio > 1)) return 0
  return Math.sqrt((2 * (missHitRatio - 1)) / keepTurns)
}

export function turnPlaceholder(turns: number): string {
  return `[已折叠] 之前的 ${turns} 轮对话已从上下文移除以节省 token；原文完整保存在对话树中，需要细节时调用 retrieve_context 取回，不要凭印象编造。`
}

/**
 * Choose whole turns to fold.
 *
 * Every foldable turn is still removed, but adjacent chosen turns are coalesced into one
 * replacement so the model and the transcript see a single placeholder instead of one line per
 * turn. Only turns entirely older than the keep window are taken, and the prompt head (system
 * messages before the first user message) is never touched.
 *
 * @param events - durable events in log order.
 * @param visible - surface entries currently visible to the model; may contain range entries.
 * @param keepTurns - most recent turns to leave alone.
 * @param turnOf - resolver for a surface seq's turn.
 * @param excludeTurn - the turn that is still stopping; it must never be folded.
 * @returns One replacement per contiguous run of foldable turns, oldest first.
 */
export function planTurnFold(
  events: readonly FoldEvent[],
  visible: readonly SurfaceSeqLike[],
  keepTurns: number,
  turnOf?: (seq: number) => number | undefined,
  excludeTurn?: number,
): TurnFold[] {
  // A host may list its surface out of conversation order, so group by sequence instead of by
  // position: the range the fold op cites must be a contiguous seq interval whose visible members
  // all belong to the same turn.
  const visibleSeqs = visible.flatMap(expandSurfaceSeq)
  const visibleSet = new Set(visibleSeqs)
  const turnOfSeq = new Map<number, number>()
  const protectedTurns = new Set<number>()
  let current = 0
  for (const event of events) {
    if (event.type === "turn/start") {
      current = (event.data?.turn as number | undefined) ?? current + 1
      continue
    }
    if (!visibleSet.has(event.seq)) continue
    if (!SURFACE_TYPES.has(event.type)) continue
    const data = event.data ?? {}
    const sourceKind = (data.source as { kind?: string } | undefined)?.kind
    // The resolver is the plugin's own bookkeeping and is preferred: a host may stamp the same turn
    // number on every surface event even though the conversation has moved on. Record the turn
    // before skipping injected placeholders: they still occupy a surface slot, and the span check
    // below must be able to resolve them or every turn containing one looks "foreign".
    const turn = turnOf?.(event.seq) ?? (typeof data.turn === "number" ? data.turn : current)
    if (turn > 0) {
      turnOfSeq.set(event.seq, turn)
      // Never fold a turn that carries a system message: later system nodes are not protected by
      // the host's surface-node-0 rule, but folding one would remove instructions from the prompt.
      if (event.type === "system/message") protectedTurns.add(turn)
    }
    // A placeholder from an earlier fold, or a compaction checkpoint, is not conversation content.
    if (sourceKind === "token-tree" || sourceKind === "compact-checkpoint") continue
  }
  const byTurn = new Map<number, number[]>()
  for (const [seq, turn] of turnOfSeq) {
    const list = byTurn.get(turn)
    if (list === undefined) byTurn.set(turn, [seq])
    else list.push(seq)
  }
  const turns = [...byTurn.keys()].sort((left, right) => left - right)
  if (turns.length === 0) return []
  const kept = new Set(keepTurns <= 0 ? [] : turns.slice(-keepTurns))
  // The first surface node belongs to the prompt head and may only be rewritten by a
  // system/message over exactly that node, so the opening turn is left alone.
  const earliest = turns[0]
  const chosen = turns.filter(turn =>
    turn !== earliest && turn !== excludeTurn && !kept.has(turn) && !protectedTurns.has(turn))
  if (chosen.length === 0) return []
  // Coalesce adjacent chosen turns: folding all old turns is intentional (it keeps them out of the
  // cache), but one replacement per turn would emit one placeholder per turn. A contiguous run can
  // be shadowed by a single replace op and still remove every turn in it.
  const runs: number[][] = []
  for (const turn of chosen) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last[last.length - 1] === turn - 1) last.push(turn)
    else runs.push([turn])
  }
  const folds: TurnFold[] = []
  const surfaceIndex = new Map(visibleSeqs.map((seq, index) => [seq, index]))
  for (const run of runs) {
    const runTurns = new Set(run)
    const seqs: number[] = []
    for (const turn of run) seqs.push(...(byTurn.get(turn) as number[]))
    seqs.sort((left, right) => (surfaceIndex.get(left) ?? left) - (surfaceIndex.get(right) ?? right))
    const first = seqs[0]
    const last = seqs[seqs.length - 1]
    // The host validates a replacement by surface position, not numeric seq. Check every visible
    // node in the surface span; after an earlier tool-scope fold inserted a high-seq replacement,
    // numeric order and surface order can disagree.
    const firstIndex = surfaceIndex.get(first)
    const lastIndex = surfaceIndex.get(last)
    let foreign = false
    if (firstIndex !== undefined && lastIndex !== undefined) {
      for (let index = firstIndex; index <= lastIndex; index++) {
        const owner = turnOfSeq.get(visibleSeqs[index])
        if (owner === undefined) continue
        if (!runTurns.has(owner)) { foreign = true; break }
      }
    } else {
      for (let seq = first; seq <= last; seq++) {
        if (!visibleSet.has(seq)) continue
        const owner = turnOfSeq.get(seq)
        if (owner === undefined) continue
        if (!runTurns.has(owner)) { foreign = true; break }
      }
    }
    if (foreign) continue
    folds.push({
      turn: run[0],
      startSeq: first,
      endSeq: last,
      turns: run.length,
      seqs,
      data: {
        role: "user",
        id: globalThis.crypto.randomUUID(),
        content: [{ type: "text", text: turnPlaceholder(run.length) }],
        source: { kind: "token-tree", id: "fold" },
      },
    })
  }
  return folds
}