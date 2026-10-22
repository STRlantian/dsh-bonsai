/**
 * Runnable end-to-end demo of the core loop, with no harness involved.
 *
 * It exercises exactly the acceptance path of the plugin:
 *   1. build a conversation tree and query the cost of any two nodes;
 *   2. recall a weighted context buffer under a token budget and show what the
 *      threshold, the top-k cap, and the budget each rejected;
 *   3. fail a tool, watch the edge cost rise, write a reflection, and backtrack
 *      to the better sibling branch.
 *
 * Run with `node scripts/demo.ts` (Node 22.19+/24 strips the types).
 */

import { MemoryTree } from '../src/core/graph.ts'
import { renderContextBlock, retrieveContext } from '../src/core/retrieve.ts'
import { chooseBacktrack, describeBacktrack, describeFailure, evaluateProgress } from '../src/core/reflect.ts'
import type { Observation } from '../src/core/reflect.ts'
import { DEFAULT_LOOP_POLICY } from '../src/core/types.ts'

const rule = (title: string): void => {
  console.log(`\n=== ${title} ===`)
}

const tree = new MemoryTree({ sessionId: 'demo', now: 0 })
const params = tree.params

// --- 1. a learning dialogue that forks -------------------------------------
rule('1. build the tree')
const concept = tree.addNode({
  kind: 'question',
  content: '什么是注意力机制？它为什么在大模型里重要？',
  timestamp: 1_000,
})
const explain = tree.addNode({
  kind: 'answer',
  content: '注意力机制用查询与键的相似度给值加权求和，让模型按相关性聚合信息，而不是按固定位置读取。',
  timestamp: 2_000,
  summary: '注意力 = 按相关性加权求和（query/key/value）。',
})
const tokenQuestion = tree.addNode({
  kind: 'question',
  content: '其中的 token 是什么？如何被切分？',
  timestamp: 3_000,
})
const tokenAnswer = tree.addNode({
  kind: 'answer',
  content: 'token 是模型处理的最小文本单位，由分词器把字符串切分成词表 id 序列。',
  timestamp: 4_000,
})
const digest = tree.addNode({ kind: 'note', content: '今天的天气很适合出门散步，顺便买点水果。', parentId: concept.id, timestamp: 5_000 })

console.log(`nodes: ${tree.nodes.size}, edges: ${tree.edges.size}, depth: ${tree.stats().maxDepth}`)
for (const edge of tree.edges.values()) {
  const from = tree.node(edge.from)
  const to = tree.node(edge.to)
  console.log(
    `  ${edge.from}(${from.kind}) -> ${edge.to}(${to.kind})  cost=${edge.cost.toFixed(3)}`
    + `  [jump ${edge.components.semanticJump.toFixed(3)} time ${edge.components.timeGap.toFixed(3)}`
    + ` branch ${edge.components.branchSwitch} user ${edge.components.userMark}]`,
  )
}

rule('2. path cost between any two nodes')
const costUp = tree.pathCost(tokenAnswer.id, tree.rootId)
const costAcross = tree.pathCost(tokenAnswer.id, digest.id)
console.log(`token answer -> root: cost ${costUp.cost.toFixed(3)} over ${costUp.path.join(' <- ')}`)
console.log(`token answer -> weather note: cost ${costAcross.cost.toFixed(3)} over ${costAcross.path.join(' <- ')}`)
console.log(`(the second path walks down one edge, so it pays descentPenalty ${params.descentPenalty})`)

rule('3. weighted recall under a token budget')
tree.moveTo(tokenQuestion.id)
const recall = retrieveContext(tree, { query: 'token 是怎么切分的', budgetTokens: 120, topK: 6 })
console.log(renderContextBlock(recall))
console.log('selected:')
for (const node of recall.selected) {
  console.log(
    `  ${node.nodeId} ${node.kind.padEnd(9)} w=${node.weight.toFixed(3)}`
    + ` rel=${node.breakdown.relevance.toFixed(3)} path=${node.breakdown.pathCost.toFixed(3)}`
    + ` tokens=${node.tokens}${node.compressed ? ' (compressed)' : ''}`,
  )
}
console.log(`rejected: belowThreshold=${recall.counts.belowThreshold} overCap=${recall.counts.overCap} overBudget=${recall.counts.overBudget}`)
const budgetTight = retrieveContext(tree, { query: 'token 是怎么切分的', budgetTokens: 24 })
console.log(`with a 24-token budget only ${budgetTight.selected.length} node(s) fit: ${budgetTight.selected.map(node => node.nodeId).join(', ')}`)

