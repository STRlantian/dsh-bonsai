import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, blocksOf, Config, inject, name } from '../src/index.ts'
import type { ContextLike, SessionEventLike, UserMessageLike } from '../src/plugin/dsh.ts'
import type { ResolvedConfig } from '../src/plugin/config.ts'
import { SettingsStore } from '../src/plugin/settings.ts'
import type { TokenTreeService } from '../src/plugin/service.ts'

/** Resolve the default configuration the way the loader would. */
function defaults(): ResolvedConfig {
  const result = Config['~standard'].validate({})
  assert.ok(result.value !== undefined)
  return result.value
}

/** A harness stand-in: registry, event bus, logger, and one agent. */
class FakeHarness {
  readonly handlers = new Map<string, ((...args: never[]) => unknown)[]>()
  readonly tools = new Map<string, unknown>()
  readonly services = new Map<string, unknown>()
  readonly commands = new Map<string, { handler: (invocation: { agent: unknown; rawInput: string }) => unknown }>()
  readonly logs: string[] = []
  readonly injected: UserMessageLike[] = []
  readonly agent = {
    id: 'agent-1',
    session: { id: 'session-1' },
    inject: (message: UserMessageLike) => { this.injected.push(message) },
  }

  readonly ctx: ContextLike

  constructor() {
    const self = this
    this.ctx = {
      tools: {
        register(definition) {
          self.tools.set(definition.name, definition)
          return () => { self.tools.delete(definition.name) }
        },
      },
      logger: {
        info: (format: unknown) => { self.logs.push(String(format)) },
        warn: (format: unknown) => { self.logs.push(`WARN ${String(format)}`) },
        debug: () => {},
        error: () => {},
      },
      agents: {
        get: (id: string) => (id === self.agent.session.id ? self.agent : undefined),
        roots: () => [self.agent],
      },
      on: ((event: string, listener: (...args: never[]) => unknown) => {
        const list = self.handlers.get(event) ?? []
        list.push(listener)
        self.handlers.set(event, list)
        return () => {}
      }) as ContextLike['on'],
      effect: (execute: () => unknown) => {
        execute()
        return () => {}
      },
      provide: (serviceName: string, value: unknown) => {
        self.services.set(serviceName, value)
        return () => {}
      },
      commands: {
        register(definition) {
          self.commands.set(definition.name, definition)
          return () => { self.commands.delete(definition.name) }
        },
      },
      inject: (services: readonly string[], callback: (scoped: ContextLike) => void) => {
        if (services.includes('commands')) callback(self.ctx)
        return undefined
      },
      // Optional services are read through `get`, never through the property proxy
      // (which throws for a service the plugin did not inject).
      get: (name: string) => {
        if (name === 'agents') return self.ctx.agents
        if (name === 'commands') return self.ctx.commands
        return undefined
      },
    }
  }

  /** Deliver one ordinary event. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) (listener as (...input: unknown[]) => unknown)(...args)
  }

  /** Deliver one waterfall event and return the decision it produced. */
  async waterfall(event: string, payload: unknown, next: () => Promise<unknown>): Promise<unknown> {
    const listeners = (this.handlers.get(event) ?? []) as unknown as ((input: unknown, proceed: () => Promise<unknown>) => Promise<unknown>)[]
    let proceed = next
    for (let index = listeners.length - 1; index >= 0; index--) {
      const listener = listeners[index]
      const inner = proceed
      proceed = () => listener(payload, inner)
    }
    return proceed()
  }

  /** The service the plugin published. */
  get service(): TokenTreeService {
    return this.services.get('tokenTree') as TokenTreeService
  }
}

/** Deliver one durable session event. */
function sessionEvent(harness: FakeHarness, type: string, data: Record<string, unknown>): void {
  const event: SessionEventLike = { type, seq: 1, time: Date.now(), data }
  harness.emit('session/event', { id: 'session-1' }, event)
}

