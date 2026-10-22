#!/usr/bin/env node
/**
 * Sanity-check the local tokenizer against the characters/2.5 estimate.
 *
 * Prints tokens per character for representative texts (English prose, Chinese prose,
 * mixed identifiers, code, JSON) and checks that every produced piece exists in the
 * vocabulary. A wild ratio or any unknown piece means the implementation is wrong and
 * must not be used for budget decisions.
 *
 * Usage:
 *   node scripts/tokenizer-check.mjs --tokenizer <path>/tokenizer.json
 */
import { loadTokenizer } from '../scripts/tokenizer-lib.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const path = argOf('tokenizer', '.tokenizer_tmp/deepseek_v4_tokenizer/tokenizer.json')

const samples = {
  english: 'Attention computes a weighted sum over token vectors in a transformer.',
  chinese: '备份窗口固定在下午三点十五分，保留十四天，归档到冷存储。',
  mixed: '服务 svc-12 的部署目录是 /srv/svc-12，配置只读挂载。',
  code: 'const x = { a: 1, b: [2, 3] };',
  json: '{"ok":true,"effective":{"autoInject":false,"hintMinNodes":40}}',
  tool: 'ran probe 备份窗口-0: exit 0, stdout "(no output)"',
  long: '与本次问题无关的工程细节、日志格式、部署顺序、值班安排、发布窗口、监控阈值、回滚流程、容量规划、成本核算、依赖升级与文档同步等。'.repeat(5),
}

const tokenizer = loadTokenizer(path)
console.log('name              chars  tokens  chars/token  heuristic  official/heuristic')
let unknownTotal = 0
for (const [name, text] of Object.entries(samples)) {
  const pieces = tokenizer.tokens(text)
  const unknown = tokenizer.unknownPieces(text)
  unknownTotal += unknown.length
  const heuristic = Math.ceil(text.length / 2.5)
  console.log(
    name.padEnd(16),
    String(text.length).padStart(5),
    String(pieces.length).padStart(7),
    (text.length / pieces.length).toFixed(2).padStart(12),
    String(heuristic).padStart(10),
    (pieces.length / heuristic).toFixed(2).padStart(19),
  )
}
console.log(`\nunknown pieces across samples: ${unknownTotal}`)
console.log('sample pieces (mixed):', tokenizer.tokens(samples.mixed).slice(0, 12))
console.log('sample pieces (english):', tokenizer.tokens(samples.english).slice(0, 12))
