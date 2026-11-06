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
  const learning = presetOf('learning')
  const coding = presetOf('coding')
  const aggressive = presetOf('aggressive')
  assert.ok(conservative && balanced && learning && coding && aggressive)
  assert.equal(conservative.settings.foldAboveTokens, 60000)
  assert.equal(balanced.settings.foldAboveTokens, 40000)
  assert.equal(aggressive.settings.foldAboveTokens, 10000)
  // An empty list is the explicit "show every tool"; only undefined falls back to the default.
  assert.deepEqual(conservative.settings.toolDeny, [], 'conservative hides nothing')
  assert.deepEqual(balanced.settings.toolDeny, [], 'balanced hides nothing either')
  assert.ok(Array.isArray(aggressive.settings.toolDeny), 'aggressive hides tools')
  assert.ok((aggressive.settings.toolDeny as string[]).includes('workflow'))
  assert.equal(presetOf('nope'), undefined)
  assert.equal(PRESETS.length, 6)
})

test('the tree-only preset switches every model-facing behaviour off', () => {
  const treeOnly = presetOf('treeOnly')
  assert.ok(treeOnly !== undefined)
  assert.equal(treeOnly.settings.autoInject, false)
  assert.equal(treeOnly.settings.retrievalHint, false)
  assert.equal(treeOnly.settings.attachChoices, 0, 'no candidate block')
  assert.equal(treeOnly.settings.foldAboveTokens, 0, 'no folding')
  assert.equal(treeOnly.settings.foldBlockRatio, 0)
  assert.equal(treeOnly.settings.mandatoryContext, false)
  assert.deepEqual(treeOnly.settings.toolDeny, [])
})

test('the two usage presets carry the switches that make them different', () => {
  const learning = presetOf('learning')
  const coding = presetOf('coding')
  assert.ok(learning && coding)
  // Learning: turns are the unit, and the candidate block is small and always offered.
  assert.equal(learning.settings.foldScope, 'turns')
  assert.equal(learning.settings.attachChoices, 6)
  assert.equal(learning.settings.attachSummary, false)
  assert.equal(learning.settings.attachGate, 'always')
  // Coding: tool output is the bulk of the history, so scope switches to tools.
  assert.equal(coding.settings.foldScope, 'tools')
  assert.equal(coding.settings.foldKeepTurns, 3)
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
  assert.equal(applied.effective.foldAboveTokens, 10000)
  assert.equal(applied.effective.foldKeepTurns, 1)
  const written = JSON.parse(files.get('C:/tmp/settings.json') as string)
  assert.equal(written.foldAboveTokens, 10000, 'persisted, not only in memory')
  assert.ok(Array.isArray(written.toolDeny), 'hidden tools persisted too')

  // Switching back clears what the previous preset added.
  service.applyPreset('conservative')
  assert.deepEqual(service.effective().foldAboveTokens, 60000)
  assert.equal(service.toolDeny().length, 0, 'tools are shown again')
  assert.equal(service.applyPreset('nope'), undefined)
})

test('switching presets clears the previous bundle entirely', () => {
  const { settings } = store()
  const service = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings,
  })
  service.applyPreset('treeOnly')
  service.applyPreset('conservative')
  const effective = service.effective()
  assert.equal(effective.autoReflect, true, 'reflection comes back')
  assert.equal(effective.attachChoices, 10, 'the candidate block comes back')
  assert.equal(effective.foldCadence, 3, 'the cadence comes back')
  assert.equal(effective.foldBlockRatio, 5, 'the block ratio comes back')
  assert.equal(effective.fileRegion, 'auto', 'the file region comes back')
  assert.equal(effective.mandatoryContext, true, 'mandatory context comes back')
})

test('a preset applies to the scope it is asked for', () => {
  const { settings, files } = store()
  const service = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings,
  })
  // Session scope: the bundle lands on that conversation, the global set stays untouched.
  const applied = service.applyPreset('learning', 'session-a')
  assert.ok(applied !== undefined)
  assert.equal(applied.effective.foldKeepTurns, 2, 'session sees the preset')
  assert.equal(service.effective().foldKeepTurns, 3, 'global still has the profile default')
  const written = JSON.parse(files.get('C:/tmp/settings.json') as string)
  assert.deepEqual(Object.keys(written), ['sessions'], 'only the session map was written')
  assert.equal(written.sessions['session-a'].foldKeepTurns, 2)
  // Global scope still works the old way.
  service.applyPreset('learning')
  const global = JSON.parse(files.get('C:/tmp/settings.json') as string)
  assert.equal(global.foldKeepTurns, 2, 'global bundle written')
})
