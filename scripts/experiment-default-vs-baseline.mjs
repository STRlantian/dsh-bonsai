#!/usr/bin/env node
/**
 * Offline cost comparison: default preset vs no plugin (full context).
 *
 * The conversation is synthetic but the counts are real: every message is measured with the
 * installed DeepSeek v4 tokenizer. Each turn has a user question, an assistant answer, and a
 * tool result; the default preset also injects a retrieval hint + candidate block (~300 tokens)
 * per turn. The default fold rule is applied after each turn: block >= 40,000 tokens, block >=
 * 5x the keep window, keep the last 3 turns, at least 3 turns between folds.
 *
 * Cache model: input hit = 0.02, input miss = 1.0 per million prompt tokens. A fold invalidates
 * the prefix at the first folded turn, so everything from that point is a miss; without a fold,
 * the previous prompt is a hit and only the newly appended messages miss. Output tokens are not
 * included.
 *
 * Usage: node scripts/experiment-default-vs-baseline.mjs [turns] [toolTokens]
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadTokenizer } from './tokenizer-lib.mjs'

const TURNS = Math.max(4, Number(process.argv[2] ?? 60))
const TOOL_TOKENS = Math.max(0, Number(process.argv[3] ?? 3500))
const SYSTEM_TOKENS = 10_453
const HIT_PRICE = 0.02
const MISS_PRICE = 1
const PRICE_PER = 1_000_000
const FOLD_ABOVE = 40_000
const KEEP = 3
const RATIO = 5
const CADENCE = 3

const tokenizer = loadTokenizer('C:/Users/ASUS/.dsh/token-tree/deepseek_v4_tokenizer/tokenizer.json')
const count = text => tokenizer.count(text)

/** Build text of at least the requested token size, using the real tokenizer. */
function textOfTokens(target, seed) {
  let text = seed
  let tokens = count(text)
  while (tokens < target) {
    text += `\n${seed}`
    tokens = count(text)
  }
  return { text, tokens }
}

const question = '请继续分析这个实现：为什么这一轮的选择会影响后面的缓存命中？给出可执行的修改建议。'
const answer = '先看数据的形状，再定位边界条件。这里的核心不是再加一层判断，而是让输入在进入模型前就确定为可缓存的前缀；具体做法是把稳定内容放前面，把每轮变化的内容放最后。'
const tool = '=== 文件内容 ===\n' + 'export function step(state) { return state.next ?? state } // 稳定的代码片段，用于模拟真实工具输出\n'
const hoverhead = '[token-tree] 本轮的落点由你判：\n' + '- n1 · 一个候选问题\n'.repeat(10)

const userText = textOfTokens(120, question)
const answerText = textOfTokens(650, answer)
const toolText = textOfTokens(TOOL_TOKENS, tool)
const overheadText = textOfTokens(300, hoverhead)
const placeholderText = textOfTokens(55, '[已折叠] 之前的 1 轮对话已从上下文移除以节省 token；原文完整保存在对话树中，需要细节时调用 retrieve_context 取回。')

const turns = []
for (let index = 1; index <= TURNS; index++) {
  turns.push({
    index,
    user: userText.tokens,
    answer: answerText.tokens,
    tool: toolText.tokens,
    overhead: overheadText.tokens,
    folded: false,
  })
}

const tokenOf = turn => turn.user + turn.answer + turn.tool
const visibleTokenOf = turn => turn.overhead + tokenOf(turn)

function baselinePrompt(n) {
  return SYSTEM_TOKENS + turns.slice(0, n).reduce((sum, turn) => sum + tokenOf(turn), 0)
}
function pluginPrompt(n) {
  return SYSTEM_TOKENS + turns.slice(0, n).reduce((sum, turn) =>
    sum + (turn.folded ? placeholderText.tokens : visibleTokenOf(turn)), 0)
}
function foldedPrefix(n) {
  const first = turns.slice(0, n).find(turn => turn.folded)
  if (first === undefined) return undefined
  return SYSTEM_TOKENS + turns.slice(0, first.index - 1).reduce((sum, turn) =>
    sum + (turn.folded ? placeholderText.tokens : visibleTokenOf(turn)), 0)
}

const rows = []
let baselinePrevious = 0
let pluginPrevious = 0
let pluginFoldChanged = false
let lastFold = 0
let folds = 0
let baselineCumulative = 0
let pluginCumulative = 0

