/**
 * The slice of the DeepSeek Harness API this plugin uses.
 *
 * The plugin ships with no runtime dependencies: on the machines this targets the
 * harness owns the profile and there is no registry access to install
 * `@deepseek-ai/*` peers. These interfaces therefore describe the harness
 * structures the plugin consumes exactly, so the code stays typed without
 * importing the packages.
 *
 * Every type here mirrors a published harness type at the version in
 * `README.md`; a wider object (the real `Context`, `Agent`, or message) is
 * structurally assignable to it.
 *
 * @module dsh-token-tree/plugin/dsh
 */

/** printf-style logger, as provided by `ctx.logger`. */
export interface LoggerLike {
  /** Informational line. */
  info(format: unknown, ...params: unknown[]): void
  /** Recoverable problem. */
  warn(format: unknown, ...params: unknown[]): void
  /** Developer detail, hidden by default. */
  debug(format: unknown, ...params: unknown[]): void
  /** Failed operation. */
  error(format: unknown, ...params: unknown[]): void
}

/** One model-facing content block. */
export interface ContentBlockLike {
  /** Block discriminator; the plugin only reads and writes `text`. */
  readonly type: string
  /** Text of a `text` block. */
  readonly text?: string
  /** Any further block fields, preserved untouched. */
  readonly [key: string]: unknown
}

/** Producer identity of a message. */
export interface MessageSourceLike {
  /** Producer discriminant. */
  readonly kind: string
  /** Further producer fields, preserved untouched. */
  readonly [key: string]: unknown
}

/** A user-role message, as `agent.inject()` requires. */
export interface UserMessageLike {
  /** Stable message identity. */
  readonly id: string
  /** Always `user` for injected context. */
  readonly role: 'user'
  /** Model-facing blocks. */
  readonly content: ContentBlockLike[]
  /** Producer identity; the plugin tags its own injections. */
  readonly source: MessageSourceLike
}

/** The durable session log head the plugin reads ids from. */
export interface SessionLike {
  /** Session identity; also the tree key. */
  readonly id: string
  /**
   * Read the session's committed events.
   *
   * A resumed session does not re-emit its history through `session/event`, so this
   * is the only way to rebuild derived state after a restart. The host marks the
   * synchronous readers deprecated for in-tree code; an out-of-tree plugin has no
   * other reader until the event stream itself replays.
   */
  snapshotEvents?(): readonly SessionEventLike[]
}

/** The live agent handle the plugin uses to queue context. */
export interface AgentLike {
  /** Agent-scoped context: the place to restrict that agent's tools. */
  readonly ctx?: ContextLike

  /** Agent identity. */
  readonly id: string
  /** Backing session. */
  readonly session: SessionLike
  /** Queue model-facing context for a later pre-step. */
  inject(message: UserMessageLike): void
}

/** Execution context handed to a tool body. */
export interface ToolRunContextLike {
  /** Provider call id. */
  readonly callId?: string
  /** Tool name. */
  readonly name: string
  /** Parsed model arguments. */
  readonly arguments?: unknown
  /** Owning agent; absent for direct registry callers. */
  readonly agent?: AgentLike
  /** Caller-owned cancellation. */
  readonly signal?: AbortSignal
}

/** Canonical output declaration of a tool. */
export interface ToolOutputLike {
  /** Raw JSON Schema enforced against the returned value. */
  readonly schema: Record<string, unknown>
  /** Pure projection of a validated value to model content. */
  render(args: unknown, value: unknown): ContentBlockLike[]
}

/** A registered tool definition. */
export interface ToolDefinitionLike {
  /** Unique tool name. */
  readonly name: string
  /** Model-facing description. */
  readonly description: string
  /** Raw JSON Schema of the arguments. */
  readonly parameters: Record<string, unknown>
  /** Canonical output declaration. */
  readonly output: ToolOutputLike
  /** Run one accepted call. */
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>
}

/** The scoped tool registry. */
export interface ToolRegistryLike {
  /** Add a tool; the returned disposer removes it. */
  register(definition: ToolDefinitionLike): () => void
  /**
   * Remove tools from this context's scope.
   *
   * The weakest mechanism the host offers for hiding a tool, and the only one that keeps the
   * schema, the name lookup and the execution path aligned.
   * @param filter - allow/deny masks by tool name.
   * @returns A disposer, or nothing.
   */
  restrict?(filter: { allow?: readonly string[]; deny?: readonly string[] }): unknown
}

/** One durable session event envelope. */
export interface SessionEventLike {
  /** Event discriminator. */
  readonly type: string
  /** Monotonic sequence number. */
  readonly seq: number
  /** Wall-clock time in epoch milliseconds. */
  readonly time: number
  /** Event payload; narrowed by `type` at the call site. */
  readonly data: Record<string, unknown>
}

/** `agent/pre-step` payload. */
export interface PreStepPayloadLike {
  /** Owning agent. */
  readonly agent: AgentLike
  /** Messages claimed for this step. */
  readonly messages: UserMessageLike[]
  /** Turn number. */
  readonly turn: number
  /** Step number within the turn. */
  readonly step: number
}

/** `agent/pre-step` decision. */
export type PreStepDecisionLike =
  | { readonly kind: 'reject' }
  | { readonly kind: 'enter'; readonly messages: UserMessageLike[]; readonly startsRequestSeries?: true }

