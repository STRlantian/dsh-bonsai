/**
 * The `/tree` human command.
 *
 * A slash command is the cheapest surface that puts the tree in front of the
 * user: the command registry runs it against the calling agent without creating a
 * model message, and shipped adapters render the returned text in the UI outside
 * model history. No client bundle, no rebuild of the Web shell.
 *
 * `commands` is an optional dependency: headless and test hosts may not provide
 * the registry, and the plugin must still activate without it.
 *
 * @module dsh-token-tree/plugin/command
 */

import type { CommandRegistryLike, ContextLike } from './dsh.ts'
import type { TokenTreeService } from './service.ts'
import { renderTree } from './render.ts'
import { describe } from './hooks.ts'

/** Command name, without the leading slash. */
export const COMMAND_NAME = 'tree'

/** Stable, plugin-namespaced definition identity for adapters. */
export const COMMAND_DEFINITION_ID = 'dsh-token-tree/tree'

/**
 * Register the `/tree` command when the host provides a command registry.
 * @param ctx - plugin context.
 * @param service - session memory service.
 */
export function installCommand(ctx: ContextLike, service: TokenTreeService): void {
  const register = (scoped: ContextLike): void => {
    const commands: CommandRegistryLike | undefined = scoped.commands
    if (commands === undefined) return
    scoped.effect(() => commands.register({
      definitionId: COMMAND_DEFINITION_ID,
      name: COMMAND_NAME,
      description: 'Show the weighted conversation tree of this session',
      handler: (invocation) => {
        try {
          const sessionId = invocation.agent.session.id
          const input = invocation.rawInput.trim()
          // `/tree go <id>` anchors the next turn there; `/tree clear` drops it;
          // a bare id keeps the historical behaviour of viewing from that node.
          const go = /^go\s+(\S+)$/i.exec(input)
          if (go !== null) {
            const anchored = service.focus(sessionId, go[1])
            return {
              kind: 'success',
              text: `token-tree: next question will hang under ${anchored.nodeId} (${anchored.kind}, `
                + `${anchored.children} child(ren)): ${anchored.preview}\n`
                + 'Ask it in the chat box; the anchor applies to exactly one turn.',
            }
          }
          if (input.toLowerCase() === 'clear') {
            const had = service.unfocus(sessionId)
            return {
              kind: 'success',
              text: had
                ? 'token-tree: manual anchor cleared; the next turn attaches automatically again.'
                : 'token-tree: no manual anchor was pending.',
            }
          }
          return {
            kind: 'success',
            text: renderTree(service.treeOf(sessionId), {
              constraints: service.constraintsOf(sessionId).map(entry => entry.text),
              ...(input.length === 0 ? {} : { nodeId: input }),
            }),
          }
        } catch (error) {
          return { kind: 'error', text: `token-tree: ${describe(error)}` }
        }
      },
    }), 'token-tree: /tree command')
  }

  // `ctx.inject` waits for the service; a bare property read would race the
  // registry's activation. Hosts without commands (tests, minimal spines) simply
  // never call back.
  if (ctx.inject !== undefined) ctx.inject(['commands'], register)
  else register(ctx)
}
