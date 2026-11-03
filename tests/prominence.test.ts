import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

/**
 * These tests pin how the score *actually* decides today, including the cases where prominence does
 * not change the outcome. The rule set gives the current answer a structural advantage: it is exempt
 * from the 0.3 weak-evidence discount, and a jump needs 0.18 plus a 0.08 margin. A follow-up that
 * shares one term with both the current answer and an older one therefore stays where it is, no
 * matter how central that term is in the older answer.
 */

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function conversation(id = 'prom') {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  const service = new TokenTreeService({ config, logger })
  const events = []
  const session = { id, snapshotEvents: () => events }
  let seq = 0
  const push = (type, data) => { const event = { type, seq: ++seq, time: ++seq * 1000, data }; events.push(event); service.handleEvent(session, event) }
  const turn = (text, n, answer) => {
    push('turn/start', { turn: n })
    push('user/message', { role: 'user', id: 'q' + n, source: { kind: 'user' }, content: [{ type: 'text', text }] })
    push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
    push('turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  const tree = () => service.stateOf(id).tree
  const ordered = kind => [...tree().nodes.values()].filter(node => node.kind === kind).sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
  const probe = () => ordered('question').at(-1)
  return { service, turn, ordered, probe }
}

test('one shared term keeps the question on the current answer, whatever its prominence there', () => {
  const run = conversation('pass')
  run.turn('缓存怎么清理', 1, '缓存清理先淘汰过期缓存，再按热度淘汰冷缓存，最后给缓存设上限，并监控缓存命中率。')
  run.turn('布隆过滤器是什么', 2, '布隆过滤器用位数组与多个哈希函数表示集合，常与缓存配合，用来挡掉不存在的键。')
  run.turn('缓存配置容量怎么定', 3, '容量按热数据与内存预算定。')

  const answers = run.ordered('answer')
  assert.equal(run.probe()?.parentId, answers[0]?.id, 'reaches the answer that dwells on the term, not the passing mention')
})

test('a term both answers dwell on does not justify a jump', () => {
  const run = conversation('ubiq')
  run.turn('缓存穿透是什么', 1, '缓存穿透：键在缓存与数据库都不存在，缓存永远不命中；对策是缓存空值与布隆过滤器。')
  run.turn('缓存雪崩是什么', 2, '缓存雪崩：大量缓存同时过期，请求压垮数据库；对策是缓存过期加随机值。')
  run.turn('缓存击穿是什么', 3, '缓存击穿：热点缓存重建期间被打穿。')

  const answers = run.ordered('answer')
  assert.equal(run.probe()?.parentId, answers[1]?.id, 'no jump between near-identical scores')
})

test('a rare term on short answers still pulls the question back', () => {
  const run = conversation('rare')
  run.turn('误判率由什么决定', 1, '误判率由位数组大小与哈希函数个数决定，元素越多误判率越高。')
  run.turn('缓存怎么淘汰', 2, '按过期时间与热度淘汰。')
  run.turn('误判率怎么降', 3, '增大位数组。')

  const answers = run.ordered('answer')
  assert.equal(run.probe()?.parentId, answers[0]?.id, 'the rare term decides the branch')
})
