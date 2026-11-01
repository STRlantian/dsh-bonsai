import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyTurn } from '../src/plugin/requirements.ts'

test('a question carrying an instruction stays a question', () => {
  for (const text of [
    '向我介绍注意力机制（请用不超过 80 字回答）',
    '解释一下布隆过滤器，用不超过 100 字',
    '讲讲一致性哈希，尽量简短',
    '为什么这里要用虚拟节点？字数限制在 50 以内',
  ]) {
    assert.equal(classifyTurn(text).kind, 'topic', text)
  }
})

test('an instruction with nothing else is still a constraint', () => {
  for (const text of [
    '从现在起所有回答不超过 100 字',
    '记住：回答要精简',
    '以后都用中文回答',
    '只输出结论',
  ]) {
    assert.equal(classifyTurn(text).kind, 'constraint', text)
  }
})

test('cancelling a constraint still wins', () => {
  assert.equal(classifyTurn('不用再限制字数了').kind, 'constraint')
  assert.equal(classifyTurn('不用再限制字数了').cancels, true)
})
