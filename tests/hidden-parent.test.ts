import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/**
 * A question that arrives while the dialogue stands on a hidden node must not land under it.
 *
 * Real case: a junk question was hidden in the test workspace, the next question attached under
 * that hidden node, and it disappeared from the tree - the newest question was "missing".
 */
function conversation() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false, value: { attachments: 'linear' } }).value
  const service = new TokenTreeService({ config, logger })
  const events = []
  const session = { id: 'session-hidden', snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => {
    const event = { type, seq: ++seq, time: seq, data }
    events.push(event)
    service.handleEvent(session, event)
  }
  return {
    service,
    push,
    ask: text => push('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'q' + seq }),
    tell: text => push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    end: turn => push('turn/end', { turn, reason: { kind: 'completed' } }),
    start: turn => push('turn/start', { turn }),
    tree: () => service.stateOf('session-hidden').tree,
  }
}

test('a question after a hidden node attaches to the nearest visible ancestor', async () => {
  const run = conversation()
  run.start(1)
  run.ask('第一个问题：布隆过滤器的误判率')
  run.tell('由位数组大小和哈希函数个数共同决定。')
  run.end(1)
  run.start(2)
  run.ask('adsfkljmnnkljklasdlkjdsaladsjkladsjkldas')
  run.tell('看不懂。')
  run.end(2)

  const before = [...run.tree().nodes.values()]
  const junk = before.find(node => node.kind === 'question' && node.content.includes('adsfkljmnn'))
  assert.ok(junk !== undefined, 'the junk question exists')

  // Hide it the way the editor does.
  run.service.remove('session-hidden', junk.id)
  assert.equal(run.tree().hidden(junk.id), true, 'the junk question is hidden')

  run.start(3)
  run.ask('lowbit 的底层实现')
  run.tell('x & -x 的底层是补码。')
  run.end(3)

  const tree = run.tree()
  const question = [...tree.nodes.values()].find(node => node.kind === 'question' && node.content.includes('lowbit'))
  assert.ok(question !== undefined, 'the new question exists')
  assert.notEqual(question.parentId, junk.id, 'it is not under the hidden node')
  assert.equal(tree.hidden(question.id), false, 'and it is visible')
})
