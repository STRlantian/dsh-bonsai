#!/usr/bin/env node
/** Compare the fold run with the baseline run and print the delta. */
import { readFileSync } from 'node:fs'

const folded = JSON.parse(readFileSync('docs/experiments/history-fold.json', 'utf8'))
const baseline = JSON.parse(readFileSync('docs/experiments/history-fold-baseline.json', 'utf8'))

const label = ['turn 1', 'turn 2', 'turn 3']
console.log('turn      baseline   folded   saved')
for (let index = 0; index < 3; index++) {
  const before = baseline.prompts[index]
  const after = folded.prompts[index]
  const saved = before - after
  console.log(`${label[index]}  ${String(before).padStart(8)}  ${String(after).padStart(6)}  ${String(saved).padStart(6)}`)
}
const turn3 = baseline.prompts[2] - folded.prompts[2]
console.log(`\nturn 3: ${turn3} tokens saved (${((turn3 / baseline.prompts[2]) * 100).toFixed(1)}%) with no model call`)
console.log(`fold diagnostics: ${JSON.stringify(folded.fold)}`)