/** `agent/turn-stopping` payload. */
export interface TurnStoppingPayloadLike {
  /** Owning agent. */
  readonly agent: AgentLike
  /** Turn number. */
  readonly turn: number
}

/** The live agent registry. */
export interface AgentRegistryLike {
  /** Look up an agent by session id. */
  get(id: string): AgentLike | undefined
  /** Root agents, i.e. those without a parent agent. */
  roots?(): AgentLike[]
}

/**
 * The context handed to `apply`.
 *
 * Only the members this plugin uses are declared; event names are narrowed to
 * the handlers registered in `hooks.ts`.
 */
/** One `/command` invocation handed to a handler. */
export interface CommandInvocationLike {
  /** Agent that ran the command. */
  readonly agent: AgentLike
  /** Text typed after the command name. */
  readonly rawInput: string
}

/** Result a command handler settles with; the adapter renders `text` outside model history. */
export interface CommandResultLike {
  /** Whether the command succeeded. */
  readonly kind: 'success' | 'error'
  /** Text the UI shows. */
  readonly text: string
}

/** One human-command definition. */
export interface CommandDefinitionLike {
  /** Stable plugin-namespaced identity for adapters. */
  readonly definitionId: string
  /** Lowercase command name, without the slash. */
  readonly name: string
  /** Discovery description. */
  readonly description: string
  /** Run the command. */
  handler(invocation: CommandInvocationLike): CommandResultLike | Promise<CommandResultLike>
}

/** The human-command registry. */
export interface CommandRegistryLike {
  /** Add a command; the returned disposer removes it. */
  register(definition: CommandDefinitionLike): () => void
}

/** One exact HTTP route mounted under the shared `/api` prefix. */
export interface ConnectionFetchRouteLike {
  /** Absolute path below `/api`, e.g. `/api/token-tree/tree`. */
  readonly path: string
  /** Methods the route answers. */
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  /** Body handling; `buffered` hands the handler a complete `Request`. */
  readonly requestBody: 'buffered'
  /** Produce the response for one admitted request. */
  fetch(request: Request): Promise<Response>
}

/**
 * The host web connection.
 *
 * Only the exact fetch route registry is used. The `/api` channel carries a single
 * interceptor slot owned by the Typert gateway; registering there replaces it and
 * makes every other RPC answer 404, so this plugin stays off that channel.
 */
export interface ConnectionLike {
  /** Exact routes, matched before the shared channel's interceptor. */
  readonly fetch: { register(route: ConnectionFetchRouteLike): () => Promise<void> }
}

export interface ContextLike {
  /** Tool registry. */
  readonly tools: ToolRegistryLike
  /** Logger. */
  readonly logger: LoggerLike
  /** Agent registry; optional because headless embeddings may omit it. */
  readonly agents?: AgentRegistryLike
  /** Human-command registry; optional because headless spines provide no command surface. */
  readonly commands?: CommandRegistryLike
  /** Host web connection; absent in headless spines with no browser. */
  readonly connection?: ConnectionLike
  /** Register a durable session-event listener. */
  on(
    event: 'session/event',
    listener: (session: SessionLike, event: SessionEventLike) => void,
  ): () => void
  /** Register a pre-step waterfall listener. */
  on(
    event: 'agent/pre-step',
    listener: (payload: PreStepPayloadLike, next: () => Promise<PreStepDecisionLike>) => Promise<PreStepDecisionLike>,
  ): () => void
  /** Register a turn-stopping listener. */
  on(
    event: 'agent/turn-stopping',
    listener: (payload: TurnStoppingPayloadLike) => void | Promise<void>,
  ): () => void
  /** Register a per-agent creation listener; `agent.ctx` is that agent's scope. */
  on(
    event: 'agent/created',
    listener: (payload: { agent: AgentLike }) => void,
  ): () => void
  /** Register a system-prompt assembly listener; it must call `next()`. */
  on(
    event: 'system-prompt/assemble',
    listener: (assembly: unknown, context: unknown, next: () => unknown) => unknown,
  ): () => void
  /** Register a reversible effect. */
  effect(execute: () => unknown, label?: string): () => void
  /** Publish a service under a name; the returned disposer withdraws it. */
  provide(name: string, value: unknown): () => void
  /** Read an optional service. */
  get?(name: string): unknown
  /** Run a scoped plugin body once the named services are available. */
  inject?(services: readonly string[], callback: (scoped: ContextLike) => void): unknown
}

/**
 * Read the agent registry without declaring it as an injection.
 *
 * Cordis's context property proxy **throws** for a service the plugin did not
 * inject (`cannot get property "agents" without inject`), so an optional service
 * must be read through `ctx.get`. The plugin cannot declare `agents` as a hard
 * dependency: headless and test hosts compose it without an agent registry.
 * @param ctx - plugin context.
 * @returns The registry, or `undefined` when the host has none.
 */
export function agentRegistryOf(ctx: ContextLike): AgentRegistryLike | undefined {
  try {
    const registry = ctx.get?.('agents')
    if (typeof registry !== 'object' || registry === null) return undefined
    return registry as AgentRegistryLike
  } catch {
    return undefined
  }
}
