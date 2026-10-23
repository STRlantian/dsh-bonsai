import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** Mount a service and feed it one conversation, exactly like the live ingest path. */
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
    ask: text => push('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `q${seq}` }),
    tell: text => push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    questions: () => [...service.stateOf('s').tree.nodes.values()].filter(node => node.kind === 'question'),
  }
}

test('an unrelated question starts its own branch even under a short answer', () => {
  const run = conversation()
  run.ask('用三句话介绍凸包，不要调用工具。')
  run.tell('凸包是包含给定点集的最小凸集，可以想象成一根橡皮筋把所有点绷紧后形成的边界。它的顶点一定来自点集本身。')
  run.ask('用三句话介绍 osu mania 的判定区间。')
  run.tell('osu!mania 的判定分为 MAX、300、200、100、50 与 Miss 六档，区间以毫秒计。')

  const [first, second] = run.questions()
  const tree = run.service.stateOf('s').tree
  assert.equal(second.parentId, tree.rootId, 'a different topic starts a root branch')
  assert.equal(second.metadata.attached, 'topic')
  assert.notEqual(second.parentId, first.id)
})

test('a follow-up still returns to the answer that introduced the topic', () => {
  const run = conversation()
  run.ask('用三句话介绍凸包，不要调用工具。')
  run.tell('凸包是包含给定点集的最小凸集，可以想象成一根橡皮筋把所有点绷紧后形成的边界。它的顶点一定来自点集本身。')
  run.ask('用一句话介绍凸包的时间复杂度。')
  run.tell('平面凸包可以在 O(n log n) 内求出。')

  const questions = run.questions()
  const tree = run.service.stateOf('s').tree
  const firstAnswer = [...tree.nodes.values()].find(node => node.kind === 'answer')
  assert.equal(questions[1].parentId, firstAnswer.id, 'the follow-up lands under the topic answer')
})
