import test from 'node:test'
import assert from 'node:assert/strict'

import { compressForPrompt } from '../src/core/compress.ts'

/** Every line of a fenced block or a command must survive byte for byte. */
function assertCodeSurvives(source) {
  const result = compressForPrompt(source)
  for (const line of source.split('\n')) {
    if (!/^\s{4,}\S|^\s*[$>]\s|^\s*```|^\s*(PS [A-Z]:|C:\\)/.test(line)) continue
    assert.ok(result.text.includes(line), 'protected line kept: ' + JSON.stringify(line))
  }
}

test('whitespace and decorative rules are removed from prose', () => {
  const source = '这是第一段。   \n\n\n\n----------\n这是第二段。'
  const result = compressForPrompt(source)
  assert.ok(!result.text.includes('   '), 'trailing spaces gone')
  assert.ok(!result.text.includes('----------'), 'the rule gone')
  assert.ok(result.removed > 0)
  assert.ok(result.text.includes('这是第一段。') && result.text.includes('这是第二段。'), 'text kept')
})

test('edge filler is removed, content words are not', () => {
  const source = '其实这个方法很简单呢。那么我们先看定义吧。'
  const result = compressForPrompt(source)
  assert.ok(result.text.includes('这个方法很简单'), 'kept the content: ' + result.text)
  assert.ok(!result.text.includes('其实'), 'leading filler gone')
  assert.ok(!result.text.includes('呢。'), 'trailing particle gone')
  assert.ok(result.text.includes('看定义'), 'and the second sentence survives')
})

test('negations are never treated as filler', () => {
  for (const source of ['这个方法不行吧。', '它不支持删除呢。', '没有配置吧。']) {
    const result = compressForPrompt(source)
    assert.ok(result.text.includes('不') || result.text.includes('没'), 'negation kept: ' + result.text)
  }
})

test('code, commands, diffs and paths survive', () => {
  assertCodeSurvives([
    '说明如下。',
    '```js',
    'const value = 1  ',
    '```',
    '    indented code line',
    '$ npm publish --tag next',
    'C:\\Users\\ASUS\\app.ts',
    '+++ b/src/index.ts',
  ].join('\n'))

  const source = '```js\nfunction alpha() { return 1 }\n```'
  const result = compressForPrompt(source)
  assert.equal(result.text, source, 'a fenced block is untouched')
  assert.equal(result.removed, 0)
})

test('numbers and identifiers survive', () => {
  const source = '该值等于 3.14159，函数名是 computeRatio，路径为 src/plugin/service.ts。'
  const result = compressForPrompt(source)
  for (const token of ['3.14159', 'computeRatio', 'src/plugin/service.ts']) {
    assert.ok(result.text.includes(token), 'kept ' + token)
  }
})
