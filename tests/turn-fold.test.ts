import test from 'node:test'
import assert from 'node:assert/strict'

import { planTurnFold, turnPlaceholder } from '../src/plugin/fold.ts'

const ev = (type, seq, turn, extra = {}) => ({ type, seq, data: { turn, ...extra } })
const msg = (type, seq, turn) => ev(type, seq, turn, { message: { content: [{ type: 'text', text: 'x' }] } })

test('a whole turn folds into one placeholder, including its tool result', () => {
  const events = [
    msg('user/message', 1, 1),
    msg('assistant/message', 2, 1),
    msg('tool/result', 3, 1),
    msg('assistant/message', 4, 1),
    msg('user/message', 5, 2),
    msg('assistant/message', 6, 2),
    msg('user/message', 7, 3),
  ]
  const plan = planTurnFold(events, events.map(event => event.seq), 2)
  assert.equal(plan.length, 0, 'turn 1 is the prompt head, turns 2 and 3 are kept')
  // A four-turn conversation: turn 1 is the head, turn 2 holds the tool exchange.
  const longer = [
    ...events,
    msg('user/message', 8, 4),
    msg('assistant/message', 9, 4),
  ]
  const folded = planTurnFold(longer, longer.map(event => event.seq), 2)
  assert.equal(folded.length, 1, 'only turn 2 can fold')
  assert.equal(folded[0].startSeq, 5)
  assert.equal(folded[0].endSeq, 6)
  assert.deepEqual(folded[0].seqs, [5, 6], 'every shadowed node is listed, as the host requires')
  const content = folded[0].data.content
  assert.deepEqual(content, [{ type: 'text', text: turnPlaceholder(1) }])
  assert.equal(folded[0].data.source.kind, 'token-tree', 'the placeholder is tagged as ours')
})

test('the prompt head is never folded; every message turn can be', () => {
  const events = [
    ev('system/message', 1, 0),
    msg('user/message', 2, 1),
    msg('user/message', 3, 2),
    msg('user/message', 4, 3),
  ]
  const plan = planTurnFold(events, events.map(event => event.seq), 0)
  assert.deepEqual(plan.map(entry => entry.startSeq), [3, 4], 'the system prompt and the opening turn stay')
})

test('already folded turns are not planned again', () => {
  const events = [msg('user/message', 1, 1), msg('user/message', 2, 2), msg('user/message', 3, 3)]
  // Only turn 3 is still visible, and it is inside the keep window.
  const plan = planTurnFold(events, [3], 1)
  assert.deepEqual(plan, [])
})
