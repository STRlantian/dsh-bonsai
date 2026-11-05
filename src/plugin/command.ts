/**
 * Slash commands for looking at what the plugin did.
 *
 * A slash command is the cheapest surface for diagnostics: the command registry runs it against the
 * calling agent without creating a model message, and the adapters render the returned text outside
 * model history. No client bundle, no rebuild of the Web shell.
 *
 * `commands` is an optional dependency: headless and test hosts may not provide the registry, and the
 * plugin must still activate without it.
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

/** Compact a number for a terminal line. */
const n = (value: number | undefined): string => (value === undefined ? '-' : String(Math.round(value)))

/** Percent with one decimal, or a dash. */
const pct = (part: number, whole: number): string => (whole <= 0 ? '-' : `${(part / whole * 100).toFixed(1)}%`)

/** Truncate one line of text for display. */
const short = (text: string, limit = 60): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`)

/** One diagnostic command: name, one-line description, and its renderer. */
interface Diagnostic {
  name: string
  description: string
  render: (service: TokenTreeService, sessionId: string) => string
}

const DIAGNOSTICS: Diagnostic[] = [
  {
    name: 'prompt',
    description: 'Last turn\'s prompt shape: sections, tools and the messages the hook saw',
    render: (service, sessionId) => {
      const assembly = service.assemblyOf()
      const probe = service.promptOf(sessionId)
      const lines = ['token-tree: last prompt']
      if (assembly === null && probe === null) return `${lines[0]}\nno assembly recorded yet for this session`
      if (assembly !== null) {
        lines.push(`- system prompt sections: ${assembly.sections.length} · ${n(assembly.totalChars)} chars`)
        for (const section of assembly.sections.slice(0, 6)) lines.push(`    ${section.name.padEnd(22)} ${n(section.chars)} chars`)
        const toolChars = assembly.tools.reduce((sum, tool) => sum + tool.chars, 0)
        lines.push(`- tools: ${assembly.tools.length} · ${n(toolChars)} chars（占 system 的 ${pct(toolChars, assembly.totalChars)}）`)
        for (const tool of [...assembly.tools].sort((left, right) => right.chars - left.chars).slice(0, 5)) {
          lines.push(`    ${tool.name.padEnd(22)} ${n(tool.chars)} chars`)
        }
        for (const part of assembly.parts.slice(0, 6)) lines.push(`- part ${part.name}: ${part.items} item(s), ${n(part.chars)} chars`)
      }
      if (probe !== null) {
        lines.push(`- decision.messages: ${probe.count} message(s), ${n(probe.chars)} chars · kinds: ${probe.kinds.join(', ')}`)
      }
      return lines.join('\n')
    },
  },
  {
    name: 'fold',
    description: 'Last fold decision: block, keep window, threshold and cadence',
    render: (service, sessionId) => {
      const note = service.foldOf(sessionId)
      const hint = service.hintOf(sessionId)
      const lines = ['token-tree: last fold']
      if (note === null) addPlaceholder(lines)
      else {
        lines.push(`- folded: ${note.folded} turn(s) · planned ${n(note.planned)} · visible ${n(note.visible)}`)
        lines.push(`- measured history: ${n(note.tokens)} tokens · block threshold ${n(note.threshold)}`)
        if (typeof note.range === 'string') lines.push(`- detail: ${note.range}`)
        if (typeof note.range !== 'string' || !note.range.includes('cadence')) lines.push(foldVerdict(note))
      }
      lines.push(hint === null
        ? '- hint: none recorded'
        : `- hint: fired=${hint.fired} · counted ${n(hint.counted)} vs gate ${n(hint.above)} · ${hint.reason}`)
      return lines.join('\n')
    },
  },
  {
    name: 'usage',
    description: 'Billed usage of the last answer, plus its cache hit rate',
    render: (service, sessionId) => {
      const usage = service.usageOf(sessionId)
      if (usage === null) return 'token-tree: usage\nno billed usage recorded yet for this session'
      const prompt = usage.input + usage.cached + usage.written
      return [
        'token-tree: last usage',
        `- prompt: ${n(prompt)} tokens = new ${n(usage.input)} + cache hit ${n(usage.cached)} + cache write ${n(usage.written)}`,
        `- output: ${n(usage.output)} tokens · total ${n(usage.total)}`,
        `- cache hit rate: ${pct(usage.cached, prompt)}`,
        `- at: ${new Date(usage.at).toLocaleString()}`,
      ].join('\n')
    },
  },
  {
    name: 'retrieve',
    description: 'Last retrieve_context call: budget, tokens used and what it selected',
    render: (service, sessionId) => {
      const last = service.retrieveOf(sessionId)
      if (last === null) return 'token-tree: retrieve\nno retrieve_context call recorded yet for this session'
      return [
        'token-tree: last retrieve',
        `- query: ${short(last.query)}`,
        `- origin: ${last.originId} · budget ${n(last.budget)} tokens · used ${n(last.tokensUsed)}`,
        `- selected ${n(last.selected)} node(s) · dropped ${n(last.dropped)}`,
        `- ids: ${last.ids.slice(0, 10).join(', ') || '(none)'}`,
      ].join('\n')
    },
  },
]

/** Explain a fold note that did not fold. */
function foldVerdict(note: NonNullable<ReturnType<TokenTreeService['foldOf']>>): string {
  if ((note.folded ?? 0) > 0) return '- verdict: folded'
  if ((note.planned ?? 0) === 0) return '- verdict: nothing eligible outside the keep window'
  return '- verdict: planned folds were rejected (see detail above)'
}

/** Add the "nothing folded yet" line. */
function addPlaceholder(lines: string[]): void {
  lines.push('- no fold has been attempted for this session yet')
  lines.push('- folding waits for the block to reach the threshold and the keep-window ratio')
}

/**
 * Register `/tree` and the diagnostic commands when the host provides a command registry.
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

    for (const diagnostic of DIAGNOSTICS) {
      scoped.effect(() => commands.register({
        definitionId: `dsh-token-tree/${diagnostic.name}`,
        name: diagnostic.name,
        description: diagnostic.description,
        handler: (invocation) => {
          try {
            return { kind: 'success', text: diagnostic.render(service, invocation.agent.session.id) }
          } catch (error) {
            return { kind: 'error', text: `token-tree: ${describe(error)}` }
          }
        },
      }), `token-tree: /${diagnostic.name} command`)
    }
  }

  // `ctx.inject` waits for the service; a bare property read would race the
  // registry's activation. Hosts without commands (tests, minimal spines) simply
  // never call back.
  if (ctx.inject !== undefined) ctx.inject(['commands'], register)
  else register(ctx)
}
