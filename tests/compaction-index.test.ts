import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** A service with a tree of `count` question nodes. */
function withTree(count) {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  const service = new TokenTreeService({ config, logger })
  const state = service.stateOf('s')
  for (let index = 0; index < count; index++) {
    state.tree.addNode({
      kind: 'question',
      content: `第 ${index} 轮：备份窗口是 03:15，保留 14 天，错误码从 41000 开始。`,
      timestamp: index,
    })
  }
  return { service, state }
}

test('after a compaction the first hint carries an index of the folded nodes', () => {
  const { service, state } = withTree(3)
  service.noteCompactionObserved('s')

  const hint = service.retrievalHint('s')
  assert.ok(hint !== undefined, 'compacted sessions always get a hint')
  assert.ok(hint?.includes('原文完整保存在对话树'), 'the index explains where the originals are')
  assert.ok(hint?.includes('retrieve_context'), 'it says how to fetch them')
  assert.ok(hint?.includes('备份窗口'), 'it names what was folded, not just "history"')
  assert.ok(hint?.includes('tok）'), 'each entry reports its size')

  // Only once: repeating it every turn would just add tokens.
  const second = service.retrievalHint('s')
  assert.ok(second !== undefined, 'the plain hint stays')
  assert.ok(second?.includes('原文完整保存在对话树') === false, 'the index is not repeated')
})

test('a new compaction makes the index available again', () => {
  const { service, state } = withTree(2)
  service.noteCompactionObserved('s')
  assert.ok(service.retrievalHint('s')?.includes('原文完整保存在对话树'))
  assert.equal(service.retrievalHint('s')?.includes('原文完整保存在对话树'), false)

  state.compacted = true
  service.noteCompactionObserved('s')
  assert.ok(service.retrievalHint('s')?.includes('原文完整保存在对话树'), 'reset by the next compaction')
})

test('the index stays within its character budget', () => {
  const { service } = withTree(40)
  service.noteCompactionObserved('s')
  const hint = service.retrievalHint('s') ?? ''
  assert.ok(hint.length < 2_500, `index too long: ${hint.length}`)
  const entries = hint.split('\n').filter(line => line.startsWith('- n'))
  assert.ok(entries.length <= 8, `too many entries: ${entries.length}`)
})
