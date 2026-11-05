import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

/**
 * Installing the plugin halfway through a conversation: the first event triggers a replay of the whole
 * history, and the replayed turns must come back as separate turns rather than one lump. The turn
 * number is derived from the one boundary always visible in the log - a real user input.
 */

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value

function history(turns: number) {
  const events: Record<string, unknown>[] = []
  let seq = 1
  for (let turn = 1; turn <= turns; turn++) {
    events.push({ type: 'user/message', seq: seq++, time: turn, data: { role: 'user', id: `q${turn}`, source: { kind: 'user', rpcId: `r${turn}` }, content: [{ type: 'text', text: `第 ${turn} 个问题，关于缓存` }] } })
    events.push({ type: 'assistant/message', seq: seq++, time: turn, data: { step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `第 ${turn} 个回答：按热度淘汰。` }] } } })
    // Harness bookkeeping that must not open a turn.
    events.push({ type: 'user/message', seq: seq++, time: turn, data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime context' }] } })
  }
  return events
}

test('a replayed history keeps its turns instead of collapsing into one', () => {
  const events = history(4)
  const service = new TokenTreeService({ config, logger })
  const session = { id: 'mid-install', snapshotEvents: () => events }
  // One event is enough: the service replays the snapshot first.
  service.handleEvent(session as never, events[0] as never)
  assert.equal(service.sessionTurn('mid-install'), 4, 'four user inputs, four turns')
  const tokens = service.turnTokens('mid-install')
  assert.deepEqual([...tokens.keys()].sort((left, right) => left - right), [1, 2, 3, 4], 'every turn has a size')
  assert.ok([...tokens.values()].every(value => value > 0), 'none of them is empty')
})

test('harness messages and our own hints do not count as turns', () => {
  const events = history(2)
  events.push({ type: 'user/message', seq: 100, time: 9, data: { role: 'user', source: { kind: 'token-tree' }, content: [{ type: 'text', text: '[token-tree] 本轮的落点由你判' }] } })
  events.push({ type: 'user/message', seq: 101, time: 9, data: { role: 'user', source: { kind: 'system' }, content: [{ type: 'text', text: 'reminder' }] } })
  const service = new TokenTreeService({ config, logger })
  const session = { id: 'injected', snapshotEvents: () => events }
  service.handleEvent(session as never, events[0] as never)
  assert.equal(service.sessionTurn('injected'), 2, 'still two real turns')
})

test('live turns keep incrementing after the replay', () => {
  const events = history(2)
  const service = new TokenTreeService({ config, logger })
  const session = { id: 'live', snapshotEvents: () => events }
  service.handleEvent(session as never, events[0] as never)
  assert.equal(service.sessionTurn('live'), 2)
  service.handleEvent(session as never, {
    type: 'user/message',
    seq: 200,
    time: 10,
    data: { role: 'user', id: 'q3', source: { kind: 'user' }, content: [{ type: 'text', text: '第三个问题' }] },
  } as never)
  assert.equal(service.sessionTurn('live'), 3, 'a new question opens turn three')
})
