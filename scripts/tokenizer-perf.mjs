#!/usr/bin/env node
/**
 * How fast is the local tokenizer on realistic context sizes?
 *
 * The pre-step hook would count the whole conversation on every turn, so the cost has
 * to be known before wiring it in: a few milliseconds is free, a few hundred is not.
 *
 * Usage: node scripts/tokenizer-perf.mjs --tokenizer <path>/tokenizer.json
 */
import { loadTokenizer } from './tokenizer-lib.mjs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const path = argOf('tokenizer', '.tokenizer_tmp/deepseek_v4_tokenizer/tokenizer.json')

const started = performance.now()
const tokenizer = loadTokenizer(path)
console.log(`load: ${(performance.now() - started).toFixed(0)} ms`)

const pattern = '与本次问题无关的工程细节、日志格式、部署顺序、值班安排、发布窗口。The quick brown fox jumps over the lazy dog. '
for (const size of [1_000, 5_000, 20_000, 60_000, 200_000]) {
  const text = pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size)
  const t0 = performance.now()
  const tokens = tokenizer.count(text)
  const ms = performance.now() - t0
  console.log(`${String(size).padStart(7)} chars → ${String(tokens).padStart(7)} tokens in ${ms.toFixed(1).padStart(8)} ms`)
}
