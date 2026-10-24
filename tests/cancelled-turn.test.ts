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
    endTurn: (turn, kind) => push('turn/end', { turn, reason: { kind } }),
    tree: () => service.stateOf('s').tree,
  }
}

test('a cancelled turn does not stay in the tree', () => {
  const run = conversation()
  run.push('turn/start', { turn: 1 })
  run.ask('介绍一下凸包')
  run.endTurn(1, 'aborted')

  const tree = run.tree()
  const questions = [...tree.nodes.values()].filter(node => node.kind === 'question')
  assert.equal(questions.length, 1, 'the node was created when the message was sent')
  assert.equal(tree.hidden(questions[0].id), true, 'and hidden when the turn was cancelled')
  assert.equal(nodesOf(tree).nodes.filter(row => row.kind === 'question').length, 0, 'so it is gone from the tree payload')
  assert.ok(run.service.historyTokens('s') < 5, 'and costs nothing in the thresholds beyond the root note')
})

test('a cancelled turn takes a partial answer with it', () => {
  const run = conversation()
  run.push('turn/start', { turn: 1 })
  run.ask('介绍一下凸包')
  run.tell('凸包是包含给定点集的')
  run.endTurn(1, 'aborted')

  const tree = run.tree()
  assert.equal(nodesOf(tree).nodes.filter(row => row.kind === 'question' || row.kind === 'answer').length, 0, 'question and partial answer both leave')
})

test('a completed turn keeps its exchange', () => {
  const run = conversation()
  run.push('turn/start', { turn: 1 })
  run.ask('介绍一下凸包')
  run.tell('凸包是最小的凸集。')
  run.endTurn(1, 'completed')

  const payload = nodesOf(run.tree())
  assert.equal(payload.nodes.filter(row => row.kind === 'question' || row.kind === 'answer').length, 2, 'question and answer stay')
  assert.equal(payload.hidden.length, 0, 'nothing went to the recycle bin')
})

test('a failed turn keeps the question, because the user did ask it', () => {
  const run = conversation()
  run.push('turn/start', { turn: 1 })
  run.ask('介绍一下凸包')
  run.endTurn(1, 'error')

  const payload = nodesOf(run.tree())
  assert.equal(payload.nodes.filter(row => row.kind === 'question').length, 1, 'the question stays for a retry')
  assert.equal(payload.hidden.length, 0)
})
