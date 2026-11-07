import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { SettingsStore } from '../src/plugin/settings.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function serviceWithSettings() {
  const files = new Map<string, string>()
  const settings = new SettingsStore({
    path: 'C:/tmp/session-settings.json',
    io: {
      readFile: path => files.get(path) ?? '{}',
      writeFile: (path, text) => { files.set(path, text) },
      exists: path => files.has(path),
      makeDir: () => {},
    },
    onError: () => {},
  })
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!
  return new TokenTreeService({ config, logger, settings })
}

test('hintAboveTokens and toolDeny are read through the session scope', () => {
  const service = serviceWithSettings()
  service.updateSettings({ hintAboveTokens: 1234, toolDeny: ['workflow'] }, 'session-a')
  assert.equal(service.effective('session-a').hintAboveTokens, 1234)
  assert.deepEqual(service.toolDeny('session-a'), ['workflow'])
  assert.equal(service.effective('session-b').hintAboveTokens, 30000)
  assert.deepEqual(service.toolDeny('session-b'), ['tree_mark', 'tree_focus'])
})

test('settingsInfo reports raw session overrides, not the merged global layer', () => {
  const service = serviceWithSettings()
  service.updateSettings({ autoInject: true })
  service.updateSettings({ autoInject: false }, 'session-a')
  const info = service.settingsInfo('session-a')
  assert.deepEqual(info.overrides, { autoInject: false })
  assert.equal(info.globalOverrides.autoInject, true)
})

test('a session-scoped tokenizer choice is rejected instead of being silently inert', () => {
  const service = serviceWithSettings()
  assert.throws(() => service.updateSettings({ tokenizerVersion: '3' }, 'session-a'), /global setting/)
})
