import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

test('the retrieved context never contains the rules; ruleBlock carries them separately', () => {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  const service = new TokenTreeService({ config, logger })
  const state = service.stateOf('rules-placement')
  state.tree.addNode({ kind: 'question', content: '缓存怎么清理', timestamp: 1_000 })
  state.tree.addNode({ kind: 'answer', content: '缓存按过期时间和热度清理。', timestamp: 2_000 })
  state.constraints.push({
    id: 'rule-1',
    text: '回答先给结论',
    createdAt: 3_000,
    active: true,
    source: 'manual',
    reason: 'manual',
  })

  const context = service.memoryBlock('rules-placement', '缓存怎么清理', 1_000)
  assert.ok(context !== undefined)
  assert.ok(!context.includes('回答先给结论'), 'rules are not part of the retrieved block')
  assert.equal(service.ruleBlock('rules-placement'), '[token-tree] 仍然生效的规则：回答先给结论')
})

test('ruleBlock is undefined when no rule is active', () => {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  const service = new TokenTreeService({ config, logger })
  assert.equal(service.ruleBlock('rules-empty'), undefined)
})