for (let n = 1; n <= TURNS; n++) {
  const bPrompt = baselinePrompt(n)
  const bHit = n === 1 ? 0 : baselinePrevious
  const bMiss = bPrompt - bHit
  const bCost = (bHit * HIT_PRICE + bMiss * MISS_PRICE) / PRICE_PER

  const pPrompt = pluginPrompt(n)
  let pHit
  if (n === 1) pHit = 0
  else if (pluginFoldChanged) {
    const prefix = foldedPrefix(n)
    pHit = prefix ?? 0
  } else {
    pHit = pluginPrevious
  }
  const pMiss = pPrompt - pHit
  const pCost = (pHit * HIT_PRICE + pMiss * MISS_PRICE) / PRICE_PER

  rows.push({ n, bPrompt, bHit, bMiss, bCost, pPrompt, pHit, pMiss, pCost, folds })
  baselineCumulative += bCost
  pluginCumulative += pCost

  // End-of-turn fold decision for the next prompt.
  const visible = turns.slice(0, n).filter(turn => !turn.folded)
  const kept = new Set(visible.slice(-KEEP).map(turn => turn.index))
  const eligible = visible.filter(turn => turn.index !== 1 && !kept.has(turn.index))
  const block = eligible.reduce((sum, turn) => sum + visibleTokenOf(turn), 0)
  const keptTokens = visible.filter(turn => kept.has(turn.index)).reduce((sum, turn) => sum + visibleTokenOf(turn), 0)
  const gap = lastFold === 0 ? Number.POSITIVE_INFINITY : n - lastFold
  pluginFoldChanged = false
  if (eligible.length > 0 && block >= FOLD_ABOVE && block >= RATIO * keptTokens && gap >= CADENCE) {
    for (const turn of eligible) turn.folded = true
    lastFold = n
    folds++
    pluginFoldChanged = true
  }

  baselinePrevious = bPrompt
  pluginPrevious = pPrompt
}

const sum = key => rows.reduce((total, row) => total + row[key], 0)
const money = value => value.toFixed(4)
const pct = (a, b) => b === 0 ? '—' : `${((a - b) / b * 100).toFixed(1)}%`

const header = ['turn', 'baseline_prompt', 'baseline_hit', 'baseline_miss', 'baseline_cost', 'plugin_prompt', 'plugin_hit', 'plugin_miss', 'plugin_cost', 'cost_delta', 'fold_events']
const csv = [
  header.join(','),
  ...rows.map(row => [
    row.n, row.bPrompt, row.bHit, row.bMiss, row.bCost.toFixed(6), row.pPrompt, row.pHit, row.pMiss, row.pCost.toFixed(6), (row.bCost - row.pCost).toFixed(6), row.folds,
  ].join(',')),
].join('\n') + '\n'
const outDir = fileURLToPath(new URL('../docs/experiments/', import.meta.url))
writeFileSync(`${outDir}default-vs-baseline.csv`, csv)
writeFileSync(`${outDir}default-vs-baseline.json`, JSON.stringify({
  generatedAt: new Date().toISOString(),
  assumptions: {
    turns: TURNS,
    toolTokens: TOOL_TOKENS,
    systemAndToolsTokens: SYSTEM_TOKENS,
    hitPricePerMillion: HIT_PRICE,
    missPricePerMillion: MISS_PRICE,
    foldAboveTokens: FOLD_ABOVE,
    foldKeepTurns: KEEP,
    foldBlockRatio: RATIO,
    foldCadence: CADENCE,
    outputTokensIncluded: false,
    syntheticConversation: true,
    tokenizer: 'deepseek_v4',
  },
  totals: {
    baseline: { hit: sum('bHit'), miss: sum('bMiss'), prompt: sum('bPrompt'), cost: baselineCumulative },
    plugin: { hit: sum('pHit'), miss: sum('pMiss'), prompt: sum('pPrompt'), cost: pluginCumulative },
    saving: baselineCumulative - pluginCumulative,
  },
  rows,
}, undefined, 2) + '\n')

