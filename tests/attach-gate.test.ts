import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function conversation(overrides = {}) {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  const current = {
    attachChoices: 5,
    attachPrompt: 'any',
    attachGate: 'uncertain',
    mandatoryContext: false,
    autoInject: false,
    retrievalHint: false,
    hintMinNodes: 99,
    ...overrides,
  }
  const settings = {
    path: 'memory',
    all: () => ({ ...current }),
    apply: patch => { Object.assign(current, patch); return { ...current } },
  }
  const service = new TokenTreeService({ config, logger, settings })
  const events = []
  const session = { id: 'gate', snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => { const event = { type, seq: ++seq, time: ++seq * 1000, data }; events.push(event); service.handleEvent(session, event) }
  const turn = (text, n, answer) => {
    push('turn/start', { turn: n })
    push('user/message', { role: 'user', id: 'q' + n, source: { kind: 'user' }, content: [{ type: 'text', text }] })
    push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
    push('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  return { service, turn, state: () => service.stateOf('gate') }
}

test('a confident follow-up gets no candidate block under the uncertain gate', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小 m、哈希函数个数 k 和元素个数 n 共同决定，误判率约为 (1-e^{-kn/m})^k。')
  // The gate reads the placement of the question that was just ingested, as at pre-step.
  run.turn('布隆过滤器的误判率公式是什么', 2, '公式是 (1-e^{-kn/m})^k。')
  const block = run.service.attachChoices('gate', '布隆过滤器的误判率公式是什么')
  assert.equal(block, '', 'nothing to decide: ' + block)
})

test('a thin follow-up still gets the block under the uncertain gate', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小 m、哈希函数个数 k 和元素个数 n 共同决定。')
  run.turn('红黑树怎么插入', 2, '先按二叉查找树插入，再变色与旋转恢复性质。')
  run.turn('那它呢', 3, '红黑树插入后需要修复红黑性质。')
  const block = run.service.attachChoices('gate', '那它呢')
  assert.ok(block.includes('[attach:nX]'), 'an unsure placement offers the list: ' + block)
})

test('always mode ignores the uncertainty', () => {
  const run = conversation({ attachGate: 'always' })
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小 m、哈希函数个数 k 和元素个数 n 共同决定。')
  const block = run.service.attachChoices('gate', '布隆过滤器的误判率公式是什么')
  assert.ok(block.includes('[attach:nX]'), 'always mode always offers the list')
})
