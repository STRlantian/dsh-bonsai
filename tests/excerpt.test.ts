import test from 'node:test'
import assert from 'node:assert/strict'

import { excerptFor, reductionNote, referentLine, sentencesOf } from '../src/core/excerpt.ts'

/** Rough counter: one token per four characters. */
const count = text => Math.ceil(text.length / 4)

test('sentences split on Chinese and English terminators, fences stay whole', () => {
  const text = '第一句。第二句！第三句？\n```js\nconst a = 1\n```\n最后一句。'
  const parts = sentencesOf(text)
  assert.ok(parts.includes('第一句。'))
  assert.ok(parts.includes('第二句！'))
  assert.ok(parts.some(part => part.includes('const a = 1')), 'the code stays in one piece')
})

test('the referent line is the first sentence, cut when too long', () => {
  const text = '布隆过滤器用位数组表示集合，误判率随元素增加而上升。后面还有很多细节。'
  assert.ok(referentLine(text).startsWith('布隆过滤器用位数组表示集合'))
  assert.ok(referentLine(text).length <= 181)
  const long = '甲'.repeat(500)
  assert.ok(referentLine(long).endsWith('…'), 'a long sentence is cut with a marker')
})

test('an excerpt keeps the head and the matching sentences, verbatim', () => {
  // Long enough that the budget has to leave something out.
  const filler = Array.from({ length: 60 }, (_, index) => `第 ${index} 段是无关的填充内容，用来把文本拉长。`)
  const lines = [
    '开头介绍背景。',
    '这里讲哈希函数的选择。',
    ...filler,
    '哈希函数个数 k 取 m/n 乘以 ln2。',
    ...filler,
    '结尾总结。',
  ]
  const text = lines.join('\n')
  const excerpt = excerptFor(text, '哈希函数个数 k 怎么取', 200, count)
  assert.ok(excerpt.includes('哈希函数的选择'), 'a matching sentence is brought in')
  assert.ok(excerpt.includes('k 取 m/n'), 'the most relevant one too')
  assert.ok(excerpt.length < text.length, 'and the excerpt is shorter than the whole')
  // Verbatim: every kept line appears in the source unchanged.
  for (const line of excerpt.split('\n')) assert.ok(text.includes(line), 'verbatim: ' + line)
})

test('the reduction note says the original is in the tree', () => {
  const note = reductionNote('n123', 47, 'referent')
  assert.ok(note.includes('n123') && note.includes('47') && note.includes('retrieve_context'))
})
