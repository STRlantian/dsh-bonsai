import test from 'node:test'
import assert from 'node:assert/strict'

import { blockTokensOf, foldWorthIt, keptTokensOf } from '../src/plugin/fold.ts'

const fold = turn => ({ turn, startSeq: turn * 10, endSeq: turn * 10 + 1, turns: 1, seqs: [turn * 10], data: {} })

test('the block is the sum of the turns about to leave', () => {
  const tokens = new Map([[1, 500], [2, 4000], [3, 3000], [4, 800]])
  assert.equal(blockTokensOf([fold(2), fold(3)], tokens), 7000, 'only the folded turns count')
  // The head (turn 1) sits before the fold point and stays cached, so it is not part of the window.
  assert.equal(keptTokensOf([fold(2), fold(3)], tokens), 800, 'only what follows the fold point is re-priced')
})

test('a fold is worth it only when the block clears the floor', () => {
  assert.equal(foldWorthIt(39000, 4000, 40000, 0), false, 'below the absolute floor')
  assert.equal(foldWorthIt(40000, 4000, 40000, 0), true, 'at the floor')
  assert.equal(foldWorthIt(500, 100, 0, 0), true, '0 disables the floor')
})

test('a fold is worth it only when the block dwarfs the keep window', () => {
  // 50x cache pricing: a fold re-prices the keep window, so the block has to pay that back.
  assert.equal(foldWorthIt(10000, 4000, 0, 5), false, '2.5x is not enough')
  assert.equal(foldWorthIt(20000, 4000, 0, 5), true, 'exactly 5x')
  assert.equal(foldWorthIt(20000, 4000, 40000, 5), false, 'the floor still applies')
  assert.equal(foldWorthIt(3, 4000, 0, 5), false, 'a tiny block never justifies the break')
})

test('both rules together are the strictest of the two', () => {
  assert.equal(foldWorthIt(50000, 9000, 40000, 5), true, '40k floor and 45k window rule are both cleared')
  assert.equal(foldWorthIt(43000, 9000, 40000, 5), false, 'the window rule is higher than the floor here')
})
