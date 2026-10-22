import test from 'node:test'
import assert from 'node:assert/strict'

import { applyConstraint, classifyTurn } from '../src/plugin/requirements.ts'

test('constraint turns are recognised and topic turns are not', () => {
  assert.equal(classifyTurn('以下所有的回答都限制在100字以内，越短越好').kind, 'constraint')
  assert.equal(classifyTurn('以后都用中文回答').kind, 'constraint')
  assert.equal(classifyTurn('从现在起只输出结论，不要解释').kind, 'constraint')
  assert.equal(classifyTurn('什么是复杂度').kind, 'topic')
  assert.equal(classifyTurn('简单介绍线段树').kind, 'topic')
  assert.equal(classifyTurn('介绍如何编写 daw 的 vst').kind, 'topic')
  assert.equal(classifyTurn('介绍最小生成树').kind, 'topic')
  // A question mark wins: a constraint phrase inside a question is a topic.
  assert.equal(classifyTurn('为什么要把回答限制在100字以内？').kind, 'topic')
})

test('a cancelling turn lifts every active constraint', () => {
  const first = classifyTurn('以下所有的回答都限制在100字以内，越短越好')
  assert.equal(first.cancels, false)
  let list = applyConstraint([], '以下所有的回答都限制在100字以内，越短越好', 1_000, first)
  assert.equal(list.filter(entry => entry.active).length, 1)
  assert.equal(list[0].reason, 'directive:以下')

  const cancel = classifyTurn('以下所有对话不再受100字限制')
  assert.equal(cancel.kind, 'constraint')
  assert.equal(cancel.cancels, true)
  list = applyConstraint(list, '以下所有对话不再受100字限制', 2_000, cancel)
  assert.equal(list.filter(entry => entry.active).length, 0)
  assert.equal(list[0].active, false)
  assert.equal(list[0].supersededBy, '以下所有对话不再受100字限制')
})

test('the working set keeps only the newest constraints', () => {
  let list: ReturnType<typeof applyConstraint> = []
  for (let index = 0; index < 12; index++) {
    list = applyConstraint(list, `以后都按第 ${index} 条格式回答`, index, classifyTurn('以后都按格式回答'), 8)
  }
  assert.equal(list.length, 8)
  assert.equal(list.at(-1)?.text, '以后都按第 11 条格式回答')
})

test('a topic turn is never treated as a constraint', () => {
  const classification = classifyTurn('请解释一下 Dijkstra 的时间复杂度')
  assert.equal(classification.kind, 'topic')
  assert.equal(classification.cancels, false)
})
