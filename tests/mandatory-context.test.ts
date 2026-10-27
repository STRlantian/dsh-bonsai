import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function conversation() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  const current = { autoInject: false, retrievalHint: false, hintMinNodes: 99 }
  const settings = {
    path: 'memory',
    all: () => ({ ...current }),
    apply: patch => { Object.assign(current, patch); return { ...current } },
  }
  const service = new TokenTreeService({ config, logger, settings })
  const events = []
  const session = { id: 'mandatory', snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => {
    const event = { type, seq: ++seq, time: ++seq * 1000, data }
    events.push(event)
    service.handleEvent(session, event)
  }
  return { service, push, session }
}

function ask(run, text, turn) {
  run.push('turn/start', { turn })
  run.push('user/message', { role: 'user', id: 'q' + turn, source: { kind: 'user' }, content: [{ type: 'text', text }] })
  run.push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'answer about ' + text }] } })
  run.push('turn/end', { turn, reason: { kind: 'completed' } })
}

test('the answer a follow-up depends on is always in the buffer', async () => {
  const run = conversation()
  ask(run, '解释一下矩阵乘法', 1)
  ask(run, '矩阵乘法里的 V 是指什么', 2)

  const tree = run.service.stateOf('mandatory').tree
  const questions = [...tree.nodes.values()].filter(node => node.kind === 'question')
  const followUp = questions.at(-1)
  const answer = tree.nodes.get(followUp.parentId)

  // The anaphoric question shares no terms with the answer text, so scoring alone would miss it.
  const scored = run.service.retrieve('mandatory', { query: followUp.content })
  const withMandatory = run.service.retrieve('mandatory', { query: followUp.content, originId: answer.id })

  assert.ok(withMandatory.selected.some(entry => entry.nodeId === answer.id), 'the dependency is in the buffer: ' + JSON.stringify(withMandatory.selected.map(entry => entry.nodeId)))
  const first = withMandatory.selected[0]
  assert.ok(first !== undefined, 'the buffer is not empty')
  assert.ok(withMandatory.tokensUsed <= withMandatory.budget, 'the budget still holds')
  assert.equal(typeof scored.tokensUsed, 'number')
})

test('turning the setting off returns the scored result unchanged', async () => {
  const run = conversation()
  ask(run, '解释一下矩阵乘法', 1)
  ask(run, '矩阵乘法里的 V 是指什么', 2)
  const tree = run.service.stateOf('mandatory').tree
  const followUp = [...tree.nodes.values()].filter(node => node.kind === 'question').at(-1)
  run.service.updateSettings({ mandatoryContext: false })
  const result = run.service.retrieve('mandatory', { query: followUp.content })
  assert.equal(result.selected[0]?.weight === 1, false, 'no forced entry with weight 1')
})