const md = [
  '# Default preset vs full context',
  '',
  `Generated ${new Date().toISOString()} by \`scripts/experiment-default-vs-baseline.mjs ${TURNS} ${TOOL_TOKENS}\`.`,
  '',
  '## Assumptions',
  '',
  `- Synthetic ${TURNS}-turn conversation; every user/assistant/tool message is counted with the real DeepSeek v4 tokenizer.`,
  `- System prompt + tool schemas: ${SYSTEM_TOKENS.toLocaleString()} tokens (constant; all tools visible).`,
  `- Each turn: ~120 user + ~650 assistant + ${TOOL_TOKENS.toLocaleString()} tool-result tokens; the default preset adds ~300 tokens of hint/candidate overhead per turn.`,
  `- Default preset: fold when the block (turns older than the last ${KEEP}) is >= ${FOLD_ABOVE.toLocaleString()} tokens and >= ${RATIO}x the kept window, at most every ${CADENCE} turns.`,
  '- Cache model: prefix cache only. A fold invalidates the prefix at the first folded turn. Without a fold, the previous prompt is a hit and only newly appended messages miss.',
  `- Prices: hit ${HIT_PRICE}/M, miss ${MISS_PRICE}/M prompt tokens; output tokens are excluded.`,
  '',
  '## Totals',
  '',
  '| | baseline | default preset | change |',
  '|---|---:|---:|---:|',
  `| prompt tokens | ${sum('bPrompt').toLocaleString()} | ${sum('pPrompt').toLocaleString()} | ${pct(sum('pPrompt'), sum('bPrompt'))} |`,
  `| hit tokens | ${sum('bHit').toLocaleString()} | ${sum('pHit').toLocaleString()} | ${pct(sum('pHit'), sum('bHit'))} |`,
  `| miss tokens | ${sum('bMiss').toLocaleString()} | ${sum('pMiss').toLocaleString()} | ${pct(sum('pMiss'), sum('bMiss'))} |`,
  `| cost (USD) | ${money(baselineCumulative)} | ${money(pluginCumulative)} | ${money(baselineCumulative - pluginCumulative)} (${pct(pluginCumulative, baselineCumulative)}) |`,
  '',
  `Folds occurred at turns ${rows.filter(row => row.n > 1 && row.pMiss > 10_000).map(row => row.n).join(', ')}.`,
  `First cumulative break-even: turn ${(() => { let c = 0; for (const row of rows) { c += row.bCost - row.pCost; if (c > 0) return row.n } return 'not reached' })()}.`,
  `Last prompt: ${rows.at(-1).bPrompt.toLocaleString()} -> ${rows.at(-1).pPrompt.toLocaleString()} tokens.`,
  '',
  '## Per-turn detail',
  '',
  '| turn | base prompt | base hit | base miss | base $ | plugin prompt | plugin hit | plugin miss | plugin $ | base - plugin | fold |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|',
  ...rows.map(row => `| ${row.n} | ${row.bPrompt} | ${row.bHit} | ${row.bMiss} | ${row.bCost.toFixed(4)} | ${row.pPrompt} | ${row.pHit} | ${row.pMiss} | ${row.pCost.toFixed(4)} | ${(row.bCost - row.pCost).toFixed(4)} | ${row.n > 1 && row.pMiss > 10_000 ? 'yes' : ''} |`),
  '',
  '`yes` marks the turn where a fold was just applied; the big miss is the re-priced prompt suffix.',
  '',
].join('\n') + '\n'
writeFileSync(`${outDir}default-vs-baseline.md`, md)

console.log(`turns=${TURNS}  tool=${TOOL_TOKENS} tok  system+tools=${SYSTEM_TOKENS} tok  default preset (40000 / 5x / keep 3 / cadence 3)`)
console.log(`folds=${folds}  baseline prompt@last=${rows.at(-1).bPrompt}  plugin prompt@last=${rows.at(-1).pPrompt}`)
console.log(`hit price=${HIT_PRICE}/M  miss price=${MISS_PRICE}/M  (USD per million prompt tokens; output excluded)\n`)
console.log('turn | base prompt | base hit | base miss | base cost | plugin prompt | plugin hit | plugin miss | plugin cost | cost delta')
for (const row of rows) {
  const fold = row.folds !== (rows[row.n - 2]?.folds ?? 0) ? ' *fold' : ''
  console.log([
    String(row.n).padStart(4),
    String(row.bPrompt).padStart(11),
    String(row.bHit).padStart(8),
    String(row.bMiss).padStart(9),
    money(row.bCost).padStart(9),
    String(row.pPrompt).padStart(13),
    String(row.pHit).padStart(10),
    String(row.pMiss).padStart(11),
    money(row.pCost).padStart(11),
    money(row.bCost - row.pCost).padStart(10) + fold,
  ].join(' | '))
}
console.log(`\nbaseline totals: hit=${sum('bHit')} miss=${sum('bMiss')} cost=${money(baselineCumulative)}`)
console.log(`plugin totals:   hit=${sum('pHit')} miss=${sum('pMiss')} cost=${money(pluginCumulative)}`)
console.log(`cost saving: ${money(baselineCumulative - pluginCumulative)} (${pct(pluginCumulative, baselineCumulative)})`)
console.log(`prompt tokens last: ${rows.at(-1).bPrompt} -> ${rows.at(-1).pPrompt}`)
