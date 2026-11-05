import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/index.ts'
import { Config } from '../src/plugin/config.ts'

/**
 * The diagnostic commands: each one has to survive an empty session and report the recorded numbers
 * once something happened. They are read-only, so a missing record must produce a line, never a throw.
 */

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value

function mount() {
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const commands = new Map<string, { handler: (invocation: { agent: unknown; rawInput: string }) => unknown }>()
  const services = new Map<string, unknown>()
  const agent = { id: 'agent-1', session: { id: 'session-1' } }
  const ctx = {
    tools: { register: () => () => {} },
    logger,
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return () => {}
    },
    effect: (run: () => unknown) => { run(); return () => {} },
    provide: (name: string, value: unknown) => { services.set(name, value); return () => {} },
    commands: { register: (definition: { name: string }) => { commands.set(definition.name, definition as never); return () => {} } },
    inject: (_names: readonly string[], callback: (scoped: unknown) => void) => callback(ctx),
    get: (name: string) => (name === 'commands' ? ctx.commands : undefined),
  }
  apply(ctx as never, config)
  const service = services.get('tokenTree') as {
    stateOf: (id: string) => Record<string, unknown>
    noteFold: (sessionId: string, folded: number, tokens: number, threshold: number, extra?: Record<string, unknown>) => void
  }
  return { commands, agent, service }
}

const run = async (commands: Map<string, { handler: (invocation: { agent: unknown; rawInput: string }) => unknown }>, name: string, agent: unknown) => {
  const command = commands.get(name)
  assert.ok(command !== undefined, `command ${name} is registered`)
  return await command.handler({ agent, rawInput: '' }) as { kind: string; text: string }
}

test('every diagnostic command is registered', () => {
  const { commands } = mount()
  for (const name of ['tree', 'prompt', 'fold', 'usage', 'retrieve']) assert.ok(commands.has(name), name)
})

test('an empty session answers instead of throwing', async () => {
  const { commands, agent } = mount()
  for (const name of ['prompt', 'fold', 'usage', 'retrieve']) {
    const result = await run(commands, name, agent)
    assert.equal(result.kind, 'success', name)
    assert.ok(result.text.length > 0, name)
  }
})

test('/usage reports the billed prompt split and the hit rate', async () => {
  const { commands, agent, service } = mount()
  const state = service.stateOf('session-1') as { lastUsage?: Record<string, number> }
  state.lastUsage = { input: 1000, cached: 9000, written: 0, output: 200, total: 10200, at: 1_700_000_000_000 }
  const result = await run(commands, 'usage', agent)
  assert.match(result.text, /new 1000/)
  assert.match(result.text, /cache hit 9000/)
  assert.match(result.text, /90\.0%/)
})

test('/fold reports the last fold decision', async () => {
  const { commands, agent, service } = mount()
  service.noteFold('session-1', 2, 50_000, 40_000, { planned: 2, visible: 12, range: 'block=48000 kept=9000 ratio=5' })
  const result = await run(commands, 'fold', agent)
  assert.match(result.text, /folded: 2/)
  assert.match(result.text, /48000/)
  assert.match(result.text, /verdict: folded/)
})

test('/retrieve reports the last retrieval', async () => {
  const { commands, agent, service } = mount()
  const state = service.stateOf('session-1') as { lastRetrieve?: Record<string, unknown> }
  state.lastRetrieve = { query: '缓存怎么清理', originId: 'n3', budget: 2000, tokensUsed: 900, selected: 2, dropped: 1, ids: ['n1', 'n2'], at: 1 }
  const result = await run(commands, 'retrieve', agent)
  assert.match(result.text, /缓存怎么清理/)
  assert.match(result.text, /budget 2000/)
  assert.match(result.text, /n1, n2/)
})
