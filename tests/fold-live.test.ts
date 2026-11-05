import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/index.ts'
import { Config } from '../src/plugin/config.ts'

/**
 * Drive the turn-end fold hook end to end: real plugin mount, real tree, a fake host session that
 * records what the plugin appends. The planner and the size rules have unit tests; this one proves
 * the wiring appends a replace op exactly when the block is worth folding.
 */

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function mount(configOverrides: Record<string, unknown>) {
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const appended: { type: string; data: Record<string, unknown>; intent: Record<string, unknown> | undefined }[] = []
  const config = Config['~standard'].validate({ logEdgeUpdates: false, ...configOverrides }).value
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
    provide: () => () => {},
    commands: { register: () => () => {} },
    inject: (_services: readonly string[], _callback: unknown) => undefined,
    get: () => undefined,
  }
  apply(ctx as never, config)

  const events: Record<string, unknown>[] = []
  const session = {
    id: 'fold-live',
    surface: undefined,
    append(type: string, data: Record<string, unknown>, intent?: Record<string, unknown>) {
      const event = { type, seq: events.length + 1, data, ...(intent ?? {}) }
      appended.push({ type, data, intent })
      events.push(event)
      for (const listener of handlers.get('session/event') ?? []) (listener as (...input: unknown[]) => unknown)(session, event)
    },
    snapshotEvents: () => events,
  }
  const emit = (event: Record<string, unknown>) => {
    events.push(event)
    for (const listener of handlers.get('session/event') ?? []) (listener as (...input: unknown[]) => unknown)(session, event)
  }
  return { appended, emit }
}

let sequence = 0
function turn(emit: (event: Record<string, unknown>) => void, number: number, size: number) {
  emit({ type: 'turn/start', seq: ++sequence, data: { turn: number } })
  emit({ type: 'user/message', seq: ++sequence, data: { turn: number, role: 'user', id: `q${number}`, source: { kind: 'user' }, content: [{ type: 'text', text: `第${number}个问题 ` + '缓存'.repeat(size) }] } })
  emit({ type: 'assistant/message', seq: ++sequence, data: { turn: number, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第${number}个回答 ` + '淘汰'.repeat(size) }] } } })
  emit({ type: 'turn/end', seq: ++sequence, data: { turn: number, reason: { kind: 'completed' } } })
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

test('the block trigger appends a replace op once the block clears the floor and the window ratio', async () => {
  // Eight turns with a window of two leaves five turns to fold, well past 2x the two kept turns.
  const { appended, emit } = mount({ foldAboveTokens: 200, foldBlockRatio: 1, foldKeepTurns: 2, foldTrigger: 'block', foldCadence: 1 })
  for (let number = 1; number <= 8; number++) {
    turn(emit, number, 200)
    await settle()
  }
  const folds = appended.filter(entry => typeof entry.intent?.surfaceOp === 'object')
  assert.ok(folds.length > 0, 'a fold was appended')
  const op = folds[0].intent.surfaceOp as { op: string; startSeq: number; endSeq: number }
  assert.equal(op.op, 'replace', 'the fold is a replace op')
  assert.ok(Array.isArray(folds[0].intent.sourceEventSeqs), 'every shadowed node is named')
  const placeholder = folds[0].data as { source?: { kind?: string } }
  assert.equal(placeholder.source?.kind, 'token-tree', 'the placeholder is tagged as ours so it is never folded again')
})

test('a block far smaller than the window is left alone', async () => {
  const { appended, emit } = mount({ foldAboveTokens: 200, foldBlockRatio: 50, foldKeepTurns: 2, foldTrigger: 'block', foldCadence: 1 })
  for (let number = 1; number <= 8; number++) {
    turn(emit, number, 20)
    await settle()
  }
  assert.equal(appended.filter(entry => typeof entry.intent?.surfaceOp === 'object').length, 0, 'no fold for a tiny block')
})

test('the history trigger still folds on total size alone', async () => {
  const { appended, emit } = mount({ foldAboveTokens: 200, foldBlockRatio: 0, foldKeepTurns: 2, foldTrigger: 'history', foldCadence: 1 })
  for (let number = 1; number <= 6; number++) {
    turn(emit, number, 200)
    await settle()
  }
  assert.ok(appended.filter(entry => typeof entry.intent?.surfaceOp === 'object').length > 0, 'legacy rule folds')
})
