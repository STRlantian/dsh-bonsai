/**
 * Harness wiring.
 *
 * Three subscriptions turn the service into part of the agent loop without
 * replacing it:
 *
 * - `session/event` folds the durable log into the tree, which is what makes
 *   costs, reflections, and observations replayable after a reload.
 * - `agent/pre-step` prepends the weighted memory block to the first step of each
 *   turn, so recall happens once per question instead of once per tool call.
 * - `agent/turn-stopping` runs the supervisor: evaluate, reflect, backtrack, and
 *   queue one guiding message so the loop keeps going inside the same turn.
 *
 * A listener never throws into the loop: a retrieval failure degrades the turn,
 * it does not break it. The failure is logged at `warn`.
 *
 * @module dsh-token-tree/plugin/hooks
 */

import type { ResolvedConfig } from './config.ts'
import type { AgentLike, ContextLike, SessionLike } from './dsh.ts'
import { agentRegistryOf } from './dsh.ts'
import { buildInjectedMessage, isInjected, textOfContent } from './messages.ts'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { blockTokensOf, foldWorthIt, keptTokensOf, planFold, planTurnFold } from './fold.ts'
import { SURFACE_TYPES } from './fold.ts'
import { readTrailingMarkers } from './markers.ts'
import type { TokenTreeService } from './service.ts'

/** Longest query text taken from a user message. */
const MAX_QUERY_CHARS = 2_000

/**
 * Decide whether a session belongs to the tracked population.
 * @param agent - agent owning the session.
 * @param ctx - plugin context, for the agent registry.
 * @param config - resolved configuration.
 * @returns `true` when the session should build a tree.
 */
function tracked(agent: AgentLike, ctx: ContextLike, config: ResolvedConfig): boolean {
  if (config.includeSubagents) return true
  // `ctx.agents` would throw: the property proxy refuses services the plugin did
  // not inject, and the registry is optional by design.
  const roots = agentRegistryOf(ctx)?.roots?.()
  if (roots === undefined) return true
  return roots.includes(agent)
}

/**
 * Build the retrieval query from the messages admitted for this step.
 * @param messages - claimed messages.
 * @returns Query text, or `undefined` when the step carries no learner input.
 */
function queryOf(messages: readonly unknown[]): string | undefined {
  const parts: string[] = []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    if (isInjected(message)) continue
    const record = message as { content?: unknown }
    const text = textOfContent(record.content)
    if (text.length > 0) parts.push(text)
  }
  if (parts.length === 0) return undefined
  return parts.join('\n').slice(0, MAX_QUERY_CHARS)
}

/**
 * Register the plugin's subscriptions.
 * @param ctx - plugin context.
 * @param service - session memory service.
 * @param config - resolved configuration.
 */
/**
 * Append one failure to the plugin's own diagnostics file.
 *
 * The host console usually swallows plugin warnings, and a tree that silently stays empty is very
 * hard to notice otherwise.
 * @param sessionId - session the failure belongs to.
 * @param type - event type, or a short tag.
 * @param error - what went wrong.
 */
