import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import type { SessionEventLike } from '../src/plugin/dsh.ts'

/** Quiet logger. */
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** Build a service with default configuration. */
function service(): TokenTreeService {
  const config = Config['~standard'].validate({ logEdgeUpdates: false })
  assert.ok(config.value !== undefined)
  return new TokenTreeService({ config: config.value, logger })
}

/** One durable event. */
function event(seq: number, type: string, data: Record<string, unknown>): SessionEventLike {
  return { type, seq, time: seq * 1_000, data }
}

/** A learner question payload. */
function question(text: string, id: string): Record<string, unknown> {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** An assistant answer payload. */
function answer(text: string): Record<string, unknown> {
  return { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

test('a resumed session replays its log before folding the next event', () => {
  const tree = service()
  const history: SessionEventLike[] = [
    event(1, 'user/message', question('什么是注意力机制？', 'm1')),
    event(2, 'assistant/message', answer('注意力按相关性加权求和。')),
    event(3, 'user/message', question('其中的 token 是什么？', 'm2')),
  ]
  const next = event(4, 'assistant/message', answer('token 是最小文本单位。'))
  const session = {
    id: 'resumed',
    snapshotEvents: () => [...history, next],
  }

  tree.handleEvent(session, next)

  const state = tree.stateOf('resumed')
  // History produced two questions and two answers; the triggering event was
  // already inside the snapshot, so it must not be applied twice.
  assert.equal(state.tree.nodes.size, 5)
  assert.equal([...state.tree.nodes.values()].filter(node => node.kind === 'question').length, 2)
  assert.equal([...state.tree.nodes.values()].filter(node => node.kind === 'answer').length, 2)
  assert.equal(state.lastSeq, 4)
})

test('events after the replay keep folding normally', () => {
  const tree = service()
  const history = [
    event(1, 'user/message', question('什么是线段树？', 'm1')),
    event(2, 'assistant/message', answer('线段树维护区间信息。')),
  ]
  const session = { id: 'live', snapshotEvents: () => [...history] }

  tree.handleEvent(session, history[1])
  tree.handleEvent(session, event(3, 'user/message', question('什么是复杂度？', 'm2')))

  const state = tree.stateOf('live')
  assert.equal([...state.tree.nodes.values()].filter(node => node.kind === 'question').length, 2)
})

test('backfillFromSession rebuilds without waiting for an event', () => {
  const tree = service()
  const session = {
    id: 'idle',
    snapshotEvents: () => [
      event(1, 'user/message', question('介绍 dijkstra', 'm1')),
      event(2, 'assistant/message', answer('Dijkstra 求单源最短路。')),
    ],
  }
  tree.backfillFromSession(session)
  tree.backfillFromSession(session)

  const state = tree.stateOf('idle')
  assert.equal(state.tree.nodes.size, 3)
  assert.equal(state.backfilled, true)
})

test('a session without the reader behaves exactly as before', () => {
  const tree = service()
  const session = { id: 'plain' }
  tree.handleEvent(session, event(1, 'user/message', question('什么是 token？', 'm1')))
  tree.handleEvent(session, event(1, 'assistant/message', answer('最小文本单位。')))
  const state = tree.stateOf('plain')
  assert.equal(state.tree.nodes.size, 3)
})
