import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

test('the node cap removes inactive branches instead of detaching them forever', () => {
  const config = Config['~standard'].validate({ logEdgeUpdates: false, maxNodesPerSession: 4 }).value!
  const service = new TokenTreeService({ config, logger })
  const state = service.stateOf('cap')
  const tree = state.tree
  const root = tree.rootId
  const first = tree.addNode({ kind: 'question', content: 'first', tokens: 1, parentId: root, timestamp: 1, setCurrent: true })
  tree.addNode({ kind: 'answer', content: 'first answer', tokens: 1, parentId: first.id, timestamp: 2, setCurrent: true })
  const second = tree.addNode({ kind: 'question', content: 'second', tokens: 1, parentId: root, timestamp: 3, setCurrent: false })
  tree.addNode({ kind: 'answer', content: 'second answer', tokens: 1, parentId: second.id, timestamp: 4, setCurrent: false })
  const third = tree.addNode({ kind: 'question', content: 'third', tokens: 1, parentId: root, timestamp: 5, setCurrent: false })
  tree.addNode({ kind: 'answer', content: 'third answer', tokens: 1, parentId: third.id, timestamp: 6, setCurrent: false })
  ;(service as unknown as { prune(state: unknown): void }).prune(state)
  assert.ok(tree.nodes.size <= 4, `cap enforced, got ${tree.nodes.size}`)
  assert.ok(tree.nodes.has(first.id), 'the current path survives')
  assert.ok(!tree.nodes.has(second.id), 'the oldest inactive branch is actually removed')
})
