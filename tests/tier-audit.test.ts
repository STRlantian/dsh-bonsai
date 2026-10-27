import test from 'node:test'
import assert from 'node:assert/strict'

import { excerptFor } from '../src/core/excerpt.ts'
import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const count = text => Math.ceil(text.length / 4)
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

test('an excerpt never emits half a code block', () => {
  const filler = Array.from({ length: 40 }, (_, index) => `第 ${index} 段是无关的填充内容，把文本拉长。`)
  const source = [
    '开头介绍背景。',
    ...filler,
    '```js',
    'const ratio = computeRatio(alpha, beta)',
    'function computeRatio(a, b) { return a / b }',
    '```',
    ...filler,
    '结尾总结。',
  ].join('\n')
  for (const budget of [40, 80, 200]) {
    const excerpt = excerptFor(source, 'computeRatio 的实现', budget, count)
    const fences = (excerpt.match(/```/g) ?? []).length
    assert.equal(fences % 2, 0, 'fences stay balanced at budget ' + budget + ': ' + excerpt)
    const hasCode = /const ratio|function computeRatio/.test(excerpt)
    if (hasCode) assert.equal(fences, 2, 'a code line only appears inside a whole fence')
  }
})

function service() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  return new TokenTreeService({ config, logger })
}

test('a reduced serving is marked compressed even on its first appearance', () => {
  const instance = service()
  const long = '这是一个很长的回答。'.repeat(400) // ~ 4000+ tokens by character count
  const events = []
  const session = { id: 'marked', snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => { const event = { type, seq: ++seq, time: ++seq * 1000, data }; events.push(event); instance.handleEvent(session, event) }
  push('turn/start', { turn: 1 })
  push('user/message', { role: 'user', id: 'q1', source: { kind: 'user' }, content: [{ type: 'text', text: '介绍一下布隆过滤器' }] })
  push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: long }] } })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  push('turn/start', { turn: 2 })
  push('user/message', { role: 'user', id: 'q2', source: { kind: 'user' }, content: [{ type: 'text', text: '它的误判率怎么算' }] })

  const result = instance.retrieve('marked', { query: '它的误判率怎么算' })
  const entry = (result.selected ?? [])[0]
  assert.ok(entry !== undefined, 'something is selected')
  assert.equal(entry.compressed, true, 'a long node is served reduced and says so')
  assert.ok(result.tokensUsed <= result.budget, 'and the call stays inside its budget: ' + result.tokensUsed + '/' + result.budget)
})

test('two medium nodes still respect a small budget', () => {
  const instance = service()
  const medium = '这是一个中等长度的回答，包含一些细节。'.repeat(90) // ~ 2k chars
  const events = []
  const session = { id: 'budget', snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => { const event = { type, seq: ++seq, time: ++seq * 1000, data }; events.push(event); instance.handleEvent(session, event) }
  push('turn/start', { turn: 1 })
  push('user/message', { role: 'user', id: 'q1', source: { kind: 'user' }, content: [{ type: 'text', text: '讲讲布隆过滤器' }] })
  push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: medium }] } })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  push('turn/start', { turn: 2 })
  push('user/message', { role: 'user', id: 'q2', source: { kind: 'user' }, content: [{ type: 'text', text: '布隆过滤器的误判率' }] })

  const result = instance.retrieve('budget', { query: '布隆过滤器的误判率', budgetTokens: 300 })
  assert.ok(result.tokensUsed <= result.budget, 'tokens ' + result.tokensUsed + ' within ' + result.budget)
})
