import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compileTokenizer, loadTokenizerFile } from '../src/core/tokenizer.ts'
import { Config } from '../src/plugin/config.ts'
import { parseGeneration, resolveTokenizer } from '../src/plugin/tokenizer-select.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

/** Quiet logger. */
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/**
 * A minimal byte-level BPE spec, small enough to assert on by hand.
 *
 * Pieces: "a", "b", "ab", "Ġ" (space), "Ġa". Merges: "a b" then "Ġ a".
 * @returns The spec object.
 */
function tinySpec() {
  return {
    model: {
      type: 'BPE',
      vocab: { a: 0, b: 1, ab: 2, 'Ġ': 3, 'Ġa': 4 },
      merges: ['a b', 'Ġ a'],
    },
    pre_tokenizer: {
      pretokenizers: [
        { type: 'ByteLevel' },
      ],
    },
    added_tokens: [{ content: '<|end|>', special: true }],
  }
}

test('the local tokenizer applies merges in rank order', () => {
  const tokenizer = compileTokenizer(tinySpec())
  assert.deepEqual(tokenizer.pieces('ab'), ['ab'])
  assert.equal(tokenizer.count('ab'), 1)
  // No merged piece exists for "ba", so it stays two symbols.
  assert.equal(tokenizer.count('ba'), 2)
  // A leading space becomes the byte-level stand-in and merges with "a".
  assert.equal(tokenizer.count(' a'), 1)
})

test('special tokens count as one piece and are split before merging', () => {
  const tokenizer = compileTokenizer(tinySpec())
  assert.deepEqual(tokenizer.pieces('<|end|>'), ['<|end|>'])
  assert.equal(tokenizer.count('a<|end|>'), 2)
})