/** Answer payload. */
function assistant(text: string): Record<string, unknown> {
  return { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

/** Tool result payload. */
function toolResult(callId: string, text: string, isError: boolean): Record<string, unknown> {
  return {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError },
    ...(isError ? { error: { name: 'ToolError', code: 'ETIMEDOUT' } } : {}),
  }
}

/** Ask one learner question. */
function ask(harness: FakeHarness, text: string): void {
  sessionEvent(harness, 'user/message', {
    id: `q-${text.length}-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** Deliver one assistant answer. */
function tell(harness: FakeHarness, text: string): void {
  sessionEvent(harness, 'assistant/message', assistant(text))
}

/** Mount the plugin against the fake harness. */
function mount(config: ResolvedConfig = defaults()): { harness: FakeHarness; service: TokenTreeService } {
  const harness = new FakeHarness()
  // In-memory stores: the suite must never read or write the user's real settings file.
  const files = new Map<string, string>()
  const io = {
    readFile: (path: string) => files.get(path) ?? '{}',
    writeFile: (path: string, text: string) => { files.set(path, text) },
    exists: (path: string) => files.has(path),
    makeDir: () => {},
  }
  const settings = new SettingsStore({ path: 'mem://settings.json', io, onError: () => {} })
  apply(harness.ctx, config, { settings })
  return { harness, service: harness.service }
}

test('the plugin exports the function-plugin contract', () => {
  assert.equal(name, 'dsh-bonsai')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('mounting never touches an undeclared service property', () => {
  // Cordis's context proxy throws on `ctx.agents` unless the plugin injected it:
  // "cannot get property \"agents\" without inject". Optional services must be read
  // through `ctx.get`, so this context makes the property throw on purpose.
  const harness = new FakeHarness()
  const registry = { get: () => undefined, roots: () => [] }
  const base = harness.ctx as unknown as Record<string, unknown>
  const strict = { ...base } as unknown as ContextLike & Record<string, unknown>
  strict.get = (serviceName: string) => (serviceName === 'agents' ? registry : undefined)
  Object.defineProperty(strict, 'agents', {
    configurable: true,
    get() { throw new Error('cannot get property "agents" without inject') },
  })

  assert.doesNotThrow(() => apply(strict, defaults()))
  assert.ok(harness.tools.size > 0, 'tools still registered')
})

test('Config validates and resolves defaults', () => {
  const resolved = defaults()
  assert.equal(resolved.weights.lambda, 0.5)
  assert.equal(resolved.loop.maxSteps, 12)
  // Tool-first default: the block is opt-in, the one-line hint is not.
  assert.equal(resolved.autoInject, false)
  assert.equal(resolved.retrievalHint, true)
  assert.equal(resolved.attachments, 'semantic')

  const overridden = Config['~standard'].validate({ weights: { lambda: 0.9, combine: 'product' }, autoInject: true })
  assert.ok(overridden.value !== undefined)
  assert.equal(overridden.value.weights.lambda, 0.9)
  assert.equal(overridden.value.weights.combine, 'product')
  assert.equal(overridden.value.autoInject, true)

  const invalid = Config['~standard'].validate({ weights: { lambda: 'fast' }, autoReflect: 'yes' })
  assert.ok(invalid.issues !== undefined)
  assert.ok(invalid.issues.length >= 2)
})

test('mounting registers every tool and publishes the service', () => {
  const { harness } = mount()
  assert.deepEqual([...harness.tools.keys()].sort(), [
    'retrieve_context',
    'tree_backtrack',
    'tree_focus',
    'tree_mark',
    'tree_query',
    'tree_reflect',
  ])
  assert.ok(harness.service !== undefined)
  assert.ok(harness.logs.some(line => line.includes('token-tree: mounted')))
})

test('session events build the tree', () => {
  const { harness, service } = mount()
  sessionEvent(harness, 'turn/start', { turn: 1 })
  sessionEvent(harness, 'step/start', { turn: 1, step: 1 })
  ask(harness, 'What is attention?')
  tell(harness, 'Attention weights tokens by relevance.')
  sessionEvent(harness, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{"q":"attention"}' })
  sessionEvent(harness, 'tool/result', toolResult('c1', 'search results', false))

  const state = service.stateOf('session-1')
  assert.equal(state.tree.nodes.size, 4)
  const kinds = [...state.tree.nodes.values()].map(node => node.kind).sort()
  assert.deepEqual(kinds, ['answer', 'note', 'question', 'tool_result'])
  assert.equal(state.observations.length, 1)
  assert.equal(state.observations[0].ok, true)
})

test('a failed tool raises its edge cost and writes a failed observation', () => {
  const { harness, service } = mount()
  sessionEvent(harness, 'turn/start', { turn: 1 })
  ask(harness, 'What is attention?')
  tell(harness, 'Let me search.')
  sessionEvent(harness, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{"q":"attention"}' })
  sessionEvent(harness, 'tool/result', toolResult('c1', 'timeout', true))

  const state = service.stateOf('session-1')
  const toolNode = [...state.tree.nodes.values()].find(node => node.kind === 'tool_result')
  assert.ok(toolNode !== undefined)
  const edge = state.tree.edge(toolNode.parentId as string, toolNode.id)
  assert.ok(edge !== undefined)
  assert.equal(edge.lastReason, 'tool/failure')
  assert.ok(edge.cost >= service.config.weights.failureDelta)
  assert.equal(state.observations.at(-1)?.ok, false)
  assert.ok(harness.logs.some(line => line.includes('tool/failure')))

  // A later success on the same branch lowers the cost again.
  sessionEvent(harness, 'tool/call', { turn: 1, step: 2, callId: 'c2', name: 'web_search', arguments: '{"q":"attention"}' })
  sessionEvent(harness, 'tool/result', toolResult('c2', 'ok', false))
  const successNode = [...state.tree.nodes.values()].filter(node => node.kind === 'tool_result').at(-1)
  assert.ok(successNode !== undefined)
  const successEdge = state.tree.edge(successNode.parentId as string, successNode.id)
  assert.equal(successEdge?.lastReason, 'tool/success')
})

test('tool results stay leaves and harness context is not a question', () => {
  const { harness, service } = mount()
  sessionEvent(harness, 'turn/start', { turn: 1 })
  ask(harness, 'What is attention?')
  tell(harness, 'Let me search.')
  sessionEvent(harness, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{"q":"attention"}' })
  sessionEvent(harness, 'tool/result', toolResult('c1', 'search results', false))

  const state = service.stateOf('session-1')
  const answer = [...state.tree.nodes.values()].find(node => node.kind === 'answer')
  assert.ok(answer !== undefined)
  // The tool result must not steal the dialogue focus.
  assert.equal(state.tree.currentId, answer.id)

  // Harness bookkeeping arrives as a user-role message but is not a question.
  sessionEvent(harness, 'user/message', {
    id: 'ctx',
    role: 'user',
    content: [{ type: 'text', text: 'Current runtime context. (snapshot)' }],
    source: { kind: 'runtime-context' },
  })
  assert.equal([...state.tree.nodes.values()].filter(node => node.kind === 'question').length, 1)

  // A real follow-up branches under the same answer, beside the tool result.
  ask(harness, 'What is a token? What does it mean?')
  const questions = [...state.tree.nodes.values()].filter(node => node.kind === 'question')
  assert.equal(questions.length, 2)
  const followUp = questions.at(-1)
  assert.ok(followUp !== undefined)
  assert.equal(followUp.parentId, answer.id)
  const children = state.tree.node(answer.id).children.map(child => state.tree.node(child).kind)
  assert.deepEqual(children, ['tool_result', 'question'])
})

test('a follow-up about a term branches from the answer that introduced it', () => {
  const { harness, service } = mount()
  const state = service.stateOf('session-1')

  ask(harness, '什么是注意力机制？')
  tell(harness, '注意力用查询和键的相似度给值加权求和，其中 token 是基本单位。')
  const attention = [...state.tree.nodes.values()].find(node => node.kind === 'answer')
  assert.ok(attention !== undefined)

  ask(harness, '其中的 token 是什么？')
  tell(harness, 'token 是分词器切分出来的最小文本单位。')

  // This question is about the FIRST answer, not the last one.
  ask(harness, '注意力里的查询和键分别是什么意思？')

  const questions = [...state.tree.nodes.values()].filter(node => node.kind === 'question')
  assert.equal(questions.length, 3)
  const followUp = questions.at(-1)
  assert.ok(followUp !== undefined)
  assert.equal(followUp.parentId, attention.id)
  assert.equal(followUp.metadata.attached, 'semantic')
  const branching = state.tree.node(attention.id).children
    .filter(child => state.tree.node(child).kind === 'question')
  assert.equal(branching.length, 2)
  assert.ok(harness.logs.some(line => line.includes('question attached to')))
})

test('a term from an earlier topic pulls the follow-up back to that branch', () => {
  const { harness, service } = mount()
  const state = service.stateOf('session-1')

  ask(harness, '向我介绍线段树，不要太长')
  tell(harness, '线段树是一棵二叉树，每个节点代表数组的一个区间，支持区间查询与区间修改，复杂度 O(log n)。')
  const segmentAnswer = [...state.tree.nodes.values()].find(node => node.kind === 'answer')
  assert.ok(segmentAnswer !== undefined)

  ask(harness, '介绍如何编写 daw 的 vst，简单介绍')
  tell(harness, '编写 DAW 插件（VST）入门：先区分 VST 与宿主，再选 JUCE 框架，实现 processBlock 处理音频。')

  // 这条追问讲的是线段树，不是刚说的 VST：必须回到线段树分支。
  ask(harness, '向我介绍可持续化线段树')
  tell(harness, '可持久化线段树在修改时保留旧版本，因此可以查询任意历史状态。')

  const questions = [...state.tree.nodes.values()].filter(node => node.kind === 'question')
  const followUp = questions.at(-1)
  assert.ok(followUp !== undefined)
  // In the tree a question hangs under the answer that introduced the term...
  assert.equal(followUp.parentId, segmentAnswer.id)
  assert.equal(followUp.metadata.attached, 'semantic')
  assert.ok(Number(followUp.metadata.attachScore) > 0.3)
  // ...and in the block view it appears beside the segment-tree block.
  const payload = blocksOf(state.tree)
  const block = payload.blocks.find(entry => entry.id === followUp.id)
  assert.ok(block !== undefined)
  assert.equal(block.parentId, segmentAnswer.parentId)
  assert.equal(block.origin, 'auto')
})

test('a question with nothing in common starts a new top-level branch', () => {
  const { harness, service } = mount()
  const state = service.stateOf('session-1')

  ask(harness, '向我介绍 dijkstra 算法')
  tell(harness, 'Dijkstra 解决单源最短路径：每次取出距离最小的节点并松弛它的出边，时间复杂度 O(E log V)。')
  ask(harness, '什么是复杂度')
  tell(harness, '复杂度描述输入规模变大时资源增长的速度，分时间复杂度和空间复杂度。')
  ask(harness, '向我介绍线段树')
  tell(harness, '线段树是一棵二叉树，每个节点代表数组的一个区间，支持区间查询与区间修改。')

  const questions = [...state.tree.nodes.values()].filter(node => node.kind === 'question')
  assert.equal(questions.length, 3)
  const third = questions.at(-1)
  assert.ok(third !== undefined)
  assert.equal(third.parentId, state.tree.rootId)
  assert.equal(state.tree.node(state.tree.rootId).children.length, 2)
  assert.ok(harness.logs.some(line => line.includes('new topic branch')))
})

test('the /tree command renders the tree for the calling agent', async () => {
  const { harness, service } = mount()
  const state = service.stateOf('session-1')
  state.tree.addNode({ kind: 'question', content: '什么是注意力机制？', timestamp: 1_000 })
  state.tree.addNode({ kind: 'answer', content: '注意力按相关性加权求和。', timestamp: 2_000 })

  const command = harness.commands.get('tree')
  assert.ok(command !== undefined)
  const result = await command.handler({ agent: harness.agent, rawInput: '' }) as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.match(result.text, /token-tree . 3 nodes/)
  assert.match(result.text, /\[question\]/)
  assert.match(result.text, /\[answer\]/)
  assert.match(result.text, /focus/)

  const missing = await command.handler({ agent: harness.agent, rawInput: 'n99' }) as { kind: string; text: string }
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /unknown node/)
})

test('retrieve_context scores the buffer and queues it for the next step', async () => {
  const { harness, service } = mount()
  const state = service.stateOf('session-1')
  state.tree.addNode({ kind: 'question', content: 'What is attention?', timestamp: 1_000 })
  const answer = state.tree.addNode({ kind: 'answer', content: 'Attention computes a weighted sum over token vectors.', timestamp: 2_000 })
  state.tree.addNode({ kind: 'answer', content: 'Beijing winter weather is cold and dry.', timestamp: 3_000 })
  state.tree.moveTo(answer.id)

  const tool = harness.tools.get('retrieve_context') as { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> }
  const result = await tool.execute({ query: 'attention token weight' }, { name: 'retrieve_context', agent: harness.agent })

  const selected = result.selected as { nodeId: string; weight: number }[]
  assert.ok(selected.length >= 1)
  assert.ok(selected.some(node => node.nodeId === answer.id))
  assert.equal(result.injected, true)
  assert.equal(harness.injected.length, 1)
  assert.ok(harness.injected[0].content[0].text?.startsWith('[token-tree memory]'))
})

test('the supervisor reflects, backtracks to the better sibling, and queues guidance', () => {
  const { harness, service } = mount()
  sessionEvent(harness, 'turn/start', { turn: 1 })
  sessionEvent(harness, 'step/start', { turn: 1, step: 1 })
  ask(harness, 'How do I compute attention weights?')
  tell(harness, 'Call the search tool.')
  sessionEvent(harness, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{"q":"attention"}' })
  sessionEvent(harness, 'tool/result', toolResult('c1', 'timeout', true))
  sessionEvent(harness, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'web_search', arguments: '{"q":"attention"}' })
  sessionEvent(harness, 'tool/result', toolResult('c2', 'timeout again', true))

  const state = service.stateOf('session-1')
  const answerNode = [...state.tree.nodes.values()].find(node => node.kind === 'answer')
  assert.ok(answerNode !== undefined)
  const better = state.tree.addNode({
    kind: 'answer',
    content: 'Compute the scaled dot product locally instead.',
    parentId: answerNode.id,
    metadata: { pinned: true },
    timestamp: Date.now(),
  })
  state.tree.addNode({
    kind: 'tool_result',
    content: 'calculator returned 0.42',
    parentId: better.id,
    metadata: { ok: true, toolName: 'calc' },
    timestamp: Date.now(),
  })

  harness.emit('agent/turn-stopping', { agent: harness.agent, turn: 1 })

  assert.equal(harness.injected.length, 1)
  assert.ok(harness.injected[0].content[0].text?.startsWith('[token-tree supervisor]'))
  assert.equal(state.tree.currentId, better.id)
  assert.equal(state.reflections, 1)
  assert.equal(state.backtracks, 1)
  assert.ok([...state.tree.nodes.values()].some(node => node.kind === 'reflection'))
  assert.ok(harness.logs.some(line => line.includes('supervisor failed')))
})

test('the pre-step hook prepends exactly one memory block', async () => {
  // Injection is opt-in now, so this test asks for it explicitly. Admission is opened
  // up because this case is about the hook wiring, not about relevance gating.
  const base = defaults()
  const { harness, service } = mount({
    ...base,
    autoInject: true,
    weights: { ...base.weights, admitRelevance: 0 },
  })
  const state = service.stateOf('session-1')
  state.tree.addNode({ kind: 'question', content: 'What is attention?', timestamp: 1_000 })
  state.tree.addNode({ kind: 'answer', content: 'Attention weights token vectors by relevance.', timestamp: 2_000 })

  const userMessage = {
    id: 'm1',
    role: 'user' as const,
    content: [{ type: 'text', text: 'How does attention use tokens?' }],
    source: { kind: 'user' },
  }
  const decision = await harness.waterfall(
    'agent/pre-step',
    { agent: harness.agent, messages: [userMessage], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [userMessage] }),
  ) as { kind: string; messages: UserMessageLike[] }

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0].id, 'm1')
  assert.equal(decision.messages[1].source.kind, 'token-tree')

  // A later step of the same turn is left alone.
  const later = await harness.waterfall(
    'agent/pre-step',
    { agent: harness.agent, messages: [userMessage], turn: 1, step: 3 },
    async () => ({ kind: 'enter', messages: [userMessage] }),
  ) as { messages: UserMessageLike[] }
  assert.equal(later.messages.length, 1)
})

test('with injection off the hook appends one short retrieval hint instead', async () => {
  const { harness, service } = mount({ ...defaults(), autoInject: false, retrievalHint: true })
  const state = service.stateOf('session-1')
  // The hint is suppressed while the tree is still trivial.
  const userMessage = {
    id: 'm1',
    role: 'user' as const,
    content: [{ type: 'text', text: 'how does this work?' }],
    source: { kind: 'user' },
  }
  const early = await harness.waterfall(
    'agent/pre-step',
    { agent: harness.agent, messages: [userMessage], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [userMessage] }),
  ) as { messages: UserMessageLike[] }
  assert.equal(early.messages.length, 1, 'no hint before there is anything to retrieve')

  for (let index = 0; index < 6; index += 1) {
    state.tree.addNode({ kind: 'question', content: `q${index}`, timestamp: 1_000 + index })
    state.tree.addNode({ kind: 'answer', content: `a${index}`, timestamp: 1_500 + index })
  }

  // 12 nodes is still below `hintMinNodes`: a short conversation carries its whole
  // history, so paying for the hint every turn buys nothing (measured three times).
  const shortConversation = await harness.waterfall(
    'agent/pre-step',
    { agent: harness.agent, messages: [userMessage], turn: 2, step: 1 },
    async () => ({ kind: 'enter', messages: [userMessage] }),
  ) as { messages: UserMessageLike[] }
  assert.equal(shortConversation.messages.length, 1, 'no hint while the history still fits')

  // A compaction is the moment the hint starts to earn its tokens.
  state.compacted = true
  const decision = await harness.waterfall(
    'agent/pre-step',
    { agent: harness.agent, messages: [userMessage], turn: 3, step: 1 },
    async () => ({ kind: 'enter', messages: [userMessage] }),
  ) as { messages: UserMessageLike[] }
  assert.equal(decision.messages.length, 2)
  const hint = JSON.stringify(decision.messages[1])
  assert.ok(hint.includes('retrieve_context'), 'hint names the tool')
  assert.ok(hint.length < 1200, 'hint stays small')

  // Turning the hint off leaves the step untouched.
  const silent = mount({ ...defaults(), autoInject: false, retrievalHint: false })
  const silentState = silent.service.stateOf('session-1')
  for (let index = 0; index < 6; index += 1) {
    silentState.tree.addNode({ kind: 'question', content: `q${index}`, timestamp: 1_000 + index })
  }
  const quiet = await silent.harness.waterfall(
    'agent/pre-step',
    { agent: silent.harness.agent, messages: [userMessage], turn: 2, step: 1 },
    async () => ({ kind: 'enter', messages: [userMessage] }),
  ) as { messages: UserMessageLike[] }
  assert.equal(quiet.messages.length, 1)
})

test('tree_mark and tree_backtrack act on the tree', async () => {
  const { harness, service } = mount()
  const state = service.stateOf('session-1')
  const question = state.tree.addNode({ kind: 'question', content: 'What is attention?', timestamp: 1_000 })
  const first = state.tree.addNode({ kind: 'answer', content: 'First branch', timestamp: 2_000 })
  state.tree.addNode({ kind: 'tool_result', content: 'failed', parentId: first.id, metadata: { ok: false }, timestamp: 3_000 })
  const second = state.tree.addNode({ kind: 'answer', content: 'Second branch', parentId: question.id, metadata: { pinned: true }, timestamp: 4_000 })
  state.tree.moveTo(first.id)

  const mark = harness.tools.get('tree_mark') as { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> }
  const marked = await mark.execute({ nodeId: second.id, pinned: true }, { name: 'tree_mark', agent: harness.agent })
  assert.equal(marked.pinned, true)

  const backtrack = harness.tools.get('tree_backtrack') as { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> }
  const preview = await backtrack.execute({ fromNodeId: first.id, dryRun: true }, { name: 'tree_backtrack', agent: harness.agent })
  assert.equal(preview.applied, false)
  assert.equal(preview.targetId, second.id)

  const applied = await backtrack.execute({ fromNodeId: first.id }, { name: 'tree_backtrack', agent: harness.agent })
  assert.equal(applied.applied, true)
  assert.equal(state.tree.currentId, second.id)
})

test('tools reject a caller with no owning agent', async () => {
  const { harness } = mount()
  const tool = harness.tools.get('tree_query') as { execute(args: unknown, exec: unknown): Promise<unknown> }
  await assert.rejects(() => tool.execute({}, { name: 'tree_query' }), /owning agent session/)
})

test('a user-picked anchor adopts exactly the next question', () => {
  const { harness, service } = mount()
  ask(harness, '第一个问题：什么是二分查找？')
  tell(harness, '二分查找在有序数组上每次折半。')
  ask(harness, '第二个问题：为什么要求有序？')
  tell(harness, '因为每次折半要靠大小关系判断方向。')

  const tree = service.treeOf('session-1')
  const questions = [...tree.nodes.values()].filter(node => node.kind === 'question')
  assert.equal(questions.length, 2)
  const anchor = questions[0]

  const anchored = service.focus('session-1', anchor.id)
  assert.equal(anchored.nodeId, anchor.id)
  assert.equal(service.anchoredNode('session-1'), anchor.id)

  ask(harness, '从第一个问题接着问：边界怎么写？')
  const after = [...tree.nodes.values()].filter(node => node.kind === 'question')
  assert.equal(after.length, 3)
  const adopted = after[2]
  assert.equal(adopted.parentId, anchor.id, 'hung under the picked node')
  assert.equal(adopted.metadata.attached, 'manual')
  assert.equal(service.anchoredNode('session-1'), undefined, 'cleared after one turn')

  // The turn after that goes back to automatic placement.
  tell(harness, '边界用左闭右开。')
  ask(harness, '第三个问题：复杂度多少？')
  const latest = [...tree.nodes.values()].filter(node => node.kind === 'question')[3]
  assert.notEqual(latest.metadata.attached, 'manual')
})

test('tree_focus tool anchors and clears', async () => {
  const { harness, service } = mount()
  ask(harness, '先问一个问题')
  tell(harness, '先给一个回答')
  const first = [...service.treeOf('session-1').nodes.values()].find(node => node.kind === 'question')
  assert.ok(first !== undefined)

  const focus = harness.tools.get('tree_focus') as { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> }
  const anchored = await focus.execute({ nodeId: first.id }, { name: 'tree_focus', agent: harness.agent })
  assert.equal(anchored.nodeId, first.id)

  const cleared = await focus.execute({ nodeId: 'clear' }, { name: 'tree_focus', agent: harness.agent })
  assert.equal(cleared.cleared, true)
  assert.equal(service.anchoredNode('session-1'), undefined)
})
