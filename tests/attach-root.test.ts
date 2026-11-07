import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function conversation() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  const current = { attachChoices: 5, attachPrompt: 'any', mandatoryContext: false, autoInject: false, retrievalHint: false, hintMinNodes: 99 }
  const settings = {
    path: 'memory',
    all: () => ({ ...current }),
    apply: patch => { Object.assign(current, patch); return { ...current } },
  }
  const service = new TokenTreeService({ config, logger, settings })
  const events = []
  const session = { id: 'root-marker', snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => { const event = { type, seq: ++seq, time: ++seq * 1000, data }; events.push(event); service.handleEvent(session, event) }
  const turn = (text, n, answer) => {
    push('turn/start', { turn: n })
    push('user/message', { role: 'user', id: 'q' + n, source: { kind: 'user' }, content: [{ type: 'text', text }] })
    push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
    push('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  return { service, turn, tree: () => service.stateOf('root-marker').tree }
}

test('any mode offers the new-topic call, follow mode does not', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  const block = run.service.attachChoices('root-marker', '它的误判率怎么算')
  assert.ok(block.includes('tree_attach') && block.includes('"root"'), 'any mode names the sentinel: ' + block)
  run.service.updateSettings({ attachPrompt: 'follow' })
  run.service.attachChoices('root-marker', '它的误判率怎么算')
  assert.equal(run.service.stateOf('root-marker').offeredRoot, false, 'follow mode offers no root call')
})

test('[attach:root] starts a new branch under the root', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  run.service.attachChoices('root-marker', '介绍一下 KMP 的 next 数组')
  run.turn('介绍一下 KMP 的 next 数组', 2, 'next 数组记录前缀与后缀的最长匹配。[attach:root]')
  const tree = run.tree()
  const question = [...tree.nodes.values()].filter(node => node.kind === 'question').at(-1)
  assert.equal(question.parentId, tree.rootId, 'the question hangs under the root')
  const answer = [...tree.nodes.values()].filter(node => node.kind === 'answer' && node.parentId === question.id)[0]
  assert.ok(answer !== undefined && !answer.content.includes('[attach:'), 'the marker is stripped')
})

test('a root marker is ignored when the turn did not offer it', () => {
  const run = conversation()
  run.service.updateSettings({ attachPrompt: 'follow' })
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  run.service.attachChoices('root-marker', '它怎么调')
  const before = [...run.tree().nodes.values()].filter(node => node.kind === 'question').at(-1)
  run.turn('它怎么调', 2, '调用前先预热。[attach:root]')
  const question = [...run.tree().nodes.values()].filter(node => node.kind === 'question').at(-1)
  assert.notEqual(question.parentId, run.tree().rootId, 'follow mode cannot send it to the root')
  assert.notEqual(question.id, before?.id)
})

test('[attach:here] keeps a requirement turn on the current line instead of opening a branch', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  run.service.attachChoices('root-marker', '接下来我来问，你只判断对错')
  run.turn('接下来我来问，你只判断对错', 2, '好。[attach:here]')
  const tree = run.tree()
  const question = [...tree.nodes.values()].filter(node => node.kind === 'question').at(-1)
  assert.notEqual(question.parentId, tree.rootId, 'a requirement turn does not open a root branch')
  const answer = [...tree.nodes.values()].filter(node => node.kind === 'answer' && node.parentId === question.id)[0]
  assert.ok(answer !== undefined && !answer.content.includes('[attach:'), 'the marker is stripped')
})
