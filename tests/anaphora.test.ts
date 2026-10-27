import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { anaphoraScore } from '../src/core/anaphora.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function conversation() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  const service = new TokenTreeService({ config, logger })
  const events = []
  const session = { id: 'anaphora', snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => { const event = { type, seq: ++seq, time: ++seq * 1000, data }; events.push(event); service.handleEvent(session, event) }
  const turn = (text, n, answer) => {
    push('turn/start', { turn: n })
    push('user/message', { role: 'user', id: 'q' + n, source: { kind: 'user' }, content: [{ type: 'text', text }] })
    push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
    push('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  return { service, turn, tree: () => service.stateOf('anaphora').tree }
}

test('a pure back-reference scores high, a self-contained question does not', () => {
  assert.ok(anaphoraScore('它怎么调') >= 0.6, 'its score: ' + anaphoraScore('它怎么调'))
  assert.ok(anaphoraScore('它还有别的限制吗') >= 0.6)
  assert.ok(anaphoraScore('这个值为什么要乘二') >= 0.6)
  assert.equal(anaphoraScore('介绍一下红黑树的插入过程'), 0, 'a named topic is not anaphoric')
  assert.ok(anaphoraScore('为什么布隆过滤器的误判率会随元素增加而上升') < 0.6)
})

test('an anaphoric turn stays under the current node instead of jumping to the root', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小 m、哈希函数个数 k 和元素个数 n 共同决定。')
  run.turn('它怎么调', 2, '调 k：k ≈ (m/n) ln2。')
  const tree = run.tree()
  const questions = [...tree.nodes.values()].filter(node => node.kind === 'question')
  const followUp = questions.at(-1)
  const answer = tree.nodes.get(followUp.parentId)
  assert.equal(answer?.kind, 'answer', 'the follow-up hangs under an answer, not the root: ' + followUp.parentId)
  assert.notEqual(followUp.parentId, tree.rootId, 'and not under the root')
})
