#!/usr/bin/env node
/**
 * Retrieval quality bench: can the tree find a fact that is buried far away?
 *
 * This measures the plugin's actual contribution — weighted recall over a long
 * conversation — without any model call. It builds a synthetic tree with one
 * distinctive fact per branch, spreads those branches over hundreds of nodes, then
 * asks a short query per fact and checks whether retriever ranks that node inside
 * the Top-k and inside the token budget.
 *
 * The point of comparison is the naive baseline a plain chat has: "keep the last N
 * nodes". At equal token budget the linear baseline reaches only the newest branch,
 * while the tree can reach any branch by topic.
 *
 * Usage:
 *   node scripts/bench-retrieval.mjs
 *   node scripts/bench-retrieval.mjs --branches 40 --queries 20 --budget 400 --json
 */
import { MemoryTree } from '../src/core/graph.ts'
import { retrieveContext } from '../src/core/retrieve.ts'
import { cosine, embedText } from '../src/core/embedding.ts'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const asNumber = (name, fallback) => {
  const value = Number(argOf(name, String(fallback)))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const branches = asNumber('branches', 40)
const queryCount = asNumber('queries', 20)
const budget = asNumber('budget', 400)
const topK = asNumber('topK', 12)
const json = args.includes('--json')

/**
 * One synthetic topic: a question, an answer carrying a unique fact, and a pile of
 * tool noise, so the tree has the same texture as a real session.
 * @param {number} index - branch ordinal.
 * @returns {{ question: string, fact: string, keywords: string }}
 */
function topic(index) {
  const topics = [
    { subject: '备份窗口', fact: `备份窗口固定在 03:${String(10 + index % 50).padStart(2, '0')}，保留 14 天，归档到冷存储。`, keywords: '备份 窗口 归档' },
    { subject: '认证算法', fact: `认证使用 HMAC-SHA256，时钟容差 ${20 + index} 秒，签名覆盖请求体。`, keywords: '认证 HMAC 签名 容差' },
    { subject: '连接池', fact: `数据库连接池上限 ${10 + index}，空闲回收 30 秒，超时抛 40001。`, keywords: '连接池 上限 超时' },
    { subject: '限流策略', fact: `限流按 IP 每分钟 ${40 + index} 次，突发容量 ${5 + index % 7}。`, keywords: '限流 每分 突发 IP' },
    { subject: '缓存淘汰', fact: `内存 LRU 容量 ${256 + index} 条，写回延迟 5 秒，命中率目标 92%。`, keywords: '缓存 LRU 容量 命中率' },
    { subject: '部署目录', fact: `部署到 /srv/svc-${index}，只读挂载配置，日志软链到 /var/log。`, keywords: '部署 目录 挂载 日志' },
    { subject: '错误码段', fact: `错误码从 ${40000 + index * 7} 开始，每千位一个域，禁止复用。`, keywords: '错误码 段 复用 域' },
    { subject: '时区设定', fact: `时区固定 Asia/Shanghai，跨区只做展示转换，不参与比较。`, keywords: '时区 转换 跨区 比较' },
    { subject: '告警路由', fact: `告警按严重度路由：P0 电话，P1 邮件到 ops${index}@example.dev。`, keywords: '告警 路由 P0 邮件' },
    { subject: '灰度比例', fact: `灰度按 ${1 + index % 9}% 递增，每阶观察 6 小时，回滚阈值 2%。`, keywords: '灰度 比例 回滚 阈值' },
  ]
  const pick = topics[index % topics.length]
  return {
    question: `第 ${index + 1} 个专题：${pick.subject}怎么配？`,
    fact: pick.fact,
    keywords: pick.keywords,
  }
}

const tree = new MemoryTree({ sessionId: 'bench', now: 0 })
const gold = []

for (let index = 0; index < branches; index += 1) {
  const topicData = topic(index)
  const question = tree.addNode({ kind: 'question', content: topicData.question, timestamp: 1_000 + index * 100 }).id
  const answer = tree.addNode({ kind: 'answer', content: topicData.fact, timestamp: 1_050 + index * 100 })
  // Tool noise: several results under the answer, as a real turn would have.
  for (let tool = 0; tool < 4; tool += 1) {
    tree.addNode({
      kind: 'tool_result',
      content: `ran ${topicData.keywords.split(' ')[0]} probe ${index}-${tool}: exit 0, elapsed ${tool + 1}ms, stdout "(no output)"`,
      parentId: answer.id,
      timestamp: 1_060 + index * 100 + tool,
      setCurrent: false,
      metadata: { toolName: 'pwsh', ok: true },
    })
  }
  gold.push({ id: answer.id, question, keywords: topicData.keywords, fact: topicData.fact })
}

// The naive baseline a linear chat has: the newest K nodes that fit the budget.
function linearBaseline(limitTokens) {
  const ordered = [...tree.nodes.values()].sort((left, right) => right.timestamp - left.timestamp)
  const picked = []
  let tokens = 0
  for (const node of ordered) {
    if (tokens + node.tokens > limitTokens) break
    picked.push(node.id)
    tokens += node.tokens
  }
  return new Set(picked)
}

const baseline = linearBaseline(budget)
const results = []
for (const target of gold.slice(0, queryCount)) {
  const result = retrieveContext(tree, {
    query: `${target.keywords} 是多少`,
    budgetTokens: budget,
    topK,
  })
  const ranked = result.selected.map(entry => entry.nodeId)
  const position = ranked.indexOf(target.id)
  results.push({
    keywords: target.keywords,
    hitTopK: position !== -1,
    position,
    tokensUsed: result.tokensUsed,
    baselineHasIt: baseline.has(target.id),
  })
}

const hits = results.filter(entry => entry.hitTopK).length
const baselineHits = results.filter(entry => entry.baselineHasIt).length

/**
 * Sweep the relevance floor.
 *
 * A high floor ("only take matches above 0.5") is the difference between "precise
 * context" and "often nothing at all", and that trade-off can be measured without any
 * model call: for each floor, how many queries still find their fact, how many nodes
 * come back, and how often the result is empty (which would trigger a fallback).
 * @returns {Array<{threshold: number, recall: string, selected: string, emptyRate: string}>} rows.
 */
function sweep() {
  const thresholds = [0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
  const rows = []
  for (const threshold of thresholds) {
    let found = 0
    let empty = 0
    let selectedTotal = 0
    for (const target of gold.slice(0, queryCount)) {
      const result = retrieveContext(tree, { query: `${target.keywords} 是多少`, budgetTokens: budget, topK, threshold })
      if (result.selected.length === 0) empty++
      if (result.selected.some(entry => entry.nodeId === target.id)) found++
      selectedTotal += result.selected.length
    }
    rows.push({
      threshold,
      recall: `${found}/${gold.slice(0, queryCount).length}`,
      selected: (selectedTotal / gold.slice(0, queryCount).length).toFixed(1),
      emptyRate: `${(empty / gold.slice(0, queryCount).length * 100).toFixed(0)}%`,
    })
  }
  return rows
}

if (args.includes('--admit-sweep')) {
  // Admission floor on raw relevance, with the ranking blend left untouched.
  const floors = [0, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]
  console.log(`admission sweep · ${branches} branches · budget ${budget} · topK ${topK}\n`)
  console.log('floor   recall   nodes/query   empty')
  for (const admitRelevance of floors) {
    let found = 0
    let empty = 0
    let nodes = 0
    for (const target of gold.slice(0, queryCount)) {
      const result = retrieveContext(tree, {
        query: `${target.keywords} 是多少`,
        budgetTokens: budget,
        topK,
        admitRelevance,
      })
      if (result.selected.length === 0) empty++
      if (result.selected.some(entry => entry.nodeId === target.id)) found++
      nodes += result.selected.length
    }
    console.log(String(admitRelevance).padEnd(7),
      `${found}/${gold.slice(0, queryCount).length}`.padEnd(8),
      (nodes / gold.slice(0, queryCount).length).toFixed(1).padStart(11), '  ',
      `${(empty / gold.slice(0, queryCount).length * 100).toFixed(0)}%`)
  }
  process.exit(0)
}

if (args.includes('--sweep')) {
  const rows = sweep()
  console.log(`threshold sweep · ${branches} branches · budget ${budget} · topK ${topK}\n`)
  console.log('floor   recall   nodes/query   empty')
  for (const row of rows) {
    console.log(String(row.threshold).padEnd(7), row.recall.padEnd(8), row.selected.padStart(11), '  ', row.emptyRate)
  }
  process.exit(0)
}

if (args.includes('--cosine')) {
  // The floor above applies to the *combined* score (relevance blended with path
  // weight), which is why 0.5 kills everything. This prints the raw cosine, so a floor
  // can be calibrated on the signal the user actually means by "matching degree".
  const rows = []
  for (const target of gold.slice(0, queryCount)) {
    const embedding = embedText(`${target.keywords} 是多少`, tree.embeddingDimension)
    let targetCosine = null
    let maxCosine = 0
    let above50 = 0
    let above30 = 0
    for (const node of tree.nodes.values()) {
      if (node.tokens === 0) continue
      const similarity = cosine(embedding, node.embedding)
      if (node.id === target.id) targetCosine = similarity
      if (similarity > maxCosine) maxCosine = similarity
      if (similarity >= 0.5) above50++
      if (similarity >= 0.3) above30++
    }
    rows.push({ keywords: target.keywords, targetCosine, maxCosine, above50, above30 })
  }
  console.log('query                     target   max    ≥0.5   ≥0.3')
  for (const row of rows) {
    console.log(row.keywords.padEnd(24),
      (row.targetCosine === null ? '-' : row.targetCosine.toFixed(2)).padStart(6),
      row.maxCosine.toFixed(2).padStart(6),
      String(row.above50).padStart(5),
      String(row.above30).padStart(6))
  }
  const meanTarget = rows.reduce((sum, row) => sum + (row.targetCosine ?? 0), 0) / rows.length
  console.log(`\nmean cosine of the wanted node: ${meanTarget.toFixed(2)}`)
  process.exit(0)
}

const medianPosition = (() => {
  const positions = results.filter(entry => entry.position !== -1).map(entry => entry.position).sort((a, b) => a - b)
  return positions.length === 0 ? null : positions[Math.floor(positions.length / 2)]
})()
const meanTokens = results.reduce((sum, entry) => sum + entry.tokensUsed, 0) / results.length
// What a chat without the tree must pay to still contain every fact: the whole
// history. That is the real alternative — not "the last N nodes", which loses them.
const fullHistoryTokens = [...tree.nodes.values()].reduce((sum, node) => sum + node.tokens, 0)

if (json) {
  console.log(JSON.stringify({ branches, queryCount, budget, topK, hits, baselineHits, medianPosition, meanTokens, fullHistoryTokens, results }, undefined, 2))
} else {
  console.log(`tree: ${tree.nodes.size} nodes, ${branches} branches · budget ${budget} tok · topK ${topK}\n`)
  console.log('query                     tree   rank   linear-last-N')
  for (const entry of results) {
    console.log(
      entry.keywords.padEnd(24),
      (entry.hitTopK ? 'hit' : 'MISS').padEnd(5),
      String(entry.position === -1 ? '-' : entry.position + 1).padStart(4),
      entry.baselineHasIt ? '        hit' : '       MISS',
    )
  }
  console.log(`\nrecall@${topK}   tree ${hits}/${results.length} (${(hits / results.length * 100).toFixed(0)}%)`
    + `   linear ${baselineHits}/${results.length} (${(baselineHits / results.length * 100).toFixed(0)}%)`)
  console.log(`median rank    ${medianPosition === null ? '-' : medianPosition + 1}`)
  console.log(`tokens / query ${meanTokens.toFixed(0)} (budget ${budget})`)
  console.log(`full history   ${fullHistoryTokens} tok — what a linear chat pays to keep every fact`)
  console.log(`saving vs all  ${(100 - meanTokens / fullHistoryTokens * 100).toFixed(0)}%`)
}

if (hits === 0) process.exit(1)
