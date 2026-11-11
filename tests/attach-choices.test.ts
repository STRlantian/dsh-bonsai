import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function conversation(overrides: Record<string, unknown> = {}) {
  const config = Config['~standard'].validate({ logEdgeUpdates: false, attachMode: 'marker', attachSummary: true, ...overrides }).value
  const current = { attachChoices: 5, attachSummary: true, mandatoryContext: false, autoInject: false, retrievalHint: false, hintMinNodes: 99 }
  const settings = {
    path: 'memory',
    all: () => ({ ...current }),
    apply: patch => { Object.assign(current, patch); return { ...current } },
  }
  const service = new TokenTreeService({ config, logger, settings })
  const events = []
  const session = { id: 'choices', snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => { const event = { type, seq: ++seq, time: ++seq * 1000, data }; events.push(event); service.handleEvent(session, event) }
  const turn = (text, n, answer) => {
    push('turn/start', { turn: n })
    push('user/message', { role: 'user', id: 'q' + n, source: { kind: 'user' }, content: [{ type: 'text', text }] })
    push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
    push('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  return { service, turn, push, tree: () => service.stateOf('choices').tree }
}

test('the choices block lists questions, not answers', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小 m、哈希函数个数 k 和元素个数 n 共同决定，公式接近 (1 - e^(-kn/m))^k。')
  run.turn('红黑树怎么插入', 2, '红黑树插入先按二叉查找树插入，再做变色与旋转。')
  const block = run.service.attachChoices('choices', '它的误判率怎么算')
  assert.ok(block.includes('布隆过滤器的误判率由什么决定'), 'the question is the label: ' + block)
  assert.ok(!block.includes('位数组大小'), 'the generated answer text is not included')
  assert.ok(block.includes('[attach:'), 'the instruction is there')
  const rows = block.split('\n').filter(line => line.startsWith('- '))
  assert.ok(rows.length <= 5 && rows.length >= 1, 'within the limit: ' + rows.length)
})

test('a marker naming an offered node moves the question', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小和哈希函数个数决定。')
  run.turn('红黑树怎么插入', 2, '先按二叉查找树插入，再变色与旋转。')
  const tree = run.tree()
  const firstAnswer = [...tree.nodes.values()].find(node => node.kind === 'answer' && node.content.includes('位数组'))
  assert.ok(firstAnswer !== undefined)
  const block = run.service.attachChoices('choices', '它的插入过程呢')
  assert.ok(block.includes(firstAnswer.id), 'the first answer is offered: ' + block)

  run.turn('它的插入过程呢', 3, '它指红黑树：插入后需要修复红黑性质。[attach:' + firstAnswer.id + ']')
  const question = [...run.tree().nodes.values()].filter(node => node.kind === 'question').at(-1)
  assert.equal(question.parentId, firstAnswer.id, 'the question moved under the offered node')
  assert.ok(!question.content.includes('[attach:'), 'and the marker is not part of the question')
})

test('a marker for a node that was never offered is ignored and stripped', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  run.service.attachChoices('choices', '它的误判率怎么算')
  const before = [...run.tree().nodes.values()].filter(node => node.kind === 'question').at(-1)
  run.turn('它的误判率怎么算', 2, '约 1%。[attach:n999]')
  const question = [...run.tree().nodes.values()].filter(node => node.kind === 'question').at(-1)
  assert.notEqual(question.parentId, 'n999', 'an invented id changes nothing')
  const answer = [...run.tree().nodes.values()].filter(node => node.kind === 'answer').at(-1)
  assert.ok(!answer.content.includes('[attach:'), 'the marker never reaches the tree: ' + answer.content)
})

test('setting the count to zero disables the block', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  assert.equal(run.service.attachChoices('choices', '它的误判率怎么算', 0), '', 'no block when the count is 0')
})

test('tree_attach moves the pending question and records the summary', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小和哈希函数个数决定。')
  run.turn('红黑树怎么插入', 2, '先按二叉查找树插入，再变色与旋转恢复性质。')
  const firstAnswer = [...run.tree().nodes.values()].find(node => node.kind === 'answer' && node.content.includes('位数组'))
  assert.ok(firstAnswer !== undefined)
  run.push('turn/start', { turn: 3 })
  run.push('user/message', { role: 'user', id: 'q3', source: { kind: 'user' }, content: [{ type: 'text', text: '它的插入过程呢' }] })
  const block = run.service.attachChoices('choices', '它的插入过程呢')
  assert.ok(block.includes(firstAnswer.id))
  const placed = run.service.placePendingQuestion('choices', firstAnswer.id, '插入、变色、旋转')
  assert.equal(placed.placed, true)
  run.push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '先按二叉查找树插入，再变色与旋转。' }] } })
  const question = [...run.tree().nodes.values()].filter(node => node.kind === 'question').at(-1)
  const answer = [...run.tree().nodes.values()].filter(node => node.kind === 'answer').at(-1)
  assert.equal(question.parentId, firstAnswer.id)
  assert.equal(answer.summary, '插入、变色、旋转')
})

