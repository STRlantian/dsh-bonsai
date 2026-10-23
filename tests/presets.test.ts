import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { PRESETS, presetOf } from '../src/plugin/presets.ts'
import { SettingsStore } from '../src/plugin/settings.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** An in-memory settings store, so a preset is applied exactly as in production. */
function store() {
  const files = new Map()
  const io = {
    readFile: path => files.get(path) ?? '{}',
    writeFile: (path, text) => { files.set(path, text) },
    exists: path => files.has(path),
    makeDir: () => {},
  }
  const settings = new SettingsStore({ path: 'C:/tmp/settings.json', io, onError: () => {} })
  return { settings, files }
}

test('the shipped default folds at 40k tokens', () => {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  assert.equal(config.foldAboveTokens, 40000)
  assert.equal(config.foldScope, 'turns')
  assert.equal(config.foldKeepTurns, 3)
})

test('the presets differ in exactly the knobs they advertise', () => {
  const conservative = presetOf('conservative')
  const balanced = presetOf('balanced')
  const aggressive = presetOf('aggressive')
  assert.ok(conservative && balanced && aggressive)
  assert.equal(conservative.settings.foldAboveTokens, 60000)
  assert.equal(balanced.settings.foldAboveTokens, 40000)
  assert.equal(aggressive.settings.foldAboveTokens, 20000)
  assert.equal(conservative.settings.toolDeny, null, 'conservative hides nothing')
  assert.equal(balanced.settings.toolDeny, null, 'balanced hides nothing either')
  assert.ok(Array.isArray(aggressive.settings.toolDeny), 'aggressive hides tools')
  assert.ok((aggressive.settings.toolDeny as string[]).includes('workflow'))
  assert.equal(presetOf('nope'), undefined)
  assert.equal(PRESETS.length, 3)
})

test('applying a preset writes the whole bundle at once', () => {
  const { settings, files } = store()
  const service = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings,
  })
  const applied = service.applyPreset('aggressive')
  assert.ok(applied !== undefined)
  assert.equal(applied.preset, 'aggressive')
  assert.equal(applied.effective.foldAboveTokens, 20000)
  assert.equal(applied.effective.foldKeepTurns, 2)
  const written = JSON.parse(files.get('C:/tmp/settings.json') as string)
  assert.equal(written.foldAboveTokens, 20000, 'persisted, not only in memory')
  assert.ok(Array.isArray(written.toolDeny), 'hidden tools persisted too')

  // Switching back clears what the previous preset added.
  service.applyPreset('conservative')
  assert.deepEqual(service.effective().foldAboveTokens, 60000)
  assert.equal(service.toolDeny().length, 0, 'tools are shown again')
  assert.equal(service.applyPreset('nope'), undefined)
})
