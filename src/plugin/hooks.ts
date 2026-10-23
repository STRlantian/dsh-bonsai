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
import type { AgentLike, ContextLike } from './dsh.ts'
import { agentRegistryOf } from './dsh.ts'
import { buildInjectedMessage, isInjected, textOfContent } from './messages.ts'
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
      maybeCompact(ctx, service, payload.agent)
    } catch (error) {
      ctx.logger.warn(`token-tree: auto-compaction failed for session ${payload.agent?.session?.id}: ${describe(error)}`)
    }
  })
  ctx.logger.info('token-tree: auto-compaction listener mounted')
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
function maybeCompact(ctx: ContextLike, service: TokenTreeService, agent: AgentLike): void {
  const sessionId = agent?.session?.id
  if (typeof sessionId !== 'string') return
  const due = service.autoCompactDue(sessionId)
  let compaction: { compactNow?: (agent: unknown, signal?: AbortSignal, commandId?: string) => Promise<unknown> } | undefined
  try {
    compaction = ctx.get?.('compaction') as typeof compaction
  } catch {
    compaction = undefined
  }
  const compactNow = compaction?.compactNow
  const hasService = typeof compactNow === 'function'
  const tokens = service.conversationTokens(sessionId)
  const threshold = service.effective().autoCompactAboveTokens
  const estimate = service.compactionEstimate(sessionId)
  // Recorded even when nothing happens, so the settings route can explain why.
  service.noteAutoCompactProbe(sessionId, {
    tokens,
    threshold,
    due: due !== null,
    hasService,
    fired: false,
    at: Date.now(),
    estimate: estimate === null
      ? null
      : {
        readTokens: estimate.readTokens,
        summaryTokens: estimate.summaryTokens,
        savedPerTurn: estimate.savedPerTurn,
        turnsToBreakEven: estimate.turnsToBreakEven,
      },
  })
  if (due === null) return
  if (!hasService) {
    ctx.logger.warn('token-tree: auto-compaction is configured but the host exposes no compaction service')
    return
  }
  service.noteCompacted(sessionId)
  service.noteAutoCompactProbe(sessionId, {
    tokens,
    threshold,
    due: true,
    hasService: true,
    fired: true,
    at: Date.now(),
    estimate: estimate === null
      ? null
      : {
        readTokens: estimate.readTokens,
        summaryTokens: estimate.summaryTokens,
        savedPerTurn: estimate.savedPerTurn,
        turnsToBreakEven: estimate.turnsToBreakEven,
      },
  })
  if (estimate !== null) {
    ctx.logger.info(
      `token-tree: compaction will read ${estimate.readTokens} tokens and save ${estimate.savedPerTurn}/turn, paying off after ${estimate.turnsToBreakEven} turn(s)`,
    )
  }
  ctx.logger.info(
    `token-tree: auto-compacting session ${sessionId} (${due.tokens} tokens over the ${due.threshold} threshold)`,
  )
  // Fire and forget: the turn is ending, and a failed compaction must not surface as a turn error.
  void Promise.resolve()
    .then(() => compactNow(agent, undefined, `auto-compact-${Date.now()}`))
    .then(result => {
      ctx.logger.info(`token-tree: auto-compaction result for ${sessionId}: ${JSON.stringify(result ?? null).slice(0, 200)}`)
    })
    .catch(error => {
      ctx.logger.warn(`token-tree: auto-compaction failed for session ${sessionId}: ${describe(error)}`)
    })
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}
