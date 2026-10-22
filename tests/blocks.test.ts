import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryTree } from '../src/core/graph.ts'
import { blocksOf, nodesOf } from '../src/plugin/blocks.ts'

/** Build a small dialogue with one tool call and one fork. */
function fixture(): { tree: MemoryTree; q1: string; a1: string; q2: string } {
  const tree = new MemoryTree({ sessionId: 'blocks', now: 0 })
  const q1 = tree.addNode({ kind: 'question', content: '什么是注意力机制？', timestamp: 1_000 }).id
  const a1 = tree.addNode({ kind: 'answer', content: '注意力按相关性加权求和。', timestamp: 2_000 }).id
  tree.addNode({ kind: 'tool_result', content: 'ok', timestamp: 2_500, metadata: { toolName: 'web_search', ok: true }, setCurrent: false })
  tree.addNode({ kind: 'tool_result', content: 'ENOENT', timestamp: 2_600, metadata: { toolName: 'fs_read', ok: false, error: 'ENOENT' }, setCurrent: false })
  const q2 = tree.addNode({ kind: 'question', content: '其中的 token 是什么？', timestamp: 3_000, metadata: { attached: 'semantic', attachScore: 0.25 } }).id
  tree.addNode({ kind: 'answer', content: 'token 是分词器切分的最小单位。', timestamp: 4_000 })
  // A later, unrelated topic starts a top-level branch (the host attaches it to
  // the root when nothing relates it to the current block).
  tree.addNode({ kind: 'question', content: '向我介绍线段树', parentId: tree.rootId, timestamp: 5_000 })
  tree.addNode({ kind: 'answer', content: '线段树维护区间信息。', timestamp: 6_000 })
  return { tree, q1, a1, q2 }
}

test('one block per exchange, grouped with its answer and tools', () => {
  const { tree, q1, q2 } = fixture()
  const payload = blocksOf(tree)

  assert.equal(payload.blocks.length, 3)
  assert.equal(payload.stats.blocks, 3)
  assert.equal(payload.sessionId, 'blocks')

  const [first, second, third] = payload.blocks
  assert.equal(first.id, q1)
  assert.equal(first.parentId, null)
  assert.equal(first.origin, 'chain')
  assert.match(first.answer, /加权求和/)
  assert.deepEqual(first.tools.map(tool => [tool.name, tool.ok]), [['web_search', true], ['fs_read', false]])
  assert.equal(first.tools[1].error, 'ENOENT')

  assert.equal(second.id, q2)
  assert.equal(second.parentId, q1, 'a follow-up hangs under the block it explains')
  assert.equal(second.origin, 'auto')
  assert.equal(second.score, 0.25)

  assert.equal(third.parentId, null)
  assert.equal(third.origin, 'topic', 'a later root-level question opened a new topic')
  assert.equal(payload.stats.branches, 1)
})

test('a question without an answer still appears as a block', () => {
  const tree = new MemoryTree({ sessionId: 'pending', now: 0 })
  const question = tree.addNode({ kind: 'question', content: '还没回答的问题', timestamp: 1_000 }).id
  const payload = blocksOf(tree)
  assert.equal(payload.blocks.length, 1)
  assert.equal(payload.blocks[0].id, question)
  assert.equal(payload.blocks[0].answer, '')
  assert.equal(payload.blocks[0].parentId, null)
  assert.equal(payload.blocks[0].origin, 'chain')
})

test('path cost is measured from the focus block', () => {
  const { tree, q1, q2 } = fixture()
  const payload = blocksOf(tree, { focusId: q2 })
  const first = payload.blocks.find(block => block.id === q1)
  const second = payload.blocks.find(block => block.id === q2)
  assert.ok(first !== undefined && second !== undefined)
  assert.equal(second.pathCost, 0)
  assert.ok(first.pathCost > 0)
})

test('the node view exposes every node, parents before children', () => {
  const { tree, q1, a1 } = fixture()
  const payload = nodesOf(tree)

  // Question blocks collapse this to 3; the node view keeps every answer and tool.
  const questions = [...tree.nodes.values()].filter(node => node.kind === 'question').length
  const tools = [...tree.nodes.values()].filter(node => node.kind === 'tool_result').length
  assert.ok(payload.nodes.length > payload.stats.questions)
  assert.equal(payload.stats.questions, questions)
  assert.equal(payload.stats.tools, tools)
  assert.equal(payload.nodes[0].id, tree.rootId)
  assert.equal(payload.nodes[0].depth, 0)

  const question = payload.nodes.find(node => node.id === q1)
  const answer = payload.nodes.find(node => node.id === a1)
  assert.ok(question !== undefined && answer !== undefined)
  assert.equal(question.kind, 'question')
  assert.equal(answer.kind, 'answer')
  assert.ok(answer.depth > question.depth)
  assert.ok(question.preview.length > 0)

  // Every non-root node names a parent that is present in the payload.
  const ids = new Set(payload.nodes.map(node => node.id))
  for (const node of payload.nodes) {
    if (node.parentId === null) continue
    assert.ok(ids.has(node.parentId), `${node.id} parent present`)
  }
})

test('the node view carries pins, ignores and the anchor', () => {
  const { tree, q1 } = fixture()
  tree.mark(q1, { pinned: true })
  const payload = nodesOf(tree, { anchoredId: q1 })
  assert.equal(payload.anchoredId, q1)
  assert.equal(payload.nodes.find(node => node.id === q1)?.pinned, true)
})

test('a question node carries its answer as the detail text', () => {
  const { tree, q1, a1 } = fixture()
  const payload = nodesOf(tree)
  const question = payload.nodes.find(node => node.id === q1)
  const answer = payload.nodes.find(node => node.id === a1)
  assert.ok(question?.detail !== undefined && question.detail.length > 0, 'question has a detail')
  assert.ok(answer?.detail === undefined, 'answers do not repeat themselves')
})

test('both payloads expose the turn, so the transcript can locate a row by turn', () => {
  const tree = new MemoryTree({ sessionId: 'turns', now: 0 })
  const question = tree.addNode({ kind: 'question', content: '什么是哈希表？', metadata: { turn: 3 }, timestamp: 1_000 }).id
  tree.addNode({ kind: 'answer', content: '按 key 直接定位。', metadata: { turn: 3 }, timestamp: 2_000 })

  const nodes = nodesOf(tree)
  assert.equal(nodes.nodes.find(node => node.id === question)?.turn, 3)

  const blocks = blocksOf(tree)
  assert.equal(blocks.blocks.find(block => block.id === question)?.turn, 3)
})

test('a deleted branch disappears from both payloads and returns on restore', () => {
  const { tree, q1 } = fixture()
  tree.mark(q1, { deleted: true })

  assert.equal(nodesOf(tree).nodes.some(node => node.id === q1), false, 'node view hides it')
  assert.equal(blocksOf(tree).blocks.some(block => block.id === q1), false, 'block view hides it')

  tree.mark(q1, { deleted: false })
  assert.equal(nodesOf(tree).nodes.some(node => node.id === q1), true, 'node view shows it again')
  assert.equal(blocksOf(tree).blocks.some(block => block.id === q1), true, 'block view shows it again')
})
