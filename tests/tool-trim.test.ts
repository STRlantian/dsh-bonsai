import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

test('toolDeny is stored as a clean, unique list', () => {
  const service = new TokenTreeService({ config: Config['~standard'].validate({ logEdgeUpdates: false }).value!, logger })
  const settings = (service as unknown as { settings: undefined })
  assert.equal(settings.settings, undefined, 'a service without a settings store hides nothing')

  const withStore = new TokenTreeService({
    config: Config['~standard'].validate({ logEdgeUpdates: false }).value!,
    logger,
    settings: {
      path: 'memory',
      all: () => ({ toolDeny: ['workflow', 'schedule_create'] }),
      apply: () => ({}),
    } as never,
  })
  assert.deepEqual(withStore.toolDeny(), ['workflow', 'schedule_create'])
})

test('a tool restriction attempt is recorded for diagnostics', () => {
  const service = new TokenTreeService({ config: Config['~standard'].validate({ logEdgeUpdates: false }).value!, logger })
  service.noteToolRestriction('agent-1', ['workflow'], true)
  assert.deepEqual(service.settingsInfo().toolRestriction?.deny, ['workflow'], 'the hidden names are reported')
  assert.equal(service.settingsInfo().toolRestriction?.applied, true)
  assert.equal(service.settingsInfo().toolRestriction?.agentId, 'agent-1')
})
