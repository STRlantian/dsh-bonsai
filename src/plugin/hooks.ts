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
import { planFold, planTurnFold } from './fold.ts'
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
export function installHooks(ctx: ContextLike, service: TokenTreeService, config: ResolvedConfig): void {
  ctx.on('session/event', (session, event) => {
    try {
      service.noteSessionCapability(session)
      service.handleEvent(session, event)
    } catch (error) {
      ctx.logger.warn(`token-tree: failed to fold ${event.type} for session ${session.id}: ${describe(error)}`)
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (payload.step > 1) return decision
    if (!tracked(payload.agent, ctx, config)) return decision
    // Tool-first mode: no block, just a one-line reminder that the older history is
    // retrievable. The block itself costs ~400 uncached tokens every turn, which a
    // short conversation does not need. These switches can be changed while running,
    // so they come from the service rather than straight from the profile config.
    // Record the prompt shape so the billed usage can calibrate token counting.
    service.notePromptStats(payload.agent.session.id)
    service.notePromptShape(payload.agent.session.id, decision.messages)
    service.noteDecisionShape(payload.agent.session.id, decision)
    const settings = service.effective()
    if (!settings.autoInject) {
      if (!settings.retrievalHint) return decision
      const hint = service.retrievalHint(payload.agent.session.id)
      if (hint === undefined) return decision
      return { ...decision, messages: [...decision.messages, buildInjectedMessage(hint)] }
    }
    const query = queryOf(decision.messages)
    if (query === undefined) return decision
    try {
      const block = service.memoryBlock(payload.agent.session.id, query, config.injectBudgetTokens)
      if (block === undefined) return decision
      ctx.logger.info(`token-tree: injecting memory block for session ${payload.agent.session.id} (turn ${payload.turn})`)
      return { ...decision, messages: [...decision.messages, buildInjectedMessage(block)] }
    } catch (error) {
      ctx.logger.warn(`token-tree: recall failed for session ${payload.agent.session.id}: ${describe(error)}`)
      return decision
    }
  })

  // Hide tools the user listed. Done on the agent's own scope, which is the weakest
  // mechanism the host offers for this (it keeps schema, lookup and execution aligned).
  try {
    ctx.on('agent/created', (payload) => {
      const agent = payload?.agent
      if (agent === undefined) return
      const deny = service.toolDeny()
      if (deny.length === 0) return
      const scoped = agent.ctx
      const registry = scoped?.tools
      const restrict = registry?.restrict
      const shape = `ctx=${typeof scoped} tools=${typeof registry} ctxKeys=${JSON.stringify(Object.keys(scoped ?? {}).slice(0, 14))} toolKeys=${JSON.stringify(Object.keys(registry ?? {}))}`
      if (typeof restrict !== 'function') {
        ctx.logger.warn(
          `token-tree: no tools.restrict on the agent context (ctx=${typeof scoped}, tools=${typeof registry}, keys=${JSON.stringify(Object.keys(registry ?? {}))}, ctxKeys=${JSON.stringify(Object.keys(scoped ?? {}))})`,
        )
        service.noteToolRestriction(String(agent.id ?? 'agent'), deny, false)
        ctx.logger.warn('token-tree: toolDeny is configured but this host exposes no tools.restrict()')
        return
      }
      try {
        restrict.call(agent.ctx?.tools, { deny })
        service.noteToolRestriction(String(agent.id ?? 'agent'), deny, true, shape)
        ctx.logger.info(`token-tree: hid ${deny.length} tool(s) from agent ${agent.id}: ${deny.join(', ')}`)
      } catch (error) {
        service.noteToolRestriction(String(agent.id ?? 'agent'), deny, false, shape, describe(error))
        ctx.logger.warn(`token-tree: could not hide tools (${describe(error)})`)
      }
    })
  } catch (error) {
    ctx.logger.debug(`token-tree: agent/created not available (${describe(error)})`)
  }

  // Fold old tool results out of the model view at turn end. Append-only: the log keeps
  // every original, the surface just stops showing it.
  const foldScheduled = new Set<string>()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (foldScheduled.has(session.id)) return
    foldScheduled.add(session.id)
    // The event is still being published: appending now re-enters the publish and the host
    // rejects it. Defer to the next macrotask, after the log write has settled.
    setTimeout(() => {
      foldScheduled.delete(session.id)
      try {
        maybeFold(session, service, ctx)
      } catch (error) {
        ctx.logger.warn(`token-tree: fold failed for session ${session.id}: ${describe(error)}`)
      }
    }, 0)
  })

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

  ctx.on('agent/turn-stopping', (payload) => {
    if (!service.effective().autoReflect) return
    if (!tracked(payload.agent, ctx, config)) return
    try {
      const outcome = service.supervise(payload.agent, payload.turn)
      if (outcome.skipped !== undefined) {
        ctx.logger.debug(`token-tree: supervisor skipped turn ${payload.turn} (${outcome.skipped})`)
      }
    } catch (error) {
      ctx.logger.warn(`token-tree: supervision failed for session ${payload.agent.session.id}: ${describe(error)}`)
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
export function installCompactionHook(ctx: ContextLike, service: TokenTreeService): void {
  ctx.on('agent/turn-stopping', (payload) => {
    try {
        } catch (error) {
      ctx.logger.warn(`token-tree: auto-compaction failed for session ${payload.agent?.session?.id}: ${describe(error)}`)
    }
  })
  ctx.logger.info('token-tree: auto-compaction listener mounted')
}


/**
 * Fold old tool results out of the model-visible surface.
 *
 * Runs at `turn/end`, so no turn is in flight. Only `tool/result` entries are touched, and
 * only their `message.content`: turn, step, callId and error fields stay, which is what keeps
 * the call/result pairs well formed. The replacement is a `surfaceOp: replace` event, so the
 * originals remain in the log and in the tree.
 * @param session - session that just finished a turn.
 * @param service - tree service, for the measured size and the diagnostics.
 * @param ctx - plugin context, for logging.
 */
function maybeFold(session: SessionLike, service: TokenTreeService, ctx: ContextLike): void {
  const settings = service.effective()
  // `always` folds every finished turn outside the keep window, whatever the size: the experiment
  // "fold everything, force the model to consult the tree" needs no threshold at all.
  const always = settings.foldPolicy === 'always'
  const threshold = always ? 0 : settings.foldAboveTokens
  if (!always && threshold <= 0) return
  if (typeof session.append !== 'function') return
  // The whole session, not the current branch: the next request carries all of it.
  const tokens = service.historyTokens(session.id)
  if (!always && tokens < threshold) return
  const events = (session.snapshotEvents?.() ?? []).map(event => ({
    type: event.type,
    seq: event.seq,
    data: event.data as Record<string, unknown> | undefined,
  }))
  const visible = Array.isArray(session.surface?.nodes) && session.surface.nodes.length > 0
    ? [...session.surface.nodes]
    : events.map(event => event.seq)
  if (settings.foldScope === 'turns') {
    const turns = planTurnFold(events, visible, settings.foldKeepTurns)
    if (turns.length === 0) {
      service.noteFold(session.id, 0, tokens, threshold, { planned: 0, visible: visible.length })
      return
    }
    let folded = 0
    for (const turn of turns) {
      try {
        session.append('user/message', turn.data, {
          surfaceOp: { op: 'replace', startSeq: turn.startSeq, endSeq: turn.endSeq },
          // The host requires every shadowed surface node to be named.
          sourceEventSeqs: turn.seqs,
        })
        folded++
      } catch (error) {
        ctx.logger.warn(`token-tree: could not fold turn ${turn.startSeq}-${turn.endSeq} (${describe(error)})`)
        service.noteFold(session.id, folded, tokens, threshold, { planned: turns.length, visible: visible.length, range: `first=${turns[0].startSeq}-${turns[0].endSeq} seqs=${turns[0].seqs.join(',')} visible=${visible.join(',')}`, error: describe(error) })
        return
      }
    }
    service.noteFold(session.id, folded, tokens, threshold, { planned: turns.length, visible: visible.length })
    return
  }

  const plan = planFold(events, visible, settings.foldKeepTurns)
  if (plan.length === 0) {
    service.noteFold(session.id, 0, tokens, threshold, { planned: 0, visible: visible.length })
    return
  }
  let folded = 0
  for (const replacement of plan) {
    try {
      session.append(replacement.type, replacement.data, {
        surfaceOp: { op: 'replace', startSeq: replacement.seq, endSeq: replacement.seq },
        sourceEventSeqs: [replacement.seq],
      })
      folded++
    } catch (error) {
      ctx.logger.warn(`token-tree: could not fold seq ${replacement.seq} (${describe(error)})`)
      service.noteFold(session.id, folded, tokens, threshold, { planned: plan.length, visible: visible.length, error: describe(error) })
      return
    }
  }
  service.noteFold(session.id, folded, tokens, threshold, { planned: plan.length, visible: visible.length })
  ctx.logger.info(`token-tree: folded ${folded} tool result(s) at ${tokens} tokens (threshold ${threshold})`)
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
