import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** A service whose conversation is `words` nodes of `ab` text, sized by the tiny tokenizer. */
function serviceWith(words) {
  const dir = mkdtempSync(join(tmpdir(), 'tt-estimate-'))
  const tokenizerPath = join(dir, 'tokenizer.json')
  writeFileSync(tokenizerPath, JSON.stringify({
    model: { type: 'BPE', vocab: { a: 0, b: 1, ab: 2, 'Ġ': 3, 'Ġa': 4 }, merges: ['a b', 'Ġ a'] },
    pre_tokenizer: { pretokenizers: [{ type: 'ByteLevel' }] },
    added_tokens: [{ content: '<|end|>', special: true }],
  }), 'utf8')
  const config = Config['~standard'].validate({ logEdgeUpdates: false, tokenizerPath }).value!
  const service = new TokenTreeService({ config, logger })
  const tree = service.stateOf('s').tree
  for (let index = 0; index < words; index++) {
    tree.addNode({ kind: 'question', content: 'ab'.repeat(50), timestamp: index })
  }
  return { service, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the compaction estimate compares what it reads with what a turn then saves', () => {
  const { service, cleanup } = serviceWith(20)
  try {
    const estimate = service.compactionEstimate('s')
    assert.ok(estimate !== null, 'a real conversation has an estimate')
    assert.ok(estimate.readTokens > 0, 'the call reads the conversation')
    assert.equal(estimate.readTokens, estimate.conversationTokens, 'the whole history is read')
    assert.equal(estimate.savedPerTurn, estimate.conversationTokens - estimate.summaryTokens)
    assert.ok(estimate.turnsToBreakEven >= 1, 'never less than one turn')
    // The payoff is exactly "read N, save N - summary each turn", so assert the relation
    // rather than a magic number: a smaller conversation needs proportionally more turns.
    assert.equal(
      estimate.turnsToBreakEven,
      Math.ceil(estimate.readTokens / estimate.savedPerTurn),
      'turns to break even follows from the two token counts',
    )
  } finally {
    cleanup()
  }
})

test('an empty or tiny conversation has nothing to estimate', () => {
  const { service, cleanup } = serviceWith(0)
  try {
    assert.equal(service.compactionEstimate('s'), null)
  } finally {
    cleanup()
  }
})
