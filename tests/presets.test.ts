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
  assert.equal(config.cacheHitPrice, 0, 'automatic thresholding is off until prices are filled')
  assert.equal(config.cacheMissPrice, 0)
  assert.equal(config.autoFold, true, 'prices drive the threshold when filled')
})

test('cache prices are per-session overridable', () => {
  const { settings } = store()
  const service = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings,
  })
  service.updateSettings({ cacheHitPrice: 1, cacheMissPrice: 50 }, 'session-a')
  assert.equal(service.effective('session-a').cacheHitPrice, 1)
  assert.equal(service.effective('session-a').cacheMissPrice, 50)
  assert.equal(service.effective().cacheHitPrice, 0, 'other scopes stay manual')
})

test('the panel offers default, tree-only, and off', () => {
  assert.equal(PRESETS.length, 3)
  const balanced = presetOf('balanced')
  const treeOnly = presetOf('treeOnly')
  const off = presetOf('off')
  assert.ok(balanced && treeOnly && off)
  assert.equal(balanced.settings.foldAboveTokens, 30000)
  assert.equal(balanced.settings.foldKeepTurns, 2)
  assert.deepEqual(balanced.settings.toolDeny, [], 'the default hides nothing')
  assert.equal(balanced.settings.autoFold, true, 'the default follows cache prices')
  assert.equal(treeOnly.settings.autoInject, false)
  assert.equal(treeOnly.settings.retrievalHint, false)
  assert.equal(treeOnly.settings.attachChoices, 0)
  assert.equal(treeOnly.settings.foldAboveTokens, 0)
  assert.equal(treeOnly.settings.foldBlockRatio, 0)
  assert.equal(treeOnly.settings.autoFold, false)
  assert.deepEqual(treeOnly.settings.toolDeny, [], 'tree-only keeps the tools callable')
  assert.equal(off.settings.autoInject, false)
  assert.equal(off.settings.retrievalHint, false)
  assert.equal(off.settings.attachChoices, 0)
  assert.equal(off.settings.foldAboveTokens, 0)
  assert.equal(off.settings.autoFold, false)
  assert.equal(off.settings.fileRegion, 'off')
  assert.ok((off.settings.toolDeny as string[]).includes('retrieve_context'), 'off hides retrieval')
  assert.ok((off.settings.toolDeny as string[]).includes('tree_query'), 'off hides tree tools')
  assert.equal(presetOf('aggressive'), undefined, 'the old cost bundle is gone')
  assert.equal(presetOf('conservative'), undefined, 'the old conservative bundle is gone')
  assert.equal(presetOf('coding'), undefined, 'the old coding bundle is gone')
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

test('off hides the plugin tools; tree-only leaves them available', () => {
  const { settings } = store()
  const service = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings,
  })
  service.applyPreset('off')
  assert.deepEqual(service.effective().toolDeny, ['retrieve_context', 'tree_query', 'tree_mark', 'tree_focus', 'tree_backtrack'])
  service.applyPreset('treeOnly')
  assert.deepEqual(service.toolDeny(), [], 'tree-only restores the tools')
  assert.equal(service.effective().foldAboveTokens, 0, 'tree-only still records without folding')
})

test('a preset applies to the scope it is asked for', () => {
  const { settings, files } = store()
  const service = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings,
  })
  // Session scope: the bundle lands on that conversation, the global set stays untouched.
  const applied = service.applyPreset('off', 'session-a')
  assert.ok(applied !== undefined)
  assert.equal(applied.effective.foldAboveTokens, 0, 'session sees the preset')
  assert.deepEqual(applied.effective.toolDeny, ['retrieve_context', 'tree_query', 'tree_mark', 'tree_focus', 'tree_backtrack'])
  const written = JSON.parse(files.get('C:/tmp/settings.json') as string)
  assert.deepEqual(Object.keys(written), ['sessions'], 'only the session map was written')
  assert.equal(written.sessions['session-a'].foldAboveTokens, 0)
})
