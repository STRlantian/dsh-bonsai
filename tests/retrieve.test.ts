import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryTree } from '../src/core/graph.ts'
import { retrieveContext, renderContextBlock } from '../src/core/retrieve.ts'

/** Three-node learning dialogue plus a distractor branch. */
function fixture(): { tree: MemoryTree; intro: string; weather: string; ask: string; distractor: string } {
  const tree = new MemoryTree({
    sessionId: 'recall',
    now: 0,
    // These cases exercise ranking and the weight floor, so admission is disabled here;
    // it has its own test below.
    params: { threshold: 0.05, tokenBudget: 400, topK: 8, admitRelevance: 0 },
  })
  const intro = tree.addNode({
    kind: 'answer',
    content: 'Attention computes a weighted sum over token vectors in a transformer.',
    timestamp: 1_000,
  }).id
  const weather = tree.addNode({
    kind: 'answer',
    content: 'Beijing winter weather is dry and cold with strong wind.',
    timestamp: 2_000,
  }).id
  const ask = tree.addNode({
    kind: 'question',
    content: 'How does a token get its weight in attention?',
    timestamp: 3_000,
  }).id
  const distractor = tree.addNode({
    kind: 'note',
    content: 'Unrelated recipe notes about kneading dough.',
    parentId: tree.rootId,
    timestamp: 4_000,
  }).id
  tree.moveTo(ask)
  return { tree, intro, weather, ask, distractor }
}

test('relevance dominates: the on-topic ancestor outranks the off-topic one', () => {
  const { tree, intro, ask, weather } = fixture()
  const result = retrieveContext(tree, { query: 'attention token weight', excludeIds: [ask] })
  assert.ok(result.selected.length >= 2)
  assert.equal(result.selected[0].nodeId, intro)
  assert.ok(result.selected[0].weight > (result.selected.find(entry => entry.nodeId === weather)?.weight ?? 0))
  assert.equal(result.selected[0].breakdown.combine, 'linear')
})

test('the current node costs nothing to reach and scores highest', () => {
  const { tree, ask } = fixture()
  const result = retrieveContext(tree, { query: 'attention token weight' })
  const origin = result.selected.find(entry => entry.nodeId === ask)
  assert.ok(origin !== undefined)
  assert.equal(origin.breakdown.pathCost, 0)
  assert.equal(origin.breakdown.pathWeight, 1)
})

test('a far unrelated node is filtered by the weight floor', () => {
  const { tree, ask, distractor } = fixture()
  const loose = retrieveContext(tree, { query: 'attention token weight', excludeIds: [ask], threshold: 0.05 })
  assert.ok(loose.selected.some(entry => entry.nodeId === distractor) === false)
  const strict = retrieveContext(tree, { query: 'attention token weight', excludeIds: [ask], threshold: 0.2 })
  assert.ok(strict.dropped.some(entry => entry.nodeId === distractor && entry.reason === 'threshold'))
  assert.ok(strict.counts.belowThreshold > 0)
})

test('the token budget bounds the buffer', () => {
  const { tree, ask } = fixture()
  const result = retrieveContext(tree, { query: 'attention token weight', excludeIds: [ask], budgetTokens: 30 })
  assert.ok(result.tokensUsed <= 30)
  assert.ok(result.selected.length >= 1)
  assert.ok(result.counts.overBudget > 0)
})

test('cheap-and-relevant nodes are spent before expensive long ones', () => {
  const { tree, ask } = fixture()
  const longId = tree.addNode({
    kind: 'answer',
    content: 'Token weights are produced by a softmax over scaled dot products, and the scaling factor keeps gradients usable. '
      + 'Multi-head attention repeats that operation per head and concatenates the results before the projection.',
    timestamp: 5_000,
  }).id
  const result = retrieveContext(tree, {
    query: 'attention token weight',
    excludeIds: [ask],
    budgetTokens: 40,
  })
  const chosenLong = result.selected.find(entry => entry.nodeId === longId)
  const droppedLong = result.dropped.find(entry => entry.nodeId === longId && entry.reason === 'budget')
  assert.ok(chosenLong !== undefined || droppedLong !== undefined)
  assert.ok(result.tokensUsed <= 40)
})

test('a low-scoring node is compressed before it is admitted', () => {
  const tree = new MemoryTree({ sessionId: 'compressed', now: 0, params: { compressBelow: 0.95, compressedTokens: 12 } })
  const long = tree.addNode({
    kind: 'answer',
    content: 'A very long detour about gradient accumulation, warmup schedules, mixed precision arithmetic, '
      + 'checkpointing strategies, and several unrelated engineering details that should not survive compression.',
    timestamp: 1_000,
  }).id
  const result = retrieveContext(tree, { query: 'attention', mustIncludeIds: [long] })
  const entry = result.selected.find(node => node.nodeId === long)
  assert.ok(entry !== undefined)
  assert.equal(entry.compressed, true)
  assert.ok(entry.tokens < tree.node(long).tokens)
  // Long nodes now carry a derived topic line, so compression prefers it over a hard
  // truncation; either way the text is shorter than the original and drawn from it.
  assert.ok(entry.text.length < tree.node(long).content.length)
  assert.ok(tree.node(long).content.startsWith(entry.text.replace(/…$/, '')))
})

