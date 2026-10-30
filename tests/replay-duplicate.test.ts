import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** A session that replays the same envelope twice, the way a snapshot plus a live feed can. */
function build() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  const service = new TokenTreeService({ config, logger })
  const events = []
  const session = { id: 'replay', snapshotEvents: () => events }
  const deliver = (type, data) => {
    const event = { type, seq: 1, time: Date.now(), data }
    events.push(event)
    service.handleEvent(session, event)
    return event
  }
  return { service, session, deliver }
}

test('a re-delivered envelope does not duplicate nodes', () => {
  const run = build()
  run.deliver('turn/start', { turn: 1 })
  const question = run.deliver('user/message', { role: 'user', id: 'q1', source: { kind: 'user' }, content: [{ type: 'text', text: '介绍一下布隆过滤器' }] })
  const answer = run.deliver('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '布隆过滤器用位数组表示集合。' }] } })
  run.deliver('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const before = run.service.stateOf('replay').tree.nodes.size
  // The same objects again, as a replay delivers them.
  run.service.handleEvent(run.session, question)
  run.service.handleEvent(run.session, answer)
  const after = run.service.stateOf('replay').tree.nodes.size

  assert.equal(after, before, 'replaying the same envelopes changes nothing')
  const questions = [...run.service.stateOf('replay').tree.nodes.values()].filter(node => node.kind === 'question')
  assert.equal(questions.length, 1, 'exactly one question node: ' + questions.map(node => node.id).join(','))
})

test('an envelope without a seq still applies and does not poison lastSeq', () => {
  const run = build()
  const snapshotLike = { type: 'turn/start', time: Date.now(), data: { turn: 1 } }
  run.service.handleEvent(run.session, snapshotLike)
  const state = run.service.stateOf('replay')
  assert.ok(Number.isFinite(state.lastSeq), 'lastSeq stays a number: ' + String(state.lastSeq))
  // A later event must still be applied.
  const question = { type: 'user/message', seq: 2, time: Date.now(), data: { role: 'user', id: 'q1', source: { kind: 'user' }, content: [{ type: 'text', text: '布隆过滤器' }] } }
  run.service.handleEvent(run.session, question)
  assert.equal([...state.tree.nodes.values()].filter(node => node.kind === 'question').length, 1)
})
