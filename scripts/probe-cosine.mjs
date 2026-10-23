#!/usr/bin/env node
/** Raw embedding cosines for the pairs the attachment heuristic actually sees. */
import { contentFeatures, cosine, embedText } from '../src/core/embedding.ts'

const graph = '# 算法竞赛图论：从入门到进阶的完整梳理 下面按难度递进组织：每一节先讲这个工具解决什么问题，再讲怎么用。最短路算法包括 Dijkstra、Bellman-Ford、SPFA、Floyd。'
const dijkstra = '# Dijkstra 算法详解 Dijkstra 是图论中使用频率最高的算法，很多人只会背模板，不会处理负权。用小根堆维护距离，每次取出最小距离的点松弛出边。'
const dp = '# 动态规划的基本分析方法 动态规划真正的难点在于如何从一个具体问题出发，推导出状态和转移方程，而写方程只是最后一步。先定义状态，再想转移。'
const cooking = '锅包肉可以烧牛肉吗'
const recipe = '给我一份菜谱我饿了'
const followUp = '详细说一下dijkstra'
const unrelated = '用三句话介绍 osu mania 的判定区间'

const pairs = [
  ['dijkstra follow-up', followUp, graph],
  ['dijkstra follow-up', followUp, dijkstra],
  ['DP question', '详细介绍动态规划问题的基本分析方法', dijkstra],
  ['DP question', '详细介绍动态规划问题的基本分析方法', graph],
  ['cooking', cooking, dp],
  ['cooking', cooking, graph],
  ['recipe', recipe, dp],
  ['unrelated osu', unrelated, cooking],
]

for (const [label, question, doc] of pairs) {
  const semantic = cosine(embedText(question), embedText(doc))
  const shared = [...contentFeatures(question)].filter(feature => contentFeatures(doc).has(feature))
  console.log(`${label.padEnd(18)} vs ${doc.slice(0, 10)}… semantic=${semantic.toFixed(3)} shared=${shared.length ? shared.join(',') : '(none)'}`)
}
