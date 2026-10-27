import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { planTurnFold } from '../src/plugin/fold.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function service() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  // A settings store in memory: without one, updateSettings has nowhere to write and the override
  // silently disappears (which is what the first version of this test measured).
  const current = {}
  const settings = {
    path: 'memory',
    all: () => ({ ...current }),
    apply: patch => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete current[key]
        else current[key] = value
      }
      return { ...current }
    },
  }
  return new TokenTreeService({ config, logger, settings })
}

function eventsOf(count) {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= count; turn++) {
    events.push({ type: 'turn/start', seq: ++seq, data: { turn } })
    events.push({ type: 'user/message', seq: ++seq, data: { role: 'user', turn, content: [{ type: 'text', text: 'q' + turn }] } })
    events.push({ type: 'assistant/message', seq: ++seq, data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: 'a' + turn }] } } })
    events.push({ type: 'turn/end', seq: ++seq, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

test('the always policy folds every finished turn except the keep window', () => {
  const events = eventsOf(5)
  const visible = events.map(event => event.seq)
  // keepTurns 0: only the opening turn stays, everything else is foldable.
  const all = planTurnFold(events, visible, 0)
  assert.equal(all.length, 4, 'four turns after the opening one')
  // keepTurns 2: the last two turns stay verbatim.
  const kept = planTurnFold(events, visible, 2)
  assert.equal(kept.length, 2, 'three turns minus the opening one and the keep window')
})

test('the policy is exposed and defaults to the threshold', () => {
  const instance = service()
  assert.equal(instance.effective().foldPolicy, 'threshold')
  instance.applyPreset('balanced')
  instance.updateSettings({ foldPolicy: 'always' })
  assert.equal(instance.effective().foldPolicy, 'always')
  assert.equal(instance.settingsInfo().base.foldPolicy, 'threshold', 'the base stays the config default')
  assert.equal(instance.settingsInfo().overrides.foldPolicy, 'always', 'the override carries the switch')
})
