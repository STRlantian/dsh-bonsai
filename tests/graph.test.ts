import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryTree } from '../src/core/graph.ts'

/** Build the fixture used by most assertions. */
function fixture(): {
  tree: MemoryTree
  root: string
  question: string
  answer: string
  sibling: string
} {
  const tree = new MemoryTree({ sessionId: 'session-1', now: 0 })
  const root = tree.rootId
  const question = tree.addNode({ kind: 'question', content: 'What is attention?', timestamp: 1_000 }).id
  const answer = tree.addNode({ kind: 'answer', content: 'Attention weights tokens by relevance.', timestamp: 2_000 }).id
  const sibling = tree.addNode({ kind: 'question', content: 'What is a token?', parentId: question, timestamp: 3_000 }).id
  return { tree, root, question, answer, sibling }
}

test('links children, records branch ordinals, and sums parent-chain cost', () => {
  const { tree, root, question, answer, sibling } = fixture()

  assert.deepEqual(tree.node(question).children, [answer, sibling])
  assert.equal(tree.node(answer).metadata.branch, 0)
  assert.equal(tree.node(sibling).metadata.branch, 1)
  assert.equal(tree.node(answer).parentId, question)

  const upQuestion = tree.edge(root, question)
  const upAnswer = tree.edge(question, answer)
  assert.ok(upQuestion !== undefined && upAnswer !== undefined)

  const chained = tree.pathCost(answer, root)
  assert.equal(chained.path[0], answer)
  assert.equal(chained.path.at(-1), root)
  assert.ok(Math.abs(chained.cost - (upQuestion.cost + upAnswer.cost)) < 1e-9)
  assert.equal(tree.pathCost(answer, answer).cost, 0)
})

test('walking down an edge costs the descent penalty', () => {
  const { tree, question, answer, sibling } = fixture()
  const edge = tree.edge(question, answer)
  assert.ok(edge !== undefined)

  const up = tree.pathCost(answer, question).cost
  const down = tree.pathCost(question, answer).cost
  assert.ok(Math.abs(up - edge.cost) < 1e-9)
  assert.ok(Math.abs(down - (edge.cost + tree.params.descentPenalty)) < 1e-9)
})

test('cross-branch distance routes through the lowest common ancestor', () => {
  const { tree, question, answer, sibling } = fixture()
  assert.equal(tree.lca(answer, sibling), question)

  const across = tree.pathCost(answer, sibling)
  assert.deepEqual(across.path, [answer, question, sibling])

  const edgeBack = tree.edge(question, answer)
  const edgeOut = tree.edge(question, sibling)
  assert.ok(edgeBack !== undefined && edgeOut !== undefined)
  const expected = edgeBack.cost + edgeOut.cost + tree.params.descentPenalty
  assert.ok(Math.abs(across.cost - expected) < 1e-9)
})

test('edge cost is the weighted sum of its four signals', () => {
  const { tree, root, question } = fixture()
  const edge = tree.edge(root, question)
  assert.ok(edge !== undefined)
  const { components } = edge
  const expected = tree.params.wSemantic * components.semanticJump
    + tree.params.wTime * components.timeGap
    + tree.params.wBranch * components.branchSwitch
    + tree.params.wUser * components.userMark
  assert.ok(Math.abs(edge.cost - Math.max(tree.params.minCost, Math.min(tree.params.maxCost, expected))) < 1e-9)
  assert.ok(edge.cost >= 0)
})

test('a second child under the same parent pays the branch-switch penalty', () => {
  const tree = new MemoryTree({ sessionId: 's', now: 0 })
  const question = tree.addNode({ kind: 'question', content: 'What is attention?', timestamp: 1_000 }).id
  const first = tree.addNode({ kind: 'answer', content: 'Attention weighs tokens.', timestamp: 2_000 }).id
  const second = tree.addNode({ kind: 'answer', content: 'Attention weighs queries.', parentId: question, timestamp: 2_000 }).id
  assert.equal(tree.edge(question, first)?.components.branchSwitch, 0)
  assert.equal(tree.edge(question, second)?.components.branchSwitch, 1)
})

test('adjustEdge moves the cost inside the clamp and records the reason', () => {
  const { tree, question, sibling } = fixture()
  const before = tree.edge(question, sibling)
  assert.ok(before !== undefined)
  const startCost = before.cost
  const after = tree.adjustEdge(question, sibling, tree.params.failureDelta, 'tool/failure')
  assert.ok(Math.abs(after.cost - (startCost + tree.params.failureDelta)) < 1e-9)
  assert.equal(after.updates, 1)
  assert.equal(after.lastReason, 'tool/failure')

  tree.adjustEdge(question, sibling, -1000, 'tool/success')
  assert.equal(tree.edge(question, sibling)?.cost, tree.params.minCost)
})

test('user marks adjust the incoming edge and survive clamping', () => {
  const { tree, question, answer } = fixture()
  const before = tree.edge(question, answer)
  assert.ok(before !== undefined)

  tree.mark(answer, { ignored: true })
  assert.equal(tree.node(answer).metadata.ignored, true)
  const ignored = tree.edge(question, answer)
  assert.ok(ignored !== undefined)
  assert.ok(ignored.cost >= before.cost)
  assert.equal(ignored.lastReason, 'user/ignore')

  tree.mark(answer, { ignored: false })
  const restored = tree.edge(question, answer)
  assert.ok(restored !== undefined)
  assert.ok(Math.abs(restored.cost - before.cost) < 1e-9)
})

test('a node cannot be linked under its own descendant', () => {
  const { tree, root, answer } = fixture()
  assert.throws(() => tree.link(answer, root), /cycle/)
})

