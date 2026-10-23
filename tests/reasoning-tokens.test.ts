import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

test('reasoning is paid for in tokens but never stored', () => {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  const service = new TokenTreeService({ config, logger })
  const events = []
  const session = { id: 's', snapshotEvents: () => events }
  const push = (type, data) => {
    const event = { type, seq: events.length + 1, time: events.length + 1, data }
    events.push(event)
    service.handleEvent(session, event)
  }

  const answer = '凸包是最小的凸集。'
  const reasoning = '先考虑定义。'.repeat(200)
  push('user/message', { content: [{ type: 'text', text: '介绍凸包' }], source: { kind: 'user' }, role: 'user', id: 'q1' })
  push('assistant/message', {
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: reasoning },
        { type: 'text', text: answer },
      ],
    },
  })

  const node = [...service.stateOf('s').tree.nodes.values()].find(entry => entry.kind === 'answer')
  assert.ok(node !== undefined, 'the answer became a node')
  assert.equal(node.content, answer, 'the stored content is the answer only')
  assert.ok(!node.content.includes('先考虑定义'), 'no reasoning text is kept')
  assert.ok(node.tokens > 150, 'the reasoning still counts towards the node size')
  assert.ok(node.metadata.reasoningTokens > 100, 'and the count is recorded for inspection')
  assert.equal(node.metadata.reasoningTokens + (node.tokens - node.metadata.reasoningTokens), node.tokens)
})
