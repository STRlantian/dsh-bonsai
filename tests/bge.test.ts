import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function serviceWith(bge) {
  const config = Config['~standard'].validate({ bge: true, bgeChunkChars: 300 }).value
  const service = new TokenTreeService({ config, logger, bge })
  const session = { id: 's', snapshotEvents: () => [] }
  service.handleEvent(session, {
    type: 'user/message',
    seq: 1,
    data: { message: { id: 'q', source: { kind: 'user' }, content: [{ type: 'text', text: '什么是注意力机制？' }] } },
  })
  service.handleEvent(session, {
    type: 'assistant/message',
    seq: 2,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '注意力机制按相关性给每个位置分配权重。' }] } },
  })
  return { service, session }
}

test('BGE config is opt-in and validates its model/chunk knobs', () => {
  const off = Config['~standard'].validate({}).value
  assert.equal(off.bge, false)
  assert.equal(off.bgeModel, 'Xenova/bge-small-zh-v1.5')
  assert.equal(off.bgeChunkChars, 300)

  const on = Config['~standard'].validate({ bge: true, bgeModel: 'local/model', bgeChunkChars: 450 }).value
  assert.equal(on.bge, true)
  assert.equal(on.bgeModel, 'local/model')
  assert.equal(on.bgeChunkChars, 450)
})

test('BGE scores override hash relevance, and a missing BGE falls back to hash', async () => {
  const { service } = serviceWith({
    score: async (_query, nodes) => new Map(nodes.filter(node => node.kind === 'answer').map(node => [node.id, 1])),
  })
  const bge = await service.retrieveAsync('s', { query: '注意力', threshold: 0, admitRelevance: 0 })
  assert.ok(bge.selected.length > 0)
  assert.equal(bge.selected[0].kind, 'answer', 'the fake BGE answer wins')

  const fallback = serviceWith({ score: async () => undefined }).service
  const withFallback = await fallback.retrieveAsync('s', { query: '注意力', threshold: 0, admitRelevance: 0 })
  const hash = fallback.retrieve('s', { query: '注意力', threshold: 0, admitRelevance: 0 })
  assert.deepEqual(
    withFallback.selected.map(node => node.nodeId),
    hash.selected.map(node => node.nodeId),
    'undefined BGE returns the exact hash path',
  )
})
