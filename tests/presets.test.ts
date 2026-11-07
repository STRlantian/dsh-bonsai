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

test('the shipped default folds at 30k tokens', () => {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  assert.equal(config.foldAboveTokens, 30000)
  assert.equal(config.foldScope, 'turns')
  assert.equal(config.foldKeepTurns, 2)
  assert.equal(config.foldBlockRatio, 8)
  assert.equal(config.foldCadence, 10)
})

test('there is exactly one shipped preset', () => {
  assert.equal(PRESETS.length, 1)
  const balanced = presetOf('balanced')
  assert.ok(balanced)
  assert.equal(balanced.settings.foldAboveTokens, 30000)
  assert.equal(balanced.settings.foldKeepTurns, 2)
  assert.deepEqual(balanced.settings.toolDeny, [], 'the default hides nothing')
  assert.equal(presetOf('treeOnly'), undefined, 'the old tree-only preset is gone')
  assert.equal(presetOf('aggressive'), undefined, 'the old aggressive preset is gone')
  assert.equal(presetOf('conservative'), undefined, 'the old conservative preset is gone')
  assert.equal(presetOf('coding'), undefined, 'the old coding preset is gone')
  assert.equal(presetOf('nope'), undefined)
})

test('applying the default writes the whole bundle at once', () => {
  const { settings, files } = store()
  const service = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings,
  })
  const applied = service.applyPreset('balanced')
  assert.ok(applied !== undefined)
  assert.equal(applied.preset, 'balanced')
  assert.equal(applied.effective.foldAboveTokens, 30000)
  assert.equal(applied.effective.foldKeepTurns, 2)
  const written = JSON.parse(files.get('C:/tmp/settings.json') as string)
  assert.equal(written.foldAboveTokens, 30000, 'persisted, not only in memory')
  assert.deepEqual(written.toolDeny, [], 'no tools are hidden')
  assert.equal(service.applyPreset('nope'), undefined)
})

test('applying the default clears a previous numeric override', () => {
  const { settings } = store()
  const service = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings,
  })
  service.updateSettings({ foldAboveTokens: 10000, toolDeny: ['workflow'] })
  assert.equal(service.effective().foldAboveTokens, 10000)
  service.applyPreset('balanced')
  assert.equal(service.effective().foldAboveTokens, 30000, 'the old 10k override is cleared')
  assert.deepEqual(service.toolDeny(), [], 'the old hidden-tool override is cleared')
})

test('a preset applies to the scope it is asked for', () => {
  const { settings, files } = store()
  const service = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings,
  })
  // Session scope: the bundle lands on that conversation, the global set stays untouched.
  const applied = service.applyPreset('balanced', 'session-a')
  assert.ok(applied !== undefined)
  assert.equal(applied.effective.foldKeepTurns, 2, 'session sees the preset')
  const written = JSON.parse(files.get('C:/tmp/settings.json') as string)
  assert.deepEqual(Object.keys(written), ['sessions'], 'only the session map was written')
  assert.equal(written.sessions['session-a'].foldAboveTokens, 30000)
})