test('user marks decide inclusion: ignored is dropped, must-include survives the floor', () => {
  const { tree, weather, ask } = fixture()
  tree.mark(weather, { ignored: true })
  const ignored = retrieveContext(tree, { query: 'attention', excludeIds: [ask] })
  assert.ok(ignored.selected.every(entry => entry.nodeId !== weather))

  tree.mark(weather, { ignored: false })
  const compelled = retrieveContext(tree, { query: 'attention', excludeIds: [ask], threshold: 0.99, mustIncludeIds: [weather] })
  assert.ok(compelled.selected.some(entry => entry.nodeId === weather))
})

test('the rendered block is compact and names every selected node', () => {
  const { tree, intro } = fixture()
  const result = retrieveContext(tree, { query: 'attention token weight' })
  const block = renderContextBlock(result)
  assert.ok(block.startsWith('[token-tree memory]'))
  assert.ok(block.includes(intro))
  assert.equal(renderContextBlock({ ...result, selected: [] }), '')
})

test('admission prefers precision but never returns an empty buffer', () => {
  const { tree, intro, weather } = fixture()

  // A query that clearly matches one node: admission keeps it and rejects the other.
  const gated = retrieveContext(tree, { query: 'attention computes a weighted sum over token vectors', admitRelevance: 0.3 })
  assert.ok(gated.selected.some(entry => entry.nodeId === intro), 'the close match is admitted')
  assert.ok(gated.selected.every(entry => entry.nodeId !== weather), 'the unrelated node is not admitted')

  // A query nothing clears: the floor is relaxed instead of answering with nothing.
  const relaxed = retrieveContext(tree, { query: 'zzzz unrelated tokens xyz', admitRelevance: 0.95 })
  assert.equal(relaxed.counts.relaxed, true, 'an empty admission retries without the floor')
  assert.ok(relaxed.selected.length > 0, 'the buffer is never empty because of the floor')

  // Pinned nodes bypass admission, because the user asked for them explicitly.
  tree.mark(weather, { pinned: true })
  const pinned = retrieveContext(tree, { query: 'attention computes a weighted sum over token vectors', admitRelevance: 0.95 })
  assert.ok(pinned.selected.some(entry => entry.nodeId === weather))
})

test('a long node is found by its topic line, not by its padding', () => {
  const padding = '后续还讨论了若干与本条无关的工程细节、日志格式、部署顺序、值班安排与发布窗口等。'.repeat(12)
  const tree = new MemoryTree({ sessionId: 'summary', now: 0 })
  const backup = tree.addNode({
    kind: 'answer',
    content: `备份窗口固定在 03:15，保留 14 天。${padding}`,
    timestamp: 1_000,
  }).id
  tree.addNode({ kind: 'answer', content: `认证时钟容差是 45 秒。${padding}`, timestamp: 2_000 })
  tree.addNode({ kind: 'answer', content: `连接池上限是 24。${padding}`, timestamp: 3_000 })

  const node = tree.node(backup)
  assert.ok(node.summary !== undefined, 'long nodes get a derived topic line')
  assert.ok(node.summary.startsWith('备份窗口'), 'the topic line is the first sentence only')
  assert.ok((node.summaryEmbedding?.length ?? 0) > 0, 'the topic line is embedded for matching')

  // With the topic line, the default floor admits it and it ranks first.
  const withSummary = retrieveContext(tree, { query: '备份 窗口 归档 是多少', admitRelevance: 0.3 })
  assert.equal(withSummary.counts.relaxed, undefined, 'the floor admits it on the topic line alone')
  assert.equal(withSummary.selected[0]?.nodeId, backup, 'and it ranks first')

  // Without it, the padding owns the embedding: nothing clears the floor, so the query
  // only survives because admission is relaxed, and the winner is much weaker.
  const withoutSummary = retrieveContext(tree, { query: '备份 窗口 归档 是多少', admitRelevance: 0.3, summaryMatch: false })
  assert.equal(withoutSummary.counts.relaxed, true, 'the full text alone cannot clear the floor')
  const weak = withoutSummary.selected.find(entry => entry.nodeId === backup)
  const strong = withSummary.selected.find(entry => entry.nodeId === backup)
  assert.ok(strong !== undefined && weak !== undefined)
  assert.ok(strong.weight > weak.weight, 'the topic line scores the wanted node higher')
})