test('loading a tokenizer file reports a clear error for unsupported models', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-tokenizer-'))
  try {
    const path = join(dir, 'tokenizer.json')
    writeFileSync(path, JSON.stringify({ model: { type: 'Unigram', vocab: {}, merges: [] } }), 'utf8')
    assert.throws(() => loadTokenizerFile(path), /unsupported tokenizer model/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the real tokenizer, when the file is present, counts Chinese and English differently', t => {
  const path = 'C:/Users/ASUS/.dsh/token-tree/deepseek_v4_tokenizer/tokenizer.json'
  let tokenizer
  try {
    tokenizer = loadTokenizerFile(path)
  } catch {
    t.skip('no tokenizer file in this environment')
    return
  }
  const english = tokenizer.count('Attention computes a weighted sum over token vectors in a transformer.')
  const chinese = tokenizer.count('备份窗口固定在下午三点十五分，保留十四天。')
  // English prose packs several characters per token; CJK does not. The estimate used
  // to assume one constant for both, which is why these differ so much.
  assert.ok(english > 0 && english < 20, `english tokens ${english}`)
  assert.ok(chinese > 10, `chinese tokens ${chinese}`)
  const englishPerChar = 'Attention computes a weighted sum over token vectors in a transformer.'.length / english
  const chinesePerChar = '备份窗口固定在下午三点十五分，保留十四天。'.length / chinese
  assert.ok(englishPerChar > chinesePerChar * 2, 'English packs more characters per token than CJK')
})

test('with a tokenizer the hint is gated on conversation tokens, not node count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-hint-'))
  try {
    const path = join(dir, 'tokenizer.json')
    writeFileSync(path, JSON.stringify(tinySpec()), 'utf8')
    const config = Config['~standard'].validate({
      logEdgeUpdates: false,
      tokenizerPath: path,
      hintAboveTokens: 200,
    })
    assert.ok(config.value !== undefined)
    const service = new TokenTreeService({ config: config.value, logger })

    // Plenty of nodes, but only a handful of tokens: the gate stays closed. Measuring
    // node count here is exactly the proxy this replaces.
    const state = service.stateOf('session-t')
    for (let index = 0; index < 50; index++) state.tree.addNode({ kind: 'question', content: 'ab', timestamp: index })
    assert.equal(service.retrievalHint('session-t'), undefined, 'node count alone does not open the gate')

    // Growing the conversation past the token threshold opens it.
    state.tree.addNode({ kind: 'question', content: 'ab'.repeat(400), timestamp: 100 })
    const hint = service.retrievalHint('session-t')
    assert.ok(hint !== undefined && hint.includes('retrieve_context'), 'conversation tokens open the gate')
    assert.ok((service.settingsInfo().lastHint?.counted ?? 0) >= 200, 'the decision reports the measured size')

    // With the tokenizer disabled, the node count is still the fallback.
    const fallback = new TokenTreeService({
      config: Config['~standard'].validate({ logEdgeUpdates: false, hintMinNodes: 5, tokenizerVersion: 'off' }).value!,
      logger,
    })
    const plain = fallback.stateOf('session-u')
    assert.equal(fallback.retrievalHint('session-u'), undefined)
    for (let index = 0; index < 6; index++) plain.tree.addNode({ kind: 'question', content: 'ab', timestamp: index })
    assert.ok(fallback.retrievalHint('session-u') !== undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the drift monitor compares billed growth against counted growth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-drift-'))
  try {
    const path = join(dir, 'tokenizer.json')
    writeFileSync(path, JSON.stringify(tinySpec()), 'utf8')
    const config = Config['~standard'].validate({
      logEdgeUpdates: false,
      tokenizerPath: path,
      hintAboveTokens: 1,
    })
    assert.ok(config.value !== undefined)
    const service = new TokenTreeService({ config: config.value, logger })
    const session = { id: 'session-drift', snapshotEvents: () => [] }

    // The provider is simulated as billing 1.1× whatever the tokenizer counted, applied
    // to the *growth* of the context (a constant framework overhead cancels out, which is
    // exactly the property the monitor relies on).
    // The gate now measures the conversation path, so the test grows the tree: each turn
    // appends one node, and the billed size tracks the counted growth at 1.1×.
    const growth = ['ab'.repeat(400), 'ab'.repeat(900), 'ab'.repeat(1_800), 'ab'.repeat(3_600)]
    const tree = service.stateOf('session-drift').tree
    let billed = 1_000
    let previousCounted = 0
    for (const [index, text] of growth.entries()) {
      tree.addNode({ kind: 'question', content: text, timestamp: index })
      service.retrievalHint('session-drift', [])
      const counted = service.conversationTokens('session-drift')
      billed += Math.round((counted - previousCounted) * 1.1)
      previousCounted = counted
      service.handleEvent(session, {
        type: 'assistant/message',
        seq: index + 1,
        time: index,
        data: { usage: { inputTokens: billed, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      })
    }
    const drift = service.driftInfo()
    assert.ok(drift.samples >= 2, `expected samples, got ${drift.samples}`)
    assert.ok(drift.ratio !== null && Math.abs(drift.ratio - 1.1) < 0.15, `expected ~1.1, got ${drift.ratio}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the tokenizer generation is read out of the model name', () => {
  assert.equal(parseGeneration('4'), 4)
  assert.equal(parseGeneration('v3'), 3)
  assert.equal(parseGeneration('deepseek-v4'), 4)
  assert.equal(parseGeneration('deepseek-r1'), 3, 'r1 shares the v3 vocabulary')
  assert.equal(parseGeneration('deepseek-r1-0528'), 3)
  assert.equal(parseGeneration('auto'), undefined)
  assert.equal(parseGeneration('deepseek-flash'), undefined)
})

test('the resolver matches by generation, by name, and reports every fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-select-'))
  try {
    const spec = JSON.stringify(tinySpec())
    for (const version of [3, 4]) {
      const folder = join(dir, `deepseek_v${version}_tokenizer`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'tokenizer.json'), spec, 'utf8')
    }
    // A non-DeepSeek family, installed the same way: a directory named after the model.
    mkdirSync(join(dir, 'qwen2.5'), { recursive: true })
    writeFileSync(join(dir, 'qwen2.5', 'tokenizer.json'), spec, 'utf8')

    const auto = resolveTokenizer({ dir, requested: 'auto' })
    assert.equal(auto?.version, 4, 'auto picks the newest generation')
    assert.equal(auto?.available.length, 3, 'all three entries are reported')

    const pinned = resolveTokenizer({ dir, requested: 'v3' })
    assert.equal(pinned?.version, 3)

    const r1 = resolveTokenizer({ dir, requested: 'deepseek-r1' })
    assert.equal(r1?.version, 3, 'r1 shares the v3 vocabulary')

    const missing = resolveTokenizer({ dir, requested: 'v9' })
    assert.equal(missing?.version, 4, 'an uninstalled generation falls back to the newest')
    assert.ok(missing?.reason.includes('fell back'))

    // The model-id path is what makes a non-DeepSeek provider work at all.
    const byModel = resolveTokenizer({ dir, requested: 'auto', modelId: 'qwen2.5' })
    assert.equal(byModel?.name, 'qwen2.5')
    assert.ok(byModel?.reason.includes('model id'))
    const unknownModel = resolveTokenizer({ dir, requested: 'auto', modelId: 'some-other-model' })
    assert.equal(unknownModel?.version, 4, 'an unknown model falls back rather than failing')

    const explicit = resolveTokenizer({ dir, requested: 'auto', explicitPath: join(dir, 'deepseek_v3_tokenizer', 'tokenizer.json') })
    assert.equal(explicit?.version, 0, 'an explicit file wins')

    assert.equal(resolveTokenizer({ dir, requested: 'off' }), undefined, 'off disables the tokenizer')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a node is sized with the tokenizer at creation, not corrected later', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-write-'))
  try {
    const path = join(dir, 'tokenizer.json')
    writeFileSync(path, JSON.stringify(tinySpec()), 'utf8')
    const config = Config['~standard'].validate({ logEdgeUpdates: false, tokenizerPath: path }).value!
    const service = new TokenTreeService({ config, logger })
    const session = { id: 'session-w', snapshotEvents: () => [] }
    service.handleEvent(session, {
      type: 'user/message',
      seq: 1,
      time: 1,
      data: { role: 'user', content: [{ type: 'text', text: 'abababab' }], source: { kind: 'user' } },
    })
    const tree = service.treeOf('session-w')
    const created = [...tree.nodes.values()].find(node => node.content === 'abababab')
    assert.ok(created !== undefined)
    // 'ab' merges to one piece, so eight characters are four tokens — the character
    // estimate would have said two.
    assert.equal(created.tokens, 4, 'measured at write time')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})