test('reparent moves a subtree and reprices the incoming edge', () => {
  const { tree, question, answer, sibling } = fixture()
  const before = tree.edge(question, answer)
  const moved = tree.reparent(answer, sibling)
  assert.equal(tree.node(answer).parentId, sibling)
  assert.equal(tree.edge(question, answer), undefined)
  assert.ok(tree.node(sibling).children.includes(answer))
  assert.ok(Math.abs(moved.cost - (before?.cost ?? 0)) < 10, 'repriced against the new parent')
})

test('reparent refuses a move into its own subtree', () => {
  const { tree, question, sibling } = fixture()
  assert.throws(() => tree.reparent(question, sibling), /cycle/)
  assert.throws(() => tree.reparent(tree.rootId, question), /root/)
  assert.throws(() => tree.reparent(question, question), /itself/)
})

test('remove deletes the subtree and pulls the current pointer back', () => {
  const { tree, question, answer, sibling } = fixture()
  tree.moveTo(answer)
  const removed = tree.remove(question)
  assert.deepEqual(removed.sort(), [question, answer, sibling].sort())
  assert.equal(tree.nodes.has(question), false)
  assert.equal(tree.nodes.has(answer), false)
  assert.equal(tree.nodes.has(sibling), false)
  assert.equal(tree.currentId, tree.rootId)
  assert.throws(() => tree.remove(tree.rootId), /root/)
})

test('stats and serialization round-trip without repricing', () => {
  const { tree } = fixture()
  const stats = tree.stats()
  assert.equal(stats.nodes, 4)
  assert.equal(stats.edges, 3)
  assert.ok(stats.maxDepth >= 2)

  const restored = MemoryTree.fromJSON(tree.toJSON())
  assert.equal(restored.nodes.size, tree.nodes.size)
  assert.equal(restored.rootId, tree.rootId)
  assert.equal(restored.currentId, tree.currentId)
  const original = tree.edge(tree.rootId, tree.node(tree.rootId).children[0])
  const copy = restored.edge(restored.rootId, restored.node(restored.rootId).children[0])
  assert.ok(Math.abs((original?.cost ?? 0) - (copy?.cost ?? 0)) < 1e-12)
})

test('a node whose parent is gone is re-anchored, never a second root', () => {
  // A pruned or stale parent id used to leave the new node parentless, which made
  // every root-based read blind to the rest of the conversation.
  const tree = new MemoryTree({ sessionId: 'session-orphan', now: 0 })
  const first = tree.addNode({ kind: 'question', content: 'first', timestamp: 1_000 }).id
  const orphan = tree.addNode({ kind: 'answer', content: 'orphan', parentId: 'n9999', timestamp: 2_000 })

  assert.equal(orphan.parentId, first, 're-anchored on the current node')
  const roots = [...tree.nodes.values()].filter(node => node.parentId === null)
  assert.equal(roots.length, 1, 'exactly one root')
  assert.equal(tree.ancestors(orphan.id).at(-1), tree.rootId)
})

test('repair re-attaches orphans and second roots', () => {
  const tree = new MemoryTree({ sessionId: 'session-repair', now: 0 })
  const first = tree.addNode({ kind: 'question', content: 'first', timestamp: 1_000 }).id
  const second = tree.addNode({ kind: 'answer', content: 'second', timestamp: 2_000 }).id
  const edges = tree.edges as unknown as Map<string, { to: string }>
  // Two ways a branch goes invisible: a dangling parent, and a detached root.
  ;(tree.node(second) as { parentId: string | null }).parentId = 'n4242'
  for (const [key, edge] of edges) if (edge.to === second) edges.delete(key)
  const detached = tree.addNode({ kind: 'question', content: 'third', parentId: null, timestamp: 3_000 }).id

  const repaired = tree.repair()
  assert.deepEqual(repaired.sort(), [second, detached].sort())
  assert.equal(tree.node(second).parentId, tree.rootId)
  assert.equal(tree.node(detached).parentId, tree.rootId)
  const roots = [...tree.nodes.values()].filter(node => node.parentId === null)
  assert.equal(roots.length, 1, 'single root after repair')
  assert.deepEqual(tree.repair(), [], 'idempotent')
  assert.ok(tree.ancestors(first).length >= 1)
})

test('an unreachable pair reports infinity instead of throwing', () => {
  const tree = new MemoryTree({ sessionId: 'session-gap', now: 0 })
  const first = tree.addNode({ kind: 'question', content: 'a', timestamp: 1_000 }).id
  const second = tree.addNode({ kind: 'answer', content: 'b', timestamp: 2_000 }).id
  // Simulate the shape a stale prune leaves behind: a dangling parent with no edge.
  ;(tree.node(second) as { parentId: string | null }).parentId = 'n4242'
  const edges = tree.edges as unknown as Map<string, { to: string }>
  for (const [key, edge] of edges) if (edge.to === second) edges.delete(key)

  const cost = tree.pathCost(first, second)
  assert.equal(cost.cost, Number.POSITIVE_INFINITY)
  assert.deepEqual(cost.path, [])
  assert.doesNotThrow(() => tree.stats())
  assert.doesNotThrow(() => tree.ancestors(second))
})

test('marking a branch deleted hides it and its descendants, and restore undoes it', () => {
  const { tree, question, answer, sibling } = fixture()
  assert.equal(tree.hidden(question), false)
  assert.equal(tree.hidden(sibling), false)

  tree.mark(question, { deleted: true })
  assert.equal(tree.hidden(question), true)
  // Descendants inherit the mark through their ancestors.
  assert.equal(tree.hidden(sibling), true)
  assert.equal(tree.nodes.has(question), true, 'the node itself is kept')

  tree.mark(question, { deleted: false })
  assert.equal(tree.hidden(question), false)
  assert.equal(tree.hidden(sibling), false)
  assert.equal(tree.hidden(answer), false)
})
