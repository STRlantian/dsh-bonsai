import test from 'node:test'
import assert from 'node:assert/strict'

import { foldPlaceholder, planFold } from '../src/plugin/fold.ts'

const tool = (seq, turn, text = 'output') => ({
  type: 'tool/result',
  seq,
  data: { turn, message: { toolCallId: `call-${seq}`, content: [{ type: 'text', text }] }, toolName: 'pwsh' },
})

test('old tool results are folded and recent turns are kept', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { turn: 1 } },
    tool(2, 1),
    tool(3, 1),
    { type: 'user/message', seq: 4, data: { turn: 2 } },
    tool(5, 2),
    { type: 'user/message', seq: 6, data: { turn: 3 } },
    tool(7, 3),
  ]
  const plan = planFold(events, [1, 2, 3, 4, 5, 6, 7], 2)
  assert.deepEqual(plan.map(entry => entry.seq), [2, 3], 'only turn 1 is folded; turns 2 and 3 stay')
})

test('folding only rewrites the content, keeping the call identity', () => {
  const plan = planFold([tool(9, 1, 'a very long output')], [9], 0)
  assert.equal(plan.length, 1)
  const message = plan[0].data.message
  assert.equal(message.toolCallId, 'call-9', 'the call id survives, so the pair stays matched')
  assert.equal(plan[0].data.turn, 1, 'the turn survives')
  assert.deepEqual(message.content, [{ type: 'text', text: foldPlaceholder('pwsh') }])
  assert.ok(foldPlaceholder('pwsh').includes('retrieve_context'), 'the placeholder points at the way back')
})

test('already hidden results, and non-tool events, are never folded twice', () => {
  const events = [tool(2, 1), { type: 'user/message', seq: 3, data: { turn: 1 } }]
  // Seq 2 is no longer visible: it was replaced by an earlier fold.
  assert.deepEqual(planFold(events, [3], 0), [], 'nothing visible to fold')
  assert.deepEqual(planFold([{ type: 'user/message', seq: 1, data: {} }], [1], 0), [], 'user messages are left alone')
})

test('a session with nothing older than the keep window folds nothing', () => {
  const events = [tool(2, 1), tool(3, 2)]
  assert.deepEqual(planFold(events, [2, 3], 5), [], 'keeping five turns keeps everything')
})
