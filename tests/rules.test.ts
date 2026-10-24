import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { applyConstraint, applyRuleEdit, classifyTurn } from '../src/plugin/requirements.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

test('rules can be added, edited, toggled and removed by hand', () => {
  let list = []
  list = applyRuleEdit(list, { op: 'add', text: '发布前必须先问', at: 1 })
  list = applyRuleEdit(list, { op: 'add', text: '回答控制在 100 字', at: 2 })
  assert.equal(list.length, 2)
  assert.equal(list[0].source, 'manual', 'a hand-written rule is marked manual')
  assert.ok(list[0].id.length > 0, 'and it has an id')

  const [first] = list
  list = applyRuleEdit(list, { op: 'update', id: first.id, text: '发布或推送前必须先问', at: 3 })
  assert.equal(list[0].text, '发布或推送前必须先问')

  list = applyRuleEdit(list, { op: 'toggle', id: first.id, active: false, at: 4 })
  assert.equal(list[0].active, false)

  list = applyRuleEdit(list, { op: 'remove', id: first.id, at: 5 })
  assert.equal(list.length, 1)
  assert.equal(list[0].text, '回答控制在 100 字')
})

test('the classifier still produces automatic rules, with their own source', () => {
  const classification = classifyTurn('以下回答都在100字以内')
  assert.equal(classification.kind, 'constraint')
  const list = applyConstraint([], '以下回答都在100字以内', 7, classification)
  assert.equal(list.length, 1)
  assert.equal(list[0].source, 'auto')
  assert.ok(list[0].id.length > 0)
})

test('a hand-written rule survives a replay and reaches the hint', () => {
  const state = { ops: [] }
  const store = {
    path: 'memory',
    opsFor: () => state.ops,
    record: op => { state.ops.push(op) },
  }
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  const service = new TokenTreeService({ config, logger, store })
  const rules = service.editRule('s', { op: 'add', text: '不要擅自发布' })
  assert.ok(rules !== undefined, 'the rule was accepted')
  assert.equal(rules[0].text, '不要擅自发布')
  assert.equal(state.ops.length, 1, 'and recorded for the next replay')
  assert.equal(state.ops[0].action, 'rule')

  // The hint carries it, so the model actually sees the rule.
  const hint = service.retrievalHint('s')
  assert.ok(hint !== undefined && hint.includes('不要擅自发布'), 'the hint names the rule')

  // A fresh service replays the same session and gets the rule back.
  const replay = new TokenTreeService({
    config,
    logger,
    store: { path: 'memory', opsFor: () => state.ops, record: () => {} },
  })
  replay.backfillFromSession({ id: 's', snapshotEvents: () => [] })
  assert.equal(replay.constraintsOf('s')[0]?.text, '不要擅自发布')
})
