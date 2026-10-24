import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { nodesOf } from '../src/plugin/blocks.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function conversation() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  const service = new TokenTreeService({ config, logger })
  const events = []
  const session = { id: 's', snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => {
    const event = { type, seq: ++seq, time: seq, data }
    events.push(event)
    service.handleEvent(session, event)
  }
  return {
    service,
    push,
    ask: text => push('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `q${seq}` }),
    tell: text => push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    tree: () => service.stateOf('s').tree,
  }
}

test('answers of the same turn show as one row', () => {
  const run = conversation()
  run.push('turn/start', { turn: 1 })
  run.ask('介绍一下凸包')
  run.tell('先给定义。')
  run.tell('再给一个例子。')
  run.tell('最后是复杂度。')

  const tree = run.tree()
  const answers = [...tree.nodes.values()].filter(node => node.kind === 'answer')
  assert.equal(answers.length, 3, 'the log keeps three separate answers')

  const rows = nodesOf(tree).nodes.filter(row => row.kind === 'answer')
  assert.equal(rows.length, 1, 'the view merges them into one row')
  assert.equal(rows[0].merged, 3, 'and says how many it stands for')
  assert.equal(rows[0].tokens, answers.reduce((sum, node) => sum + node.tokens, 0), 'tokens are summed')
})

test('answers from different turns stay apart', () => {
  const run = conversation()
  run.push('turn/start', { turn: 1 })
  run.ask('介绍一下凸包')
  run.tell('凸包是最小的凸集。')
  run.push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  run.push('turn/start', { turn: 2 })
  run.ask('时间复杂度呢')
  run.tell('O(n log n)。')

  const rows = nodesOf(run.tree()).nodes.filter(row => row.kind === 'answer')
  assert.equal(rows.length, 2, 'two turns, two rows')
  assert.equal(rows[0].merged, undefined, 'neither row is merged')
})
