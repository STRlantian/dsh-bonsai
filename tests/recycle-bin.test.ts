import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { nodesOf } from '../src/plugin/blocks.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

test('hidden branches are listed so they can be restored later', () => {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  const service = new TokenTreeService({ config, logger })
  const state = service.stateOf('s')
  const keep = state.tree.addNode({ kind: 'question', content: '保留这一支：备份窗口 03:15', timestamp: 1 })
  const doomed = state.tree.addNode({ kind: 'question', content: '要隐藏这一支：探针超时 1733ms', timestamp: 2 })
  state.tree.addNode({ kind: 'answer', content: '被隐藏的回答', timestamp: 3 })

  assert.equal(nodesOf(state.tree).hidden.length, 0, 'nothing hidden yet')

  service.remove('s', doomed.id)
  const payload = nodesOf(state.tree)
  assert.equal(payload.hidden.length, 1, 'the hidden root is listed')
  const entry = payload.hidden[0]
  assert.equal(entry.id, doomed.id)
  assert.equal(entry.preview, '要隐藏这一支：探针超时 1733ms', 'the bin shows the original text')
  assert.equal(entry.subtreeSize, 2, 'the whole hidden subtree is counted')
  assert.ok(entry.tokens > 0, 'and its size is reported')
  // Descendants are hidden by inheritance, so they must not get their own row.
  assert.ok(!payload.hidden.some(row => row.kind === 'answer'), 'only the marked root is listed')

  service.restore('s', doomed.id)
  assert.equal(nodesOf(state.tree).hidden.length, 0, 'restoring empties the bin')
  assert.ok(keep !== undefined)
})

test('the bin lists the most recently hidden branch first', () => {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  const service = new TokenTreeService({ config, logger })
  const state = service.stateOf('s')
  const first = state.tree.addNode({ kind: 'question', content: '第一条', timestamp: 1 })
  const second = state.tree.addNode({ kind: 'question', content: '第二条', timestamp: 2 })
  service.remove('s', first.id)
  service.remove('s', second.id)
  const ids = nodesOf(state.tree).hidden.map(row => row.id)
  assert.deepEqual(ids, [second.id, first.id], 'newest hidden branch comes first')
})
