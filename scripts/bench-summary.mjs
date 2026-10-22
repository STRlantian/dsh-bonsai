#!/usr/bin/env node
/**
 * Offline check of the two new retrieval behaviours: summary matching and the fallback
 * ladder. No model calls, so it can be run on every change.
 *
 * Scenario 1 (summary matching): facts live in the FIRST sentence of long, padded
 * nodes — the shape of a real tool result or a long answer. A keyword query should
 * still find them.
 * Scenario 2 (fallback): a query nothing matches. The buffer must not come back empty;
 * it should fall back to the ancestor path and say so.
 *
 * Usage:
 *   node scripts/bench-summary.mjs
 */
import { MemoryTree } from '../src/core/graph.ts'
import { retrieveContext } from '../src/core/retrieve.ts'

const PAD = '后续还讨论了若干与本条无关的工程细节，包括日志格式、部署顺序、值班安排、'
  + '发布窗口、监控阈值、回滚流程、容量规划、成本核算、依赖升级与文档同步等。'

/**
 * Build a tree whose facts sit in the first sentence of long nodes.
 * @param {boolean} long - whether to pad each node into a long one.
 * @returns {{tree: MemoryTree, gold: {id: string, keywords: string}[]}} fixture.
 */
function build(long, repeats = 2) {
  const tree = new MemoryTree({ sessionId: 'summary-bench', now: 0, params: { tokenBudget: 2000, topK: 12 } })
  const gold = []
  const topics = [
    ['备份窗口', '备份窗口固定在 03:15，保留 14 天。', '备份 窗口 归档'],
    ['认证容差', '认证时钟容差是 45 秒。', '认证 容差 签名'],
    ['连接池', '数据库连接池上限是 24。', '连接池 上限 超时'],
    ['限流', '限流按 IP 每分钟 90 次。', '限流 每分钟 突发'],
    ['缓存容量', '缓存容量 3000 条。', '缓存 容量 命中率'],
    ['错误码', '错误码从 41000 开始。', '错误码 起始 域'],
  ]
  for (const [label, fact, keywords] of topics) {
    const content = long ? `${fact}${PAD.repeat(repeats)}` : fact
    const id = tree.addNode({ kind: 'answer', content, timestamp: 1_000 + gold.length * 10 }).id
    // Noise children, so the tree has the texture of a real session.
    for (let index = 0; index < 3; index++) {
      tree.addNode({
        kind: 'tool_result',
        content: `ran probe ${label}-${index}: exit 0, stdout "(no output)"`,
        parentId: id,
        timestamp: 1_001 + gold.length * 10 + index,
        setCurrent: false,
      })
    }
    gold.push({ id, keywords, label })
  }
  return { tree, gold }
}

/** Run one configuration and report recall, rank, returned size and fallbacks. */
function measure(label, long, summaryMatch, admitRelevance = 0.3, repeats = 2) {
  const { tree, gold } = build(long, repeats)
  let found = 0
  let nodes = 0
  let relaxed = 0
  const ranks = []
  for (const target of gold) {
    const result = retrieveContext(tree, {
      query: `${target.keywords} 是多少`,
      admitRelevance,
      ...(summaryMatch ? {} : { summaryMatch: false }),
    })
    if (result.counts.relaxed === true) relaxed++
    const position = result.selected.findIndex(entry => entry.nodeId === target.id)
    if (position !== -1) {
      found++
      ranks.push(position + 1)
    }
    nodes += result.selected.length
  }
  ranks.sort((left, right) => left - right)
  return {
    label,
    found,
    total: gold.length,
    nodesPerQuery: (nodes / gold.length).toFixed(1),
    medianRank: ranks.length === 0 ? '-' : String(ranks[Math.floor(ranks.length / 2)]),
    relaxed,
  }
}

const rows = [
  measure('短节点 + 摘要匹配开', false, true),
  measure('长节点 + 摘要匹配关', true, false),
  measure('长节点 + 摘要匹配开', true, true),
  // Admission off isolates the effect of summary matching on RANKING, without the
  // empty-admission retry covering for it.
  measure('长节点 + 摘要关 + 无准入', true, false, 0),
  measure('长节点 + 摘要开 + 无准入', true, true, 0),
  // Padding long enough to dominate the content embedding: this is the shape the
  // summary is supposed to rescue (a 3,000-token tool dump with a one-line header).
  measure('超长(×20) + 摘要关', true, false, 0, 20),
  measure('超长(×20) + 摘要开', true, true, 0, 20),
]

console.log('scenario 1 · 事实在长节点的首句里\n')
console.log('配置                        recall   nodes/query   median rank   relaxed')
for (const row of rows) {
  console.log(row.label.padEnd(26), `${row.found}/${row.total}`.padEnd(8),
    row.nodesPerQuery.padStart(11), row.medianRank.padStart(12), String(row.relaxed).padStart(9))
}

console.log('\nscenario 2 · 查询什么都不匹配时的回退\n')
const { tree } = build(true)
const quiet = retrieveContext(tree, { query: 'zzzz 完全无关的查询 qqqq', admitRelevance: 0.9 })
console.log(`selected: ${quiet.selected.length}`)
console.log(`counts.relaxed:  ${quiet.counts.relaxed === true}`)
console.log(`counts.fallback: ${quiet.counts.fallback ?? '(none)'}`)
console.log(`节点: ${quiet.selected.map(entry => `${entry.nodeId}:${entry.tokens}tok`).join(' ') || '(空)'}`)

const longNode = tree.addNode
console.log(`\n长节点是否生成了摘要: ${[...tree.nodes.values()].some(node => node.summary !== undefined)}`)
