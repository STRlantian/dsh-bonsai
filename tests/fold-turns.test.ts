import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { planTurnFold } from '../src/plugin/fold.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** A host-shaped log: user messages do not carry a turn field, answers do. */
function hostLog() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  const service = new TokenTreeService({ config, logger })
  const events: Record<string, unknown>[] = []
  const push = (event: Record<string, unknown>) => {
    events.push(event)
    service.handleEvent({ id: 'host-shape' }, event as never)
  }
  let seq = 0
  for (let turn = 1; turn <= 3; turn++) {
    push({ type: 'turn/start', seq: ++seq, time: seq, data: { turn } })
    push({
      type: 'user/message',
      seq: ++seq,
      time: seq,
      data: { role: 'user', id: `q${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: `问题 ${turn}` }] },
    })
    push({
      type: 'assistant/message',
      seq: ++seq,
      time: seq,
      data: { turn, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: `回答 ${turn}` }] } },
    })
    push({ type: 'turn/end', seq: ++seq, time: seq, data: { turn, reason: { kind: 'completed' } } })
  }
  return { service, events, seq }
}

test('a question with no host turn belongs to the turn it opens', () => {
  const { service, events } = hostLog()
  const visible = events.filter(event => ['user/message', 'assistant/message', 'tool/result'].includes(event.type as string)).map(event => event.seq as number)
  const plan = planTurnFold(
    events as never,
    visible,
    0,
    seq => service.turnOfSeq('host-shape', seq),
  )
  const second = plan.find(fold => fold.turn === 2)
  assert.ok(second !== undefined, 'turn 2 is foldable')
  // q2 is seq 6; a2 is seq 7. The old bug started the range at the answer.
  assert.equal(second.startSeq, 6, 'the folded range starts at the question, not the answer')
  assert.equal(second.endSeq, 7)
  assert.deepEqual(second.seqs, [6, 7])
})
