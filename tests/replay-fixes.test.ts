import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { EditStore } from '../src/plugin/store.ts'
import type { SessionEventLike } from '../src/plugin/dsh.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value!

function questionAnswer(): SessionEventLike[] {
  return [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1, data: { role: 'user', id: 'q1', source: { kind: 'user' }, content: [{ type: 'text', text: '问题' }] }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '回答' }] } }, surfaceOp: 'append' },
    { type: 'step/start', seq: 3, time: 3, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 4, time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

test('a surface replacement does not create a second tree node', () => {
  const service = new TokenTreeService({ config, logger })
  const session = { id: 'replacement' }
  const events = questionAnswer()
  for (const event of events) service.handleEvent(session, event)
  const before = service.treeOf('replacement').nodes.size
  const replacement: SessionEventLike = {
    type: 'assistant/message',
    seq: 6,
    time: 6,
    data: events[2].data,
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
    sourceEventSeqs: [2],
  }
  service.handleEvent(session, replacement)
  assert.equal(service.treeOf('replacement').nodes.size, before, 'the replacement is a view operation')
  const answers = [...service.treeOf('replacement').nodes.values()].filter(node => node.kind === 'answer')
  assert.equal(answers.length, 1)
})

test('the first live event applies stored edits; a later backfill does not duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-replay-'))
  try {
    const store = new EditStore({ path: join(dir, 'edits.jsonl'), onError: () => {} })
    store.record({ session: 'first-touch', action: 'remove', nodeId: 'n2', at: 1 })
    const events = questionAnswer()
    const session = { id: 'first-touch', snapshotEvents: () => events }
    const service = new TokenTreeService({ config, logger, store })
    service.handleEvent(session, events[0])
    const tree = service.treeOf('first-touch')
    assert.equal(tree.hidden('n2'), true, 'the stored remove was replayed on the first event')
    const before = tree.nodes.size
    service.backfillFromSession(session)
    assert.equal(tree.nodes.size, before, 'the pre-step backfill did not replay the same events again')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
