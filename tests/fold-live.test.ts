import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/index.ts'
import { Config } from '../src/plugin/config.ts'
import { SettingsStore } from '../src/plugin/settings.ts'

/**
 * Drive the turn-stopping fold hook end to end: real plugin mount, real tree, a fake host session
 * that records what the plugin appends. The planner and the size rules have unit tests; this one
 * proves the wiring appends a replace op exactly when the block is worth folding, and that it does
 * so before the host closes the turn.
 */

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function mount(configOverrides: Record<string, unknown>) {
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const appended: { type: string; data: Record<string, unknown>; intent: Record<string, unknown> | undefined }[] = []
  const config = Config['~standard'].validate({ logEdgeUpdates: false, autoReflect: false, autoFold: false, ...configOverrides }).value
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
  const files = new Map<string, string>()
  const settings = new SettingsStore({
    path: 'C:/tmp/fold-live-settings.json',
    io: {
      readFile: path => files.get(path) ?? '{}',
      writeFile: (path, text) => { files.set(path, text) },
      exists: path => files.has(path),
      makeDir: () => {},
    },
    onError: () => {},
  })
  apply(ctx as never, config, { settings })

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
  const stopping = (turn: number) => {
    for (const listener of handlers.get('agent/turn-stopping') ?? []) {
      (listener as (...input: unknown[]) => unknown)({ agent: { session }, turn })
    }
  }
  return { appended, emit, stopping, events }
}

let sequence = 0
function turn(emit: (event: Record<string, unknown>) => void, stopping: (turn: number) => void, number: number, size: number) {
  emit({ type: 'turn/start', seq: ++sequence, data: { turn: number } })
  emit({ type: 'user/message', seq: ++sequence, data: { turn: number, role: 'user', id: `q${number}`, source: { kind: 'user' }, content: [{ type: 'text', text: `第${number}个问题 ` + '缓存'.repeat(size) }] } })
  emit({ type: 'assistant/message', seq: ++sequence, data: { turn: number, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第${number}个回答 ` + '淘汰'.repeat(size) }] } } })
  stopping(number)
  emit({ type: 'turn/end', seq: ++sequence, data: { turn: number, reason: { kind: 'completed' } } })
}

test('the block trigger appends a replace op once the block clears the floor and the window ratio', () => {
  // Eight turns with a window of two leaves five turns to fold, well past 2x the two kept turns.
  const { appended, emit, stopping, events } = mount({ foldAboveTokens: 200, foldBlockRatio: 1, foldKeepTurns: 2, foldTrigger: 'block', foldCadence: 1 })
  for (let number = 1; number <= 8; number++) turn(emit, stopping, number, 200)
  const folds = appended.filter(entry => typeof entry.intent?.surfaceOp === 'object')
  assert.ok(folds.length > 0, 'a fold was appended')
  const op = folds[0].intent.surfaceOp as { op: string; startSeq: number; endSeq: number }
  assert.equal(op.op, 'replace', 'the fold is a replace op')
  assert.ok(Array.isArray(folds[0].intent.sourceEventSeqs), 'every shadowed node is named')
  const placeholder = folds[0].data as { source?: { kind?: string } }
  assert.equal(placeholder.source?.kind, 'token-tree', 'the placeholder is tagged as ours so it is never folded again')
  // The durable-log reader rejects a tool/result replacement outside an open turn, so the fold
  // must be written while turn-stopping, before the host appends turn/end.
  const foldAt = events.findIndex(event => typeof event.surfaceOp === 'object')
  const endedAt = events.findIndex(event => event.type === 'turn/end' && (event.data as { turn?: number }).turn === 8)
  assert.ok(foldAt >= 0 && endedAt >= 0 && foldAt < endedAt, 'fold is inside the open turn')
})

test('a block far smaller than the window is left alone', () => {
  const { appended, emit, stopping } = mount({ foldAboveTokens: 200, foldBlockRatio: 50, foldKeepTurns: 2, foldTrigger: 'block', foldCadence: 1 })
  for (let number = 1; number <= 8; number++) turn(emit, stopping, number, 20)
  assert.equal(appended.filter(entry => typeof entry.intent?.surfaceOp === 'object').length, 0, 'no fold for a tiny block')
})

test('the history trigger still folds on total size alone', () => {
  const { appended, emit, stopping } = mount({ foldAboveTokens: 200, foldBlockRatio: 0, foldKeepTurns: 2, foldTrigger: 'history', foldCadence: 1 })
  for (let number = 1; number <= 6; number++) turn(emit, stopping, number, 200)
  assert.ok(appended.filter(entry => typeof entry.intent?.surfaceOp === 'object').length > 0, 'legacy rule folds')
})

test('keepTurns 0 folds the previous turn, never the one still stopping', () => {
  const { appended, emit, stopping, events } = mount({
    foldAboveTokens: 200,
    foldBlockRatio: 0,
    foldKeepTurns: 0,
    foldTrigger: 'history',
    foldCadence: 0,
    foldScope: 'turns',
    foldPolicy: 'always',
  })
  for (let number = 1; number <= 3; number++) turn(emit, stopping, number, 200)
  const folds = appended.filter(entry => typeof entry.intent?.surfaceOp === 'object')
  assert.equal(folds.length, 1, 'only turn 2 is history when turn 3 stops')
  const op = folds[0].intent.surfaceOp as { startSeq: number; endSeq: number }
  const seqsOf = (turnNumber: number) => events
    .filter(event => (event.type === 'user/message' || event.type === 'assistant/message')
      && (event.data as { turn?: number }).turn === turnNumber)
    .map(event => event.seq)
  assert.deepEqual([op.startSeq, op.endSeq], seqsOf(2), 'the previous turn folds')
  assert.ok(!seqsOf(3).includes(op.startSeq) && !seqsOf(3).includes(op.endSeq), 'the stopping turn stays visible')
})
