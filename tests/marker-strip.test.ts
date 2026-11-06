import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../src/index.ts'
import { Config } from '../src/plugin/config.ts'
import { SettingsStore } from '../src/plugin/settings.ts'

/**
 * The prompt asks the model to end an answer with `[attach:…]` and `[summary: …]`. Those are
 * instructions to the plugin; they must not stay in the transcript. The plugin rewrites the answer
 * at turn-stopping, inside the turn, and keeps the original in the log.
 */

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function mount(configOverrides: Record<string, unknown>) {
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const appended: { type: string; data: Record<string, unknown>; intent: Record<string, unknown> | undefined }[] = []
  const config = Config['~standard'].validate({ logEdgeUpdates: false, autoReflect: false, ...configOverrides }).value
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
    inject: (_names: readonly string[], callback: (scoped: unknown) => void) => callback(ctx),
    get: () => undefined,
  }
  const settings = new SettingsStore({
    path: 'C:/tmp/marker-strip-settings.json',
    io: {
      readFile: () => '{}',
      writeFile: () => {},
      exists: () => false,
      makeDir: () => {},
    },
    onError: () => {},
  })
  apply(ctx as never, config, { settings })

  const events: Record<string, unknown>[] = []
  const session = {
    id: 'marker-session',
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
function turn(emit: (event: Record<string, unknown>) => void, number: number, answer: string) {
  emit({ type: 'turn/start', seq: ++sequence, data: { turn: number } })
  emit({ type: 'user/message', seq: ++sequence, data: { turn: number, role: 'user', id: `q${number}`, source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${number} 个问题` }] } })
  emit({ type: 'assistant/message', seq: ++sequence, data: { turn: number, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } } })
}

test('the answer is rewritten without the placement and summary markers', () => {
  const { appended, emit, stopping } = mount({ attachChoices: 6, attachSummary: true })
  turn(emit, 1, '缓存按热度淘汰。\n[attach:n2]\n[summary: 淘汰策略, 热度]')
  stopping(1)
  const replacements = appended.filter(entry => (entry.intent?.surfaceOp as { op?: string } | undefined)?.op === 'replace')
  assert.equal(replacements.length, 1, 'one replacement for the answer')
  const content = (replacements[0].data.message as { content: { text: string }[] }).content
  assert.equal(content.length, 1)
  assert.equal(content[0].text, '缓存按热度淘汰。', 'markers and the blank lines they leave are gone')
  assert.deepEqual(replacements[0].intent?.sourceEventSeqs, [3], 'the original event is named')
})

test('marker strip is wrapped in a synthetic step and preserves non-text blocks', () => {
  const { appended, emit, stopping } = mount({ attachChoices: 6, attachSummary: true })
  emit({ type: 'turn/start', seq: 1, data: { turn: 1 } })
  emit({ type: 'user/message', seq: 2, data: { turn: 1, role: 'user', id: 'q1', source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] } })
  emit({
    type: 'assistant/message',
    seq: 3,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        source: { kind: 'model' },
        content: [
          { type: 'image', data: 'keep-me' },
          { type: 'text', text: '回答。[attach:n2]' },
        ],
      },
    },
  })
  stopping(1)
  const start = appended.findIndex(entry => entry.type === 'step/start')
  const end = appended.findIndex(entry => entry.type === 'step/end')
  const replacement = appended.findIndex(entry => typeof entry.intent?.surfaceOp === 'object')
  assert.ok(start >= 0 && end >= 0 && replacement > start && replacement < end, 'replacement sits in the synthetic step')
  const content = (appended[replacement].data.message as { content: { type: string }[] }).content
  assert.equal(content[0].type, 'image', 'the non-text block survives')
  assert.equal((content[1] as { text: string }).text, '回答。')
})

test('an answer without markers is left untouched', () => {
  const { appended, emit, stopping } = mount({ attachChoices: 6, attachSummary: true })
  turn(emit, 1, '缓存按热度淘汰。')
  stopping(1)
  const replacements = appended.filter(entry => (entry.intent?.surfaceOp as { op?: string } | undefined)?.op === 'replace')
  assert.equal(replacements.length, 0, 'no rewrite when there is nothing to strip')
})

test('markers from another turn are not touched', () => {
  const { appended, emit, stopping } = mount({ attachChoices: 6, attachSummary: true })
  turn(emit, 1, '第一轮回答。\n[attach:root]')
  turn(emit, 2, '第二轮回答。')
  stopping(2)
  const replacements = appended.filter(entry => (entry.intent?.surfaceOp as { op?: string } | undefined)?.op === 'replace')
  assert.equal(replacements.length, 0, 'the turn that is stopping is the only one rewritten')
})
