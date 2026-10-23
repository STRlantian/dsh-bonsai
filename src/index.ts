/**
 * DeepSeek Harness plugin: weighted conversation-tree memory with reflection
 * backtracking.
 *
 * The plugin exports the function-plugin contract — `name`, `inject`, `Config`,
 * `apply` — and nothing else is needed to mount it: `apply` publishes
 * `ctx.tokenTree`, registers five tools on `ctx.tools`, and subscribes to the
 * three loop extension points described in `hooks.ts`.
 *
 * @module dsh-bonsai
 */

import type { ContextLike } from './plugin/dsh.ts'
import type { ResolvedConfig } from './plugin/config.ts'
import { createTools } from './plugin/tools.ts'
import { installCompactionHook, installHooks } from './plugin/hooks.ts'
import { installCommand } from './plugin/command.ts'
import { installHttpRoute } from './plugin/http.ts'
import { TokenTreeService } from './plugin/service.ts'
import { EditStore } from './plugin/store.ts'
import { SettingsStore } from './plugin/settings.ts'

export { Config } from './plugin/config.ts'
export type { Config as TokenTreeConfig, ResolvedConfig } from './plugin/config.ts'
export { TokenTreeService } from './plugin/service.ts'
export { EditStore, defaultStorePath } from './plugin/store.ts'
export type { EditOp } from './plugin/store.ts'
export { SettingsStore, defaultSettingsPath } from './plugin/settings.ts'
export type { SettingsOverrides } from './plugin/settings.ts'
export { renderTree } from './plugin/render.ts'
export { blocksOf } from './plugin/blocks.ts'
export type { BlockView, TreePayload, BlockOrigin } from './plugin/blocks.ts'
export type { RenderTreeOptions } from './plugin/render.ts'
export type { SessionState, SupervisionOutcome, NodeView, QueryOptions, QueryResult } from './plugin/service.ts'

/** Plugin name shown in loader logs and the plugin inventory. */
export const name = 'dsh-bonsai'

/**
 * Services this plugin needs before it activates.
 *
 * `tools` is the only hard requirement: without a tool registry the plugin has no
 * model-facing surface. The agent registry is read through an optional member
 * because headless hosts may run without live agents.
 */
export const inject = ['tools']

/**
 * Mount the plugin.
 * @param ctx - plugin context carrying the tool registry and event bus.
 * @param config - configuration resolved by {@link Config}.
 * @param deps - optional stores; tests pass in-memory ones so they never read the user's files.
 */
export function apply(
  ctx: ContextLike,
  config: ResolvedConfig,
  deps: { store?: EditStore; settings?: SettingsStore } = {},
): void {
  // Manual edits are not in the session log, so they get their own append-only file
  // and are replayed on top of the rebuilt tree. A broken file costs the overrides,
  // never the plugin: the store is fail-soft by construction.
  const store = deps.store ?? new EditStore({
    onError: message => ctx.logger.warn(message),
  })
  // Runtime switches live next to the edit log; they override the profile config so a
  // checkbox in the UI takes effect on the next turn instead of at the next restart.
  const settings = deps.settings ?? new SettingsStore({ onError: message => ctx.logger.warn(message) })
  const service = new TokenTreeService({ config, logger: ctx.logger, store, settings })

  /**
   * Run one optional integration without letting it take the host down.
   *
   * An activated plugin row that throws is reported as "did not activate", and a
   * composition that counts rows as required then fails to start at all. This
   * plugin is installed into the user's own profile, so a drifted harness API must
   * cost one integration, never the whole application.
   * @param label - integration name used in the log line.
   * @param install - work to run.
   */
  const guard = (label: string, install: () => void): void => {
    try {
      install()
    } catch (error) {
      ctx.logger.error(
        `token-tree: ${label} failed to install; the rest of the plugin stays active: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // Publishing the service is the one piece every later step reads.
  guard('service', () => {
    ctx.provide('tokenTree', service)
  })

  // The tree lives in memory only, so unloading must release it explicitly:
  // this is the one resource the harness does not own.
  guard('disposal', () => {
    ctx.effect(() => () => {
      for (const sessionId of service.sessionIds) service.forget(sessionId)
      ctx.logger.debug('token-tree: released every session tree')
    }, 'token-tree/service')
  })

  let tools = [] as ReturnType<typeof createTools>
  guard('tools', () => {
    tools = createTools(service)
    for (const tool of tools) ctx.tools.register(tool)
  })
  guard('hooks', () => {
    installHooks(ctx, service, config)
  })
  guard('auto compaction', () => {
    // Optional: only mounts where the host provides a compaction service.
    ctx.inject?.(['compaction'], (scoped) => {
      installCompactionHook(scoped, service)
    })
  })
  guard('/tree command', () => {
    installCommand(ctx, service)
  })
  guard('tree route', () => {
    installHttpRoute(ctx, service)
  })

  ctx.logger.info(
    `token-tree: mounted — ${tools.length} tools (${tools.map(tool => tool.name).join(', ')}), /tree command, `
    + `autoInject=${config.autoInject}, autoReflect=${config.autoReflect}, `
    + `lambda=${config.weights.lambda}, alpha=${config.weights.alpha}, budget=${config.weights.tokenBudget}`,
  )
}
