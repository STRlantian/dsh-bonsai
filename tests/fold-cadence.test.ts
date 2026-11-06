import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value

/** Feed one question/answer turn into a fresh session. */
function turn(service: TokenTreeService, sessionId: string, number: number, seq: { value: number }) {
  const push = (type: string, data: Record<string, unknown>) => {
    service.handleEvent({ id: sessionId, snapshotEvents: () => [] }, { type, seq: ++seq.value, time: seq.value, data } as never)
  }
  push('turn/start', { turn: number })
  push('user/message', { role: 'user', id: `q${number}`, source: { kind: 'user' }, content: [{ type: 'text', text: `第${number}个问题，关于缓存淘汰` }] })
  push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: `第${number}个回答：按热度淘汰。` }] } })
  push('turn/end', { turn: number, reason: { kind: 'completed' } })
}

test('the cadence defaults to ten turns and can be tuned', () => {
  assert.equal(config.foldCadence, 10, 'folds batch up by default')
  const tuned = Config['~standard'].validate({ foldCadence: 5 }).value
  assert.equal(tuned.foldCadence, 5)
  assert.equal(Config['~standard'].validate({ foldCadence: 0 }).value.foldCadence, 0, 'zero means re-evaluate every turn')
})

test('the fold gap counts turns since the last fold', () => {
  const service = new TokenTreeService({ config, logger })
  const sessionId = 'cadence-gap'
  const seq = { value: 0 }
  turn(service, sessionId, 1, seq)
  turn(service, sessionId, 2, seq)
  assert.equal(service.sessionTurn(sessionId), 2, 'the tree knows the current turn')
  assert.equal(service.foldGap(sessionId), Number.POSITIVE_INFINITY, 'a session that never folded has no gap')

  service.noteFoldTurn(sessionId, 2)
  assert.equal(service.foldGap(sessionId), 0, 'the current turn folded')

  turn(service, sessionId, 3, seq)
  assert.equal(service.foldGap(sessionId), 1, 'one turn later')
  turn(service, sessionId, 4, seq)
  assert.equal(service.foldGap(sessionId), 2, 'two turns later')
})

test('the cadence is read through the session override', () => {
  const service = new TokenTreeService({
    config,
    logger,
    settings: {
      path: '/tmp/settings.json',
      all: () => ({}),
      allFor: (sessionId: string) => (sessionId === 'a' ? { foldCadence: 4 } : {}),
      allSessions: () => ({}),
      apply: () => ({}),
      applyFor: () => ({}),
      clearFor: () => {},
    } as never,
  })
  assert.equal(service.effective('a').foldCadence, 4, 'the session override wins')
  assert.equal(service.effective('b').foldCadence, 10, 'other sessions keep the default')
})
