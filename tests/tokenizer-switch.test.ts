import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config } from '../src/plugin/config.ts'
import { SettingsStore } from '../src/plugin/settings.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** A minimal but valid tokenizer: BPE over `a`, `b`, `ab`. */
const tinySpec = () => ({
  model: { type: 'BPE', vocab: { a: 0, b: 1, ab: 2, 'Ġ': 3, 'Ġa': 4 }, merges: ['a b', 'Ġ a'] },
  pre_tokenizer: { pretokenizers: [{ type: 'ByteLevel' }] },
  added_tokens: [{ content: '<|end|>', special: true }],
})

test('the settings dropdown switches the tokenizer at runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-switch-'))
  try {
    for (const version of [3, 4]) {
      const folder = join(dir, 'tokenizers', `deepseek_v${version}_tokenizer`)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'tokenizer.json'), JSON.stringify(tinySpec()), 'utf8')
    }
    const settings = new SettingsStore({ path: join(dir, 'settings.json'), onError: () => {} })
    const config = Config['~standard'].validate({
      logEdgeUpdates: false,
      tokenizerDir: join(dir, 'tokenizers'),
    }).value!
    const service = new TokenTreeService({ config, logger, settings })

    assert.deepEqual(
      service.settingsInfo().tokenizer.choices.map(choice => choice.id),
      ['auto', '3', '4', 'off'],
      'choices come from the directory, plus auto and off',
    )

    service.updateSettings({ tokenizerVersion: '3' })
    assert.equal(service.settingsInfo().tokenizer.version, 3, 'v3 selected')
    assert.equal(service.settingsInfo().budget.factor, 1, 'exact counts need no discount')

    service.updateSettings({ tokenizerVersion: 'off' })
    assert.equal(service.settingsInfo().tokenizer.version, 0, 'no tokenizer')
    assert.equal(service.settingsInfo().budget.factor, 0.85, 'estimates are discounted')

    service.updateSettings({ tokenizerVersion: null })
    assert.equal(service.settingsInfo().tokenizer.version, 4, 'cleared override falls back to auto = newest')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