// --- 2. failure, reflection, backtracking ----------------------------------
rule('4. a failing tool raises its edge cost')
const attempt = tree.addNode({ kind: 'answer', content: '调用联网搜索工具查一下分词器的实现。', timestamp: 6_000 })
const failure = tree.addNode({
  kind: 'tool_result',
  content: 'web_search failed: ETIMEDOUT after 30000ms',
  timestamp: 7_000,
  metadata: { toolName: 'web_search', ok: false, error: 'ETIMEDOUT' },
})
const before = tree.edge(attempt.id, failure.id)
const beforeCost = before!.cost
const after = tree.adjustIncomingEdge(failure.id, params.failureDelta, 'tool/failure')
console.log(`edge ${attempt.id}->${failure.id}: ${beforeCost.toFixed(3)} -> ${after!.cost.toFixed(3)} (${after!.lastReason})`)

rule('5. reflect, then backtrack to the better sibling')
const observations: Observation[] = [
  { step: 1, toolName: 'web_search', argsKey: '{"q":"tokenizer"}', ok: false, error: 'ETIMEDOUT', at: 7_000 },
  { step: 2, toolName: 'web_search', argsKey: '{"q":"tokenizer"}', ok: false, error: 'ETIMEDOUT', at: 8_000 },
]
const evaluation = evaluateProgress({ observations, policy: DEFAULT_LOOP_POLICY })
console.log(`verdict: ${evaluation.verdict} (score ${evaluation.score.toFixed(2)}) — ${evaluation.reasons.join('; ')}`)

const reflection = tree.addNode({
  kind: 'reflection',
  content: describeFailure({ toolName: 'web_search', error: 'ETIMEDOUT', step: 2, attempt: 2 }),
  timestamp: 9_000,
  setCurrent: false,
})
console.log(`reflection node: ${reflection.id}`)

const plan = chooseBacktrack(tree, failure.id, DEFAULT_LOOP_POLICY)
if (plan === null) {
  console.log('no alternative branch scored high enough')
} else {
  console.log(`backtrack plan: ${plan.fromId} -> ${plan.targetId} (escalated ${plan.escalated})`)
  console.log(`  ${plan.reason}`)
  const note = tree.addNode({ kind: 'reflection', content: describeBacktrack(plan), timestamp: 10_000, setCurrent: false })
  tree.moveTo(plan.targetId)
  console.log(`  reflection node ${note.id}; current is now ${tree.currentId}`)
}

rule('6. the retried branch is cheaper to recall')
const retried = tree.addNode({
  kind: 'answer',
  content: '改用本地分词器文档：BPE 把高频字符对逐步合并成子词。',
  timestamp: 11_000,
  metadata: { pinned: true },
})
const retryOk = tree.addNode({
  kind: 'tool_result',
  content: 'fs_read returned docs/tokenizer.md (BPE merges, 50k vocab)',
  timestamp: 12_000,
  metadata: { toolName: 'fs_read', ok: true },
})
tree.adjustIncomingEdge(retryOk.id, -params.successDelta, 'tool/success')
const final = retrieveContext(tree, { query: 'BPE 子词 怎么合并', budgetTokens: 200 })
console.log(`current node ${tree.currentId}, pinned retry ${retried.id}`)
console.log(`top recalled: ${final.selected.slice(0, 3).map(node => `${node.nodeId} w=${node.weight.toFixed(3)}`).join(', ')}`)
console.log(`tree now has ${tree.nodes.size} nodes and ${tree.edges.size} edges`)
