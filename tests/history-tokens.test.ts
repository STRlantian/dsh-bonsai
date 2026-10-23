import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

test('folding measures the whole history, not just the branch in use', () => {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  const service = new TokenTreeService({ config, logger })
  const state = service.stateOf('s')
  // Two long sibling branches: the path through one is short, the history is not.
  const root = state.tree.rootId
  const first = state.tree.addNode({ kind: 'question', content: '凸包怎么求', tokens: 400, parentId: root, timestamp: 1 })
  state.tree.addNode({ kind: 'answer', content: '凸包答案'.repeat(50), tokens: 9000, parentId: first.id, timestamp: 2 })
  const second = state.tree.addNode({ kind: 'question', content: 'dijkstra 怎么写', tokens: 30, parentId: root, timestamp: 3 })
  state.tree.addNode({ kind: 'answer', content: '堆优化'.repeat(20), tokens: 6000, parentId: second.id, timestamp: 4 })

  const path = service.conversationTokens('s')
  const history = service.historyTokens('s')
  assert.ok(path < 6100, 'the path only sees the current branch')
  assert.ok(history > 15400, 'the history sees both branches')
  assert.ok(history > path * 2, 'which is why a fold threshold must use the history')
})
