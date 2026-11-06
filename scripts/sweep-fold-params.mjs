#!/usr/bin/env node
/**
 * Sweep the turn-fold parameters over synthetic conversation profiles.
 *
 * The point is not to fit one conversation; it is to find a default that is cheap
 * across short, medium, and tool-heavy histories and does not lose much while a
 * conversation is still short.
 *
 * Usage: node scripts/sweep-fold-params.mjs [turns]
 * Writes docs/experiments/fold-param-sweep.csv and prints the Pareto-ish top rows.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadTokenizer } from './tokenizer-lib.mjs'

const TURNS = Math.max(40, Number(process.argv[2] ?? 100))
const SYSTEM_TOKENS = 10_453
const HIT = 0.02
const MISS = 1
const PER = 1_000_000
const OVERHEAD = 300
const PLACEHOLDER = 55

const tokenizer = loadTokenizer('C:/Users/ASUS/.dsh/token-tree/deepseek_v4_tokenizer/tokenizer.json')
const count = text => tokenizer.count(text)
function textOfTokens(target, seed) {
  let text = seed
  let tokens = count(text)
  while (tokens < target) {
    text += `\n${seed}`
    tokens = count(text)
  }
  return tokens
}
const q = '请继续分析这个实现：为什么这一轮的选择会影响后面的缓存命中？给出可执行的修改建议。'
const a = '先看数据的形状，再定位边界条件。这里的核心不是再加一层判断，而是让输入在进入模型前就确定为可缓存的前缀；具体做法是把稳定内容放前面，把每轮变化的内容放最后。'
const t = '=== 文件内容 ===\nexport function step(state) { return state.next ?? state } // 稳定的代码片段，用于模拟真实工具输出\n'
const o = '[token-tree] 本轮的落点由你判：\n' + '- n1 · 一个候选问题\n'.repeat(10)
const user = textOfTokens(120, q)
const answer = textOfTokens(650, a)
const toolFor = tokens => tokens === 0 ? 0 : textOfTokens(tokens, t)
const overhead = textOfTokens(OVERHEAD, o)
const placeholder = textOfTokens(PLACEHOLDER, '[已折叠] 之前的 1 轮对话已从上下文移除以节省 token；原文完整保存在对话树中，需要细节时调用 retrieve_context 取回。')

const profiles = [
  { name: 'short', tool: toolFor(700), label: '~1.2k/turn' },
  { name: 'medium', tool: toolFor(3_500), label: '~4.6k/turn' },
  { name: 'long', tool: toolFor(9_000), label: '~10k/turn' },
]

const aboveValues = [8_000, 10_000, 12_000, 15_000, 20_000, 25_000, 30_000, 40_000, 50_000]
const keepValues = [1, 2, 3, 4]
const ratioValues = [2, 3, 4, 5, 6, 8]
const cadenceValues = [1, 2, 3, 5, 8, 10]

function simulate(profile, config) {
  const baseTurn = user + answer + profile.tool
  const turns = Array.from({ length: TURNS }, () => ({ folded: false }))
  const baseline = []
  const plugin = []
  let prevBase = 0
  let prevPlugin = 0
  let pluginFoldChanged = false
  let lastFold = 0
  let folds = 0
  let cumulativeBase = 0
  let cumulativePlugin = 0
  let maxExcess = 0
  let breakEven = null

  const visibleTokens = turn => turn.folded ? placeholder : (overhead + baseTurn)
  const foldedPrefix = n => {
    const first = turns.slice(0, n).findIndex(turn => turn.folded)
    if (first < 0) return 0
    return SYSTEM_TOKENS + turns.slice(0, first).reduce((sum, turn) => sum + visibleTokens(turn), 0)
  }

  for (let n = 1; n <= TURNS; n++) {
    const bPrompt = SYSTEM_TOKENS + baseTurn * n
    const bHit = n === 1 ? 0 : prevBase
    const bMiss = bPrompt - bHit
    const bCost = (bHit * HIT + bMiss * MISS) / PER
    const pPrompt = SYSTEM_TOKENS + turns.slice(0, n).reduce((sum, turn) => sum + visibleTokens(turn), 0)
    const pHit = n === 1 ? 0 : (pluginFoldChanged ? foldedPrefix(n) : prevPlugin)
    const pMiss = pPrompt - pHit
    const pCost = (pHit * HIT + pMiss * MISS) / PER
    baseline.push(bCost)
    plugin.push(pCost)
    cumulativeBase += bCost
    cumulativePlugin += pCost
    maxExcess = Math.max(maxExcess, cumulativePlugin - cumulativeBase)
    if (breakEven === null && cumulativePlugin < cumulativeBase) breakEven = n

    const visible = turns.slice(0, n).filter(turn => !turn.folded)
    const kept = new Set(visible.slice(-config.keep).map((_, index) => visible.length - config.keep + index))
    const eligible = visible.filter((turn, index) => index !== 0 && !kept.has(index))
    const block = eligible.reduce((sum, turn) => sum + visibleTokens(turn), 0)
    const keptTokens = visible.reduce((sum, turn, index) => sum + (kept.has(index) ? visibleTokens(turn) : 0), 0)
    const gap = lastFold === 0 ? Number.POSITIVE_INFINITY : n - lastFold
    pluginFoldChanged = false
    if (eligible.length > 0 && block >= config.above && block >= config.ratio * keptTokens && gap >= config.cadence) {
      for (const turn of eligible) turn.folded = true
      lastFold = n
      folds++
      pluginFoldChanged = true
    }
    prevBase = bPrompt
    prevPlugin = pPrompt
  }
  return {
    base: cumulativeBase,
    total: cumulativePlugin,
    folds,
    finalPrompt: plugin.at(-1) === undefined ? 0 : pluginPrompt(turns, baseTurn),
    maxExcess,
    breakEven,
    at40: plugin.slice(0, 40).reduce((sum, x) => sum + x, 0),
    at60: plugin.slice(0, 60).reduce((sum, x) => sum + x, 0),
  }
  function pluginPrompt(ts, bt) {
    return SYSTEM_TOKENS + ts.reduce((sum, turn) => sum + (turn.folded ? placeholder : (overhead + bt)), 0)
  }
}

const rows = []
for (const profile of profiles) {
  for (const above of aboveValues) {
    for (const keep of keepValues) {
      for (const ratio of ratioValues) {
        for (const cadence of cadenceValues) {
          const config = { above, keep, ratio, cadence }
          const result = simulate(profile, config)
          rows.push({ profile: profile.name, above, keep, ratio, cadence, ...result })
        }
      }
    }
  }
}

const csv = [
  'profile,above,keep,ratio,cadence,folds,total_cost,baseline_cost,max_excess,break_even,at40,at60,final_prompt',
  ...rows.map(row => [
    row.profile, row.above, row.keep, row.ratio, row.cadence, row.folds,
    row.total.toFixed(6), row.base.toFixed(6), row.maxExcess.toFixed(6), row.breakEven ?? '',
    row.at40.toFixed(6), row.at60.toFixed(6), row.finalPrompt,
  ].join(',')),
].join('\n') + '\n'
const outDir = fileURLToPath(new URL('../docs/experiments/', import.meta.url))
writeFileSync(`${outDir}fold-param-sweep.csv`, csv)

const best = new Map()
for (const profile of profiles) {
  const list = rows.filter(row => row.profile === profile.name)
  const near = list.filter(row => row.maxExcess <= 0.02)
  near.sort((left, right) => left.total - right.total)
  best.set(profile.name, near.slice(0, 8))
}

console.log(`turns=${TURNS}  profiles: ${profiles.map(profile => `${profile.name}(${profile.label})`).join(', ')}`)
console.log(`grid: above=${aboveValues.length} keep=${keepValues.length} ratio=${ratioValues.length} cadence=${cadenceValues.length}  rows=${rows.length}`)
for (const profile of profiles) {
  console.log(`\n${profile.name}: best total cost with max cumulative excess <= 0.02`)
  console.log('above keep ratio cad fold total$ base$ maxExcess breakEven at40 at60 finalPrompt')
  for (const row of best.get(profile.name)) {
    console.log([
      row.above, row.keep, row.ratio, row.cadence, row.folds,
      row.total.toFixed(4), row.base.toFixed(4), row.maxExcess.toFixed(4),
      row.breakEven ?? '-', row.at40.toFixed(4), row.at60.toFixed(4), row.finalPrompt,
    ].join(' '))
  }
}

const defaults = rows.filter(row => row.above === 40_000 && row.keep === 3 && row.ratio === 5 && row.cadence === 3)
console.log('\ndefault (40000,3,5,3):')
for (const row of defaults) {
  console.log(`${row.profile}: total=${row.total.toFixed(4)} base=${row.base.toFixed(4)} maxExcess=${row.maxExcess.toFixed(4)} folds=${row.folds} breakEven=${row.breakEven ?? '-'} at40=${row.at40.toFixed(4)} at60=${row.at60.toFixed(4)}`)
}
