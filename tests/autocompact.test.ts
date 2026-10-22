import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** A minimal valid tokenizer: BPE over `a`, `b`, `ab`. */
const tinySpec = () => ({
  model: { type: 'BPE', vocab: { a: 0, b: 1, ab: 2, 'Ġ': 3, 'Ġa': 4 }, merges: ['a b', 'Ġ a'] },
  pre_tokenizer: { pretokenizers: [{ type: 'ByteLevel' }] },
  added_tokens: [{ content: '<|end|>', special: true }],
})

test('auto-compaction fires only above the threshold and not during the cooldown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-autocompact-'))
  try {
    const tokenizerPath = join(dir, 'tokenizer.json')
    writeFileSync(tokenizerPath, JSON.stringify(tinySpec()), 'utf8')
    const config = Config['~standard'].validate({
      logEdgeUpdates: false,
      tokenizerPath,
      autoCompactAboveTokens: 50,
      autoCompactCooldownMs: 1_000,
    })
    assert.ok(config.value !== undefined)
    const service = new TokenTreeService({ config: config.value, logger })
    const tree = service.stateOf('s').tree

    // Under the threshold: nothing to do.
    tree.addNode({ kind: 'question', content: 'ab'.repeat(5), timestamp: 1 })
    assert.equal(service.autoCompactDue('s', 0), null, 'small conversation is left alone')

    // Over it: due, and reported with both numbers.
    tree.addNode({ kind: 'question', content: 'ab'.repeat(80), timestamp: 2 })
    const due = service.autoCompactDue('s', 0)
    assert.ok(due !== null, 'large conversation is due')
    assert.equal(due?.threshold, 50)
    assert.ok((due?.tokens ?? 0) >= 50)

    // Right after compacting, the cooldown blocks a second attempt.
    service.noteCompacted('s', 0)
    assert.equal(service.autoCompactDue('s', 500), null, 'cooldown holds')
    assert.ok(service.autoCompactDue('s', 2_000) !== null, 'cooldown expires')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('auto-compaction stays off by default and without a tokenizer', () => {
  const disabled = Config['~standard'].validate({ logEdgeUpdates: false }).value
  assert.equal(disabled?.autoCompactAboveTokens, 0, 'off by default')
  const service = new TokenTreeService({ config: disabled!, logger })
  const tree = service.stateOf('s').tree
  tree.addNode({ kind: 'question', content: 'ab'.repeat(500), timestamp: 1 })
  assert.equal(service.autoCompactDue('s', 0), null, 'a zero threshold never compacts')
})
