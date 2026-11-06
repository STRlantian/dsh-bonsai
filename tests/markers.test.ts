import test from 'node:test'
import assert from 'node:assert/strict'

import { readTrailingMarkers } from '../src/plugin/markers.ts'

test('trailing markers on their own lines are removed and returned', () => {
  const parsed = readTrailingMarkers('缓存按热度淘汰。\n[attach:n2]\n[summary: 淘汰策略, 热度]')
  assert.equal(parsed.text, '缓存按热度淘汰。')
  assert.equal(parsed.attach, 'n2')
  assert.equal(parsed.summary, '淘汰策略, 热度')
})

test('a marker at the end of the answer line is accepted', () => {
  const parsed = readTrailingMarkers('它指红黑树：插入后需要修复红黑性质。[attach:n2]')
  assert.equal(parsed.text, '它指红黑树：插入后需要修复红黑性质。')
  assert.equal(parsed.attach, 'n2')
})

test('a marker inside a fenced code block is left alone', () => {
  const text = '写法：\n```text\n[attach:n2]\n```'
  assert.deepEqual(readTrailingMarkers(text), { text })
})

test('an inline mention in the middle of an answer is left alone', () => {
  const text = '使用 [attach:n2] 可以把问题挂到那条回答。\n\n这里才是正文。'
  assert.deepEqual(readTrailingMarkers(text), { text })
})

test('several trailing markers are all removed; the last one wins', () => {
  const parsed = readTrailingMarkers('答案。\n[summary: 甲]\n[attach:root]\n[attach:here]')
  assert.equal(parsed.text, '答案。')
  assert.equal(parsed.attach, 'here')
  assert.equal(parsed.summary, '甲')
})

test('a long or malformed summary marker is not treated as ours', () => {
  const text = `答案。\n[summary: ${'长'.repeat(130)}]`
  assert.deepEqual(readTrailingMarkers(text), { text })
})
