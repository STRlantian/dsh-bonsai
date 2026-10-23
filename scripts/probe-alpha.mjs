#!/usr/bin/env node
/**
 * Compare normalisation strengths on two real cases.
 *
 * A) a genuine follow-up that must come back to an earlier branch (short texts, from the suite)
 * B) an unrelated question that must NOT attach to a long answer (from the test2 session)
 *
 * For each candidate the lexical dot is divided by |q| · |d|^alpha, so alpha=1 is cosine and
 * alpha=0 is the old unnormalised score; the table shows what each choice would decide.
 */
import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { embedText, contentFeatures } from '../src/core/embedding.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })

const geometry = `下面是一份从零开始的算法竞赛计算几何入门讲义。点、向量、叉积、点积、旋转、凸包、半平面交、最近点对、判定、区间、精度误差、eps。`
const segment = `线段树是一棵二叉树，每个节点代表数组的一个区间，支持区间查询与区间修改，复杂度 O(log n)。`
const vst = `编写 DAW 插件（VST）入门：先区分 VST 与宿主，再选 JUCE 框架，实现 processBlock 处理音频。`

const cases = [
  { label: 'A follow-up 可持续化线段树', question: '向我介绍可持续化线段树', candidates: [['segment', segment], ['vst', vst]] },
  { label: 'B osu od0 判定区间', question: 'osu mania od0的判定区间是怎么样的', candidates: [['geometry', geometry], ['segment', segment]] },
  { label: 'B 手性图案', question: '如何画出一个带手性的图案', candidates: [['geometry', geometry], ['segment', segment]] },
]

function score(question, doc, alpha) {
  const qFeatures = contentFeatures(question)
  const dFeatures = contentFeatures(doc)
  const df = new Map()
  for (const feature of new Set([...qFeatures, ...dFeatures])) df.set(feature, 1)
  const idfOf = feature => Math.log(1 + 3 / (1 + (df.get(feature) ?? 0)))
  let dot = 0
  let qSum = 0
  for (const feature of qFeatures) {
    const weight = idfOf(feature)
    qSum += weight * weight
    if (dFeatures.has(feature)) dot += weight * weight
  }
  let dSum = 0
  for (const feature of dFeatures) {
    const weight = idfOf(feature)
    dSum += weight * weight
  }
  const qNorm = Math.sqrt(qSum)
  const dNorm = Math.pow(Math.sqrt(dSum), alpha)
  const lexical = qNorm === 0 ? 0 : dot / (qNorm * dNorm)
  const semantic = Math.max(0, cosine(embedText(question), embedText(doc)))
  return { lexical, semantic, mixed: 0.45 * semantic + 0.55 * lexical }
}

function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

for (const testCase of cases) {
  console.log(`\n${testCase.label}`)
  for (const [name, doc] of testCase.candidates) {
    const row = [0.5, 0.75, 1].map(alpha => {
      const result = score(testCase.question, doc, alpha)
      return `a=${alpha}: ${result.mixed.toFixed(3)}`
    })
    console.log(`  ${name.padEnd(9)} ${row.join(' · ')}`)
  }
}