test('tree_attach with auto keeps the automatic parent and still records the summary', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  run.push('turn/start', { turn: 2 })
  run.push('user/message', { role: 'user', id: 'q2', source: { kind: 'user' }, content: [{ type: 'text', text: '它的误判率怎么算' }] })
  const before = [...run.tree().nodes.values()].filter(node => node.kind === 'question').at(-1)
  const placed = run.service.placePendingQuestion('choices', 'auto', '误判率公式')
  assert.equal(placed.placed, false)
  run.push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '约 1%。' }] } })
  const question = [...run.tree().nodes.values()].filter(node => node.kind === 'question').at(-1)
  const answer = [...run.tree().nodes.values()].filter(node => node.kind === 'answer').at(-1)
  assert.equal(question.parentId, before.parentId)
  assert.equal(answer.summary, '误判率公式')
})

test('tree_rule records a model rule without removing the attachable question', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  run.push('turn/start', { turn: 2 })
  run.push('user/message', { role: 'user', id: 'q2', source: { kind: 'user' }, content: [{ type: 'text', text: '这个项目里我们用 pnpm 吧' }] })
  const before = [...run.tree().nodes.values()].filter(node => node.kind === 'question').at(-1)
  const recorded = run.service.recordRule('choices', undefined, false)
  assert.equal(recorded.cancel, false)
  assert.equal(recorded.active, 1)
  const rules = run.service.constraintsOf('choices')
  assert.equal(rules.length, 1)
  assert.equal(rules[0].source, 'model')
  assert.equal(rules[0].text, '这个项目里我们用 pnpm 吧')
  run.push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '好，之后用 pnpm。' }] } })
  const questions = [...run.tree().nodes.values()].filter(node => node.kind === 'question')
  const answers = [...run.tree().nodes.values()].filter(node => node.kind === 'answer')
  assert.equal(questions.length, 2, 'the rule turn still keeps its question')
  assert.equal(answers.length, 2, 'the answer is not skipped')
  assert.equal(questions.at(-1).parentId, before.parentId, 'tree_attach placement is unchanged')
})

test('tree_rule can cancel every active rule', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  run.push('turn/start', { turn: 2 })
  run.push('user/message', { role: 'user', id: 'q2', source: { kind: 'user' }, content: [{ type: 'text', text: '这个项目里我们用 pnpm 吧' }] })
  run.service.recordRule('choices')
  assert.equal(run.service.constraintsOf('choices').length, 1)
  const cancelled = run.service.recordRule('choices', undefined, true)
  assert.equal(cancelled.cancel, true)
  assert.equal(cancelled.active, 0)
  assert.equal(run.service.constraintsOf('choices').length, 0)
})

test('the instruction follows the attachPrompt mode', () => {
  const run = conversation()
  run.turn('布隆过滤器的误判率由什么决定', 1, '误判率由位数组大小决定。')
  run.service.updateSettings({ attachPrompt: 'follow' })
  assert.ok(run.service.attachChoices('choices', '它的误判率怎么算').includes('追问'), 'follow mode asks about follow-ups')
  run.service.updateSettings({ attachPrompt: 'any' })
  const anyBlock = run.service.attachChoices('choices', '它的误判率怎么算')
  assert.ok(anyBlock.includes('"root"') && anyBlock.includes('"here"'), 'any mode offers all three: ' + anyBlock)
})

test('the merged candidate source gives local the same retrieval index', () => {
  const run = conversation({ candidateSource: 'retrieve', attachMode: 'local' })
  run.turn('青禾的端口和缓存 TTL 是多少', 1, '青禾端口 7421，缓存 TTL 37 分钟。')
  const answer = [...run.tree().nodes.values()].find(node => node.kind === 'answer')
  assert.ok(answer !== undefined)
  const block = run.service.attachChoices('choices', '青禾端口是多少')
  assert.ok(block.includes('相关节点索引'), 'local gets the retrieval table: ' + block)
  assert.ok(!block.includes('tree_attach'), 'local is not asked to attach: ' + block)
  assert.ok(block.includes(answer.id), 'the retrieved answer id is in the table: ' + block)
  assert.match(block, /w=\d+\.\d{3} tokens=\d+/, 'rows carry the retrieval columns: ' + block)
})

test('the model summary is stored, stripped, and shown next to the question', () => {
  const run = conversation()
  const answer = '布隆过滤器用位数组和多个哈希函数表示集合，还会提到布谷鸟过滤器与 Counting Bloom Filter。[summary: 布隆过滤器定义、布谷鸟过滤器、Counting Bloom Filter]'
  run.turn('布隆过滤器的定义是什么', 1, answer)
  const tree = run.tree()
  const node = [...tree.nodes.values()].find(entry => entry.kind === 'answer')
  assert.ok(node !== undefined)
  assert.ok(!node.content.includes('[summary:'), 'the marker is not part of the answer text')
  assert.ok(node.summary?.includes('布谷鸟'), 'the model summary is kept: ' + String(node.summary))
  run.service.attachChoices('choices', '布谷鸟过滤器怎么删除')
  const block = run.service.attachChoices('choices', '布谷鸟过滤器怎么删除')
  assert.ok(block.includes('含') || block.includes('布谷鸟'), 'the label carries the aspects: ' + block)
})
