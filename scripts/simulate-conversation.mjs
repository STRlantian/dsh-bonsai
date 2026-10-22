#!/usr/bin/env node
/**
 * Walk a simulated conversation through the token accounting and show what the plugin
 * would decide at each turn.
 *
 * This is the offline counterpart of "let it run for a while": it replays a fixed
 * bilingual conversation, and for every turn reports the numbers the plugin now uses —
 * exact counts from the chosen tokenizer, the learned two-class estimate, the old
 * single-constant estimate — plus what the hint gate would do at the configured threshold.
 *
 * It also answers the version question directly: both installed tokenizer generations are
 * run over the same text so their divergence is visible.
 *
 * Usage:
 *   node scripts/simulate-conversation.mjs --dir C:/Users/ASUS/.dsh/token-tree --threshold 12000
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadTokenizer } from './tokenizer-lib.mjs'
import { discoverGenerations } from '../src/plugin/tokenizer-select.ts'
import { TokenRatio } from '../src/core/ratio.ts'
import { estimateTokens } from '../src/core/tokens.ts'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const dir = argOf('dir', 'C:/Users/ASUS/.dsh/token-tree')
const threshold = Number(argOf('threshold', '12000'))

const generations = discoverGenerations(dir)
if (generations.length === 0) {
  console.error(`no tokenizers under ${dir}`)
  process.exit(1)
}
const loaded = generations.map(entry => ({ version: entry.version, tokenizer: loadTokenizer(entry.path) }))
const newest = loaded[loaded.length - 1]
console.log(`tokenizers: ${loaded.map(entry => `v${entry.version}`).join(', ')} · using v${newest.version} · hint threshold ${threshold}\n`)

/**
 * A conversation that looks like real use: Chinese explanation, English identifiers, a
 * pasted stack trace, a JSON config, and a long tool dump.
 */
const turns = [
  { role: 'user', text: '帮我看看这个报错：TypeError: Cannot read properties of undefined (reading "map")，出现在 src/parser.ts:42。' },
  { role: 'assistant', text: '看起来是在空数组上调用 map。请确认 tokens 是否在解析失败时被置为 undefined，建议在函数入口加一行 `if (!tokens) return []`。' },
  { role: 'user', text: '改完了。顺便问一下，我们的部署目录 /srv/svc-12 的配置只读挂载是怎么做的？' },
  { role: 'assistant', text: '配置以只读卷挂载在 /srv/svc-12/config，日志软链到 /var/log/svc-12，容器启动时校验 sha256。' },
  { role: 'tool', text: 'ran probe svc-12: exit 0, stdout "(no output)", stderr ""' },
  { role: 'user', text: '把刚才那段配置文件贴出来。' },
  { role: 'tool', text: JSON.stringify({ service: 'svc-12', replicas: 3, limits: { cpu: '500m', memory: '512Mi' }, probes: { liveness: '/healthz', readiness: '/ready' }, env: ['LOG_LEVEL=info'] }, undefined, 2) },
  { role: 'assistant', text: '这是当前配置：3 副本，CPU 500m / 内存 512Mi，探针分别在 /healthz 与 /ready。' },
  { role: 'user', text: '如果要做灰度，比例建议多少？另外备份窗口我记得是 03:15？' },
  { role: 'assistant', text: '灰度按 5% 起步、每阶观察 6 小时、回滚阈值 2%。备份窗口确实是 03:15，保留 14 天。' },
]

const ratio = new TokenRatio()
let cumulative = 0
let previousCounted = 0
console.log('turn  文本长度   精确(v最新)  精确(v旧)   学习比例  旧估算   累计      提示?')
for (const [index, turn] of turns.entries()) {
  const exact = newest.tokenizer.count(turn.text)
  const older = loaded.length > 1 ? loaded[0].tokenizer.count(turn.text) : exact
  const learned = ratio.estimate(turn.text)
  const legacy = estimateTokens(turn.text)
  ratio.observe(turn.text, exact)
  cumulative += exact
  previousCounted = cumulative
  const hint = cumulative >= threshold ? 'YES' : '-'
  console.log(
    String(index + 1).padStart(4),
    String(turn.text.length).padStart(9),
    String(exact).padStart(11),
    String(older).padStart(10),
    String(learned).padStart(9),
    String(legacy).padStart(8),
    String(cumulative).padStart(8),
    hint.padStart(7),
  )
}

const { wide, narrow } = ratio.coefficients()
const totalExact = newest.tokenizer.count(turns.map(turn => turn.text).join(''))
const totalOlder = loaded.length > 1 ? loaded[0].tokenizer.count(turns.map(turn => turn.text).join('')) : totalExact
console.log(`\nlearned ratio: ${wide.toFixed(3)} tok/wide-char, ${narrow.toFixed(3)} tok/narrow-char (${ratio.observations} samples)`)
console.log(`whole conversation: exact v${newest.version} ${totalExact} tok · v${loaded[0].version} ${totalOlder} tok`
  + ` · divergence ${totalExact === totalOlder ? '0' : `${((totalOlder - totalExact) / totalExact * 100).toFixed(1)}%`}`)

// Where the gate would fire, under each estimator: which turn it crosses at, and the
// cumulative token count there. A turn difference is the practical cost of a wrong count.
const joined = turns.map(turn => turn.text)
const crossing = counter => {
  let sum = 0
  for (const [index, text] of joined.entries()) {
    sum += counter(text)
    if (sum >= threshold) return { turn: index + 1, sum }
  }
  return { turn: null, sum }
}
const exactCross = crossing(text => newest.tokenizer.count(text))
const legacyCross = crossing(estimateTokens)
const fmt = value => (value.turn === null ? 'never' : `turn ${value.turn} (${value.sum} tok)`)
console.log(`\ngate at ${threshold} tok → exact: ${fmt(exactCross)} · old estimate: ${fmt(legacyCross)}`)

// What a stale tokenizer would look like to the drift monitor. The two installed
// generations happen to share a vocabulary here, so the inflation is synthetic: it stands
// for "the model moved on and the file did not".
const inflation = 1.3
const driftRatios = []
for (let index = 1; index < turns.length; index++) {
  const countedDelta = newest.tokenizer.count(turns[index].text)
  if (countedDelta < 5) continue
  driftRatios.push(inflation)
}
const mean = driftRatios.reduce((sum, value) => sum + value, 0) / driftRatios.length
console.log(`stale-tokenizer simulation (billed = ${inflation}× counted): drift ratio ${mean.toFixed(2)}`
  + ` → ${mean > 1.2 ? 'ALARM (update tokenizerPath/tokenizerVersion)' : 'within tolerance'}`)