function recordFailure(sessionId: string, type: string, error: unknown): void {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const path = join(home, 'token-tree', 'diagnostics.log')
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${sessionId} ${type} ${String(error)}\n`)
  } catch {
    // Diagnostics must never break the turn loop.
  }
}

export function installHooks(ctx: ContextLike, service: TokenTreeService, config: ResolvedConfig): void {
  ctx.on('session/event', (session, event) => {
    try {
      service.noteSessionCapability(session)
      service.handleEvent(session, event)
    } catch (error) {
      // The host console usually swallows plugin warnings, and a silent tree failure is hard to spot.
      recordFailure(session.id, event.type, error)
      ctx.logger.warn(`token-tree: failed to fold ${event.type} for session ${session.id}: ${describe(error)}`)
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.step > 1) return decision
    if (!tracked(payload.agent, ctx, config)) return decision
    // A session that existed before this process started may not publish its events to the plugin, so
    // the tree would stay empty while this hook keeps running. Rebuilding from the snapshot is
    // idempotent and gives the panel and folding the history back.
    try {
      service.backfillFromSession(payload.agent.session)
    } catch (error) {
      ctx.logger.warn(`token-tree: could not rebuild the tree for ${payload.agent.session.id}: ${describe(error)}`)
    }
    // Tool-first mode: no block, just a one-line reminder that the older history is
    // retrievable. The block itself costs ~400 uncached tokens every turn, which a
    // short conversation does not need. These switches can be changed while running,
    // so they come from the service rather than straight from the profile config.
    // Record the prompt shape so the billed usage can calibrate token counting.
    service.notePromptStats(payload.agent.session.id)
    service.notePromptShape(payload.agent.session.id, decision.messages)
    service.noteDecisionShape(payload.agent.session.id, decision)
    const settings = service.effective(payload.agent.session.id)
    const query = queryOf(decision.messages)
    // The choices block rides along whatever else is injected: ten questions cost a few hundred
    // tokens, while a separate request to ask the model the same thing would cost a whole prompt.
    const choices = query === undefined ? '' : service.attachChoices(payload.agent.session.id, query)
    if (!settings.autoInject) {
      const hint = settings.retrievalHint ? service.retrievalHint(payload.agent.session.id) : undefined
      const body = [hint, choices].filter(part => part !== undefined && part !== '').join('\n\n')
      if (body === '') return decision
      return { ...decision, messages: [...decision.messages, buildInjectedMessage(body)] }
    }
    if (query === undefined) return decision
    try {
      const block = service.memoryBlock(payload.agent.session.id, query, config.injectBudgetTokens)
      const body = [block, choices].filter(part => part !== undefined && part !== '').join('\n\n')
      if (body === '') return decision
      ctx.logger.info(`token-tree: injecting memory block for session ${payload.agent.session.id} (turn ${payload.turn})`)
      return { ...decision, messages: [...decision.messages, buildInjectedMessage(body)] }
    } catch (error) {
      ctx.logger.warn(`token-tree: recall failed for session ${payload.agent.session.id}: ${describe(error)}`)
      return decision
    }
  })

  // Hide tools the user listed. Done on the agent's own scope, which is the weakest
  // mechanism the host offers for this (it keeps schema, lookup and execution aligned).
  /** Last deny list successfully applied to one agent, so a per-turn reapply is cheap. */
  const appliedDeny = new Map<string, string>()
  /** The host disposer for that agent's current restriction; restrictions intersect, so the old
   * one must be lifted before a new one (otherwise an empty deny cannot bring tools back). */
  const denyDisposers = new Map<string, () => void>()
  const applyToolDeny = (agent: AgentLike): void => {
    const deny = service.toolDeny(agent.session?.id)
    const key = deny.join('\u0000')
    if (appliedDeny.get(agent.id) === key) return
    const scoped = agent.ctx
    const registry = scoped?.tools
    const restrict = registry?.restrict
    const shape = `ctx=${typeof scoped} tools=${typeof registry} ctxKeys=${JSON.stringify(Object.keys(scoped ?? {}).slice(0, 14))} toolKeys=${JSON.stringify(Object.keys(registry ?? {}))}`
    if (typeof restrict !== 'function') {
      ctx.logger.warn(
        `token-tree: no tools.restrict on the agent context (ctx=${typeof scoped}, tools=${typeof registry}, keys=${JSON.stringify(Object.keys(registry ?? {}))}, ctxKeys=${JSON.stringify(Object.keys(scoped ?? {}))})`,
      )
      service.noteToolRestriction(String(agent.id ?? 'agent'), deny, false)
      appliedDeny.set(agent.id, key)
      ctx.logger.warn('token-tree: toolDeny is configured but this host exposes no tools.restrict()')
      return
    }
    try {
      denyDisposers.get(agent.id)?.()
      denyDisposers.delete(agent.id)
      const dispose = restrict.call(agent.ctx?.tools, { deny }) as unknown
      if (typeof dispose === 'function') denyDisposers.set(agent.id, dispose as () => void)
      appliedDeny.set(agent.id, key)
      service.noteToolRestriction(String(agent.id ?? 'agent'), deny, true, shape)
      ctx.logger.info(deny.length === 0
        ? `token-tree: showing all tools to agent ${agent.id}`
        : `token-tree: hid ${deny.length} tool(s) from agent ${agent.id}: ${deny.join(', ')}`)
    } catch (error) {
      service.noteToolRestriction(String(agent.id ?? 'agent'), deny, false, shape, describe(error))
      appliedDeny.set(agent.id, key)
      ctx.logger.warn(`token-tree: could not hide tools (${describe(error)})`)
    }
  }
  try {
    ctx.on('agent/created', (payload) => {
      const agent = payload?.agent
      if (agent === undefined) return
      applyToolDeny(agent)
    })
  } catch (error) {
    ctx.logger.debug(`token-tree: agent/created not available (${describe(error)})`)
  }

  // Read-only observation of the prompt the host is about to assemble.
  try {
    ctx.on('system-prompt/assemble', (assembly, _context, next) => {
      try {
        service.noteAssembly(assembly)
      } catch {
        // Diagnostics must never break assembly.
      }
      return next()
    })
  } catch (error) {
    ctx.logger.debug(`token-tree: system-prompt/assemble not available (${describe(error)})`)
  }

  // Fold old tool results out of the model view at the last moment the turn is still open.
  // The host's durable-log reader requires a `tool/result` surface replacement to fall inside
  // an open turn; appending it after `turn/end` writes a log that loads live but is rejected on
  // the next read. `agent/turn-stopping` runs before the host appends `turn/end`, so the fold is
  // both ahead of the next request and inside the turn that owns it.
  const foldedTurns = new Map<string, number>()
  ctx.on('agent/turn-stopping', (payload) => {
    // A tool switch flipped during the conversation takes effect at the next turn boundary, when
    // no tool call is in flight. The created hook covers the first request.
    if (payload.agent !== undefined) {
      try {
        applyToolDeny(payload.agent)
      } catch (error) {
        ctx.logger.warn(`token-tree: could not apply toolDeny for ${payload.agent.id}: ${describe(error)}`)
      }
    }
    // Supervision keeps seeing the pre-fold tree, exactly as it did when folding ran after
    // turn/end. A fold only changes what the next request reads, not what just happened.
    if (service.effective(payload.agent?.session?.id).autoReflect && tracked(payload.agent, ctx, config)) {
      try {
        const outcome = service.supervise(payload.agent, payload.turn)
        if (outcome.skipped !== undefined) {
          ctx.logger.debug(`token-tree: supervisor skipped turn ${payload.turn} (${outcome.skipped})`)
        }
      } catch (error) {
        ctx.logger.warn(`token-tree: supervision failed for session ${payload.agent.session.id}: ${describe(error)}`)
      }
    }
    const session = payload.agent?.session
    if (session !== undefined) {
      // Marker stripping runs on every stopping pass of the turn: a supervisor continuation
      // produces a second pass, and its final answer still has markers to remove. Folding is
      // idempotent per turn, so it keeps its own guard.
      try {
        stripMarkers(session, service, ctx, payload.turn)
      } catch (error) {
        ctx.logger.warn(`token-tree: marker strip failed for session ${session.id}: ${describe(error)}`)
      }
      if (foldedTurns.get(session.id) !== payload.turn) {
        foldedTurns.set(session.id, payload.turn)
        try {
          maybeFold(session, service, ctx)
        } catch (error) {
          ctx.logger.warn(`token-tree: fold failed for session ${session.id}: ${describe(error)}`)
        }
      }
    }
  })
}

/**
 * Render an unknown thrown value for a log line.
 * @param error - thrown value.
 * @returns A short message.
 */

/**
 * Install the auto-compaction listener, with the host's compaction service injected.
 *
 * Cordis refuses `ctx.get(name)` for services a plugin did not declare, so the listener is
 * registered through `ctx.inject` instead: it simply never mounts in profiles where
 * compaction is disabled.
 * @param ctx - context scoped to the compaction service.
 * @param service - tree service holding the measurement.
 */


/**
 * Remove trailing placement and summary markers from the answers of the turn that just ran.
 *
 * A `tool/result` or `user/message` surface replacement may be appended while the turn is open;
 * an `assistant/message` replacement additionally needs an open step. The host has already closed
 * the last real step when `agent/turn-stopping` runs, so the rewrite is wrapped in one short
 * synthetic step. Only text blocks are touched, non-text blocks are preserved, and markers are
 * recognized only at the end of the last text block. Messages that carry tool calls are left alone:
 * their tool lifecycle belongs to the real step and must not be replayed into a synthetic one.
 * @param session - session whose turn is stopping.
 * @param service - tree service, for the turn bookkeeping.
 * @param ctx - plugin context, for logging.
 * @param currentTurn - turn that is still open.
 */
function stripMarkers(session: SessionLike, service: TokenTreeService, ctx: ContextLike, currentTurn: number): void {
  if (typeof session.append !== 'function') return
  const surfaceSeqs = Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : []
  const resolve = typeof session.eventAt === 'function' ? (seq: number) => session.eventAt?.(seq) : undefined
  const events = surfaceSeqs.length > 0 && resolve !== undefined
    ? surfaceSeqs.map(seq => ({ seq, event: resolve(seq) }))
    : (session.snapshotEvents?.() ?? []).map((event, index) => ({ seq: event.seq ?? index + 1, event }))
  // seqTurns is local; payload.turn is the host's counter. Use the local current turn to select
  // the answers, but keep the host turn for the step/turn fields of the replacement.
  const localTurn = service.sessionTurn(session.id)
  const targets: { seq: number; data: Record<string, unknown>; message: Record<string, unknown>; content: unknown[] }[] = []
  for (const entry of events) {
    if (entry.event?.type !== 'assistant/message') continue
    if (service.turnOfSeq(session.id, entry.seq) !== localTurn) continue
    const data = entry.event.data as Record<string, unknown> | undefined
    if (data === undefined) continue
    const message = data.message as Record<string, unknown> | undefined
    if (message === undefined) continue
    const content = message.content
    if (!Array.isArray(content)) continue
    if (content.some(block => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')) continue
    let lastText = -1
    for (let index = 0; index < content.length; index++) {
      const block = content[index]
      if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') lastText = index
    }
    if (lastText < 0) continue
    if (lastText !== content.length - 1) continue
    const block = content[lastText] as { text?: unknown }
    if (typeof block.text !== 'string') continue
    const parsed = readTrailingMarkers(block.text)
    if (parsed.text === block.text) continue
    targets.push({
      seq: entry.seq,
      data,
      message,
      content: content.map((item, index) => index === lastText ? { ...(item as Record<string, unknown>), text: parsed.text } : item),
    })
  }
  if (targets.length === 0) return
  const step = nextStepOf(session, currentTurn)
  let opened = false
  try {
    session.append('step/start', { turn: currentTurn, step })
    opened = true
    for (const target of targets) {
      session.append('assistant/message', {
        ...target.data,
        turn: currentTurn,
        step,
        message: { ...target.message, content: target.content },
      }, {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq],
      })
    }
    ctx.logger.info(`token-tree: stripped placement markers from ${targets.length} turn-${currentTurn} answer(s)`)
  } catch (error) {
    ctx.logger.warn(`token-tree: could not strip markers in turn ${currentTurn}: ${describe(error)}`)
  } finally {
    if (opened) {
      try {
        session.append('step/end', { turn: currentTurn, step })
      } catch (error) {
        ctx.logger.warn(`token-tree: could not close the marker-strip step in turn ${currentTurn}: ${describe(error)}`)
      }
    }
  }
}

/** The host's next step number for one open turn, derived from the durable log. */
function nextStepOf(session: SessionLike, turn: number): number {
  let max = 0
  for (const event of session.snapshotEvents?.() ?? []) {
    const data = event.data as { turn?: unknown; step?: unknown } | undefined
    if (data?.turn !== turn) continue
    if (event.type !== 'step/start' && event.type !== 'step/end') continue
    if (typeof data.step === 'number' && data.step > max) max = data.step
  }
  return max + 1
}

/**
 * Fold old tool results out of the model-visible surface.
 *
 * Runs at `agent/turn-stopping`, before the host appends `turn/end`: a `tool/result` surface
 * replacement is only legal inside an open turn. Only `tool/result` entries are touched, and
 * only their `message.content`: turn, step, callId and error fields stay, which is what keeps
 * the call/result pairs well formed. The replacement is a `surfaceOp: replace` event, so the
 * originals remain in the log and in the tree.
 * @param session - session whose turn is stopping.
 * @param service - tree service, for the measured size and the diagnostics.
 * @param ctx - plugin context, for logging.
 */
function maybeFold(session: SessionLike, service: TokenTreeService, ctx: ContextLike): void {
  const settings = service.effective(session.id)
  // `always` folds every finished turn outside the keep window, whatever the size: the experiment
  // "fold everything, force the model to consult the tree" needs no threshold at all.
  const always = settings.foldPolicy === 'always'
  if (!always && settings.foldAboveTokens <= 0 && settings.foldBlockRatio <= 0) return
  if (typeof session.append !== 'function') return
  // The whole session, not the current branch: the next request carries all of it.
  const tokens = service.historyTokens(session.id)
  // The planner, turnTokens and foldGap all use this service's local turn numbers. Mixing in the
  // host's payload turn makes the cadence gap negative whenever the two counters diverge.
  const turn = service.sessionTurn(session.id)
  if (!always && settings.foldCadence > 0 && service.foldGap(session.id) < settings.foldCadence) {
    service.noteFold(session.id, 0, tokens, settings.foldAboveTokens, { planned: 0, visible: 0, cadence: settings.foldCadence, gap: service.foldGap(session.id) })
    return
  }
  // A snapshot event may carry no sequence, while the host tracks the view as real sequence numbers.
  // Rebuild from the surface list when the host can resolve each seq, so the planner's ranges are the
  // values the fold op has to cite.
  const surfaceSeqs = Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : []
  const resolveEvent = typeof session.eventAt === 'function' ? (seq: number) => session.eventAt?.(seq) : undefined
  const events = surfaceSeqs.length > 0 && resolveEvent !== undefined
    ? surfaceSeqs.map(seq => {
      const entry = resolveEvent(seq)
      return { type: entry?.type ?? 'user/message', seq, data: entry?.data as Record<string, unknown> | undefined }
    })
    : (session.snapshotEvents?.() ?? []).map((event, index) => ({
      type: event.type,
      seq: typeof event.seq === 'number' ? event.seq : index + 1,
      data: event.data as Record<string, unknown> | undefined,
    }))
  // The host's surface list is the authority when it is there. Without it, fall back to the
  // surface event types only: the planner groups messages by turn and rejects a turn whose nodes are
  // not contiguous, and step bookkeeping between two messages would break that.
  const visible = Array.isArray(session.surface?.nodes) && session.surface.nodes.length > 0
    ? [...session.surface.nodes]
    : events.filter(event => SURFACE_TYPES.has(event.type)).map(event => event.seq)
  const legacy = !always && settings.foldTrigger === 'history'
  if (legacy && tokens < settings.foldAboveTokens) return
  if (settings.foldScope === 'turns') {
    // The turn that is still stopping is not history yet: a continuation inside it may still
    // need these messages, and `foldKeepTurns: 0` must never replace the question being asked.
    const turns = planTurnFold(events, visible, settings.foldKeepTurns, seq => service.turnOfSeq(session.id, seq))
      .filter(planned => planned.turn !== turn)
    if (turns.length === 0) {
      service.noteFold(session.id, 0, tokens, settings.foldAboveTokens, { planned: 0, visible: visible.length })
      return
    }
    // The threshold now measures the block about to leave, and the block must also be large
    // relative to the keep window: a fold re-prices that window at the miss price, so a small
    // block is a loss even when the total history is large.
    if (!always && !legacy) {
      const perTurn = service.turnTokens(session.id)
      const block = blockTokensOf(turns, perTurn)
      const kept = keptTokensOf(turns, perTurn)
      if (!foldWorthIt(block, kept, settings.foldAboveTokens, settings.foldBlockRatio)) {
        service.noteFold(session.id, 0, tokens, block, { planned: turns.length, visible: visible.length, range: `block=${block} kept=${kept} ratio=${settings.foldBlockRatio}` })
        return
      }
    }
    let folded = 0
    for (const planned of turns) {
      try {
        session.append('user/message', planned.data, {
          surfaceOp: { op: 'replace', startSeq: planned.startSeq, endSeq: planned.endSeq },
          // The host requires every shadowed surface node to be named.
          sourceEventSeqs: planned.seqs,
        })
        folded++
      } catch (error) {
        ctx.logger.warn(`token-tree: could not fold turn ${planned.startSeq}-${planned.endSeq} (${describe(error)})`)
        service.noteFold(session.id, folded, tokens, settings.foldAboveTokens, { planned: turns.length, visible: visible.length, range: `first=${planned.startSeq}-${planned.endSeq} seqs=${planned.seqs.join(',')} visible=${visible.join(',')}`, error: describe(error) })
        return
      }
    }
    if (folded > 0) service.noteFoldTurn(session.id, turn)
    service.noteFold(session.id, folded, tokens, settings.foldAboveTokens, { planned: turns.length, visible: visible.length })
    return
  }

  // Tool results are much smaller than a turn, so the absolute threshold still measures the whole
  // history here; the relative block rule is a turn-level decision.
  if (!always && tokens < settings.foldAboveTokens) return
  // Keep the still-open turn's own results visible for the same reason as the turn fold above.
  const plan = planFold(events, visible, settings.foldKeepTurns)
    .filter(replacement => {
      const dataTurn = (replacement.data as { turn?: unknown }).turn
      const owner = service.turnOfSeq(session.id, replacement.seq)
      const effectiveTurn = typeof owner === 'number' ? owner : dataTurn
      return effectiveTurn !== turn
    })
  if (plan.length === 0) {
    service.noteFold(session.id, 0, tokens, settings.foldAboveTokens, { planned: 0, visible: visible.length })
    return
  }
  let folded = 0
  for (const replacementEntry of plan) {
    try {
      session.append(replacementEntry.type, replacementEntry.data, {
        surfaceOp: { op: 'replace', startSeq: replacementEntry.seq, endSeq: replacementEntry.seq },
        sourceEventSeqs: [replacementEntry.seq],
      })
      folded++
    } catch (error) {
      ctx.logger.warn(`token-tree: could not fold seq ${replacementEntry.seq} (${describe(error)})`)
      service.noteFold(session.id, folded, tokens, settings.foldAboveTokens, { planned: plan.length, visible: visible.length, error: describe(error) })
      return
    }
  }
  if (folded > 0) service.noteFoldTurn(session.id, turn)
  service.noteFold(session.id, folded, tokens, settings.foldAboveTokens, { planned: plan.length, visible: visible.length })
  ctx.logger.info(`token-tree: folded ${folded} tool result(s) at ${tokens} tokens (block threshold ${settings.foldAboveTokens})`)
}

/**
 * Ask the host to compact when the measured conversation is over the threshold.
 *
 * The plugin cannot shorten the prompt itself (it never sees history); compaction is the
 * host's own mechanism, and this is the only way a plugin can cause it. Failures are logged
 * and never thrown into the turn loop.
 * @param ctx - plugin context, for the compaction service.
 * @param service - tree service holding the measurement.
 * @param agent - agent whose session would be compacted.
 */

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}
