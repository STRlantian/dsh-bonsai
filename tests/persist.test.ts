import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config } from '../src/plugin/config.ts'
import type { ResolvedConfig } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { EditStore } from '../src/plugin/store.ts'
import type { SessionEventLike, SessionLike } from '../src/plugin/dsh.ts'

/** Quiet logger. */
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** Resolved defaults. */
function defaults(): ResolvedConfig {
  const result = Config['~standard'].validate({ logEdgeUpdates: false })
  assert.ok(result.value !== undefined)
  return result.value
}

/** Three exchanges, enough to move and delete branches. */
function history(): SessionEventLike[] {
  const events: SessionEventLike[] = []
  let seq = 0
  const push = (type: string, data: Record<string, unknown>): void => {
    events.push({ type, seq: ++seq, time: seq * 1_000, data })
  }
  const ask = (id: string, text: string): void => {
    push('user/message', { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  }
  const answer = (text: string): void => {
    push('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } })
  }
  ask('m1', '什么是二分查找？')
  answer('二分查找在有序数组上每次折半，复杂度 O(log n)。')
  ask('m2', '为什么要求有序？')
  answer('因为每次折半要靠大小关系判断方向，无序就无法比较。')
  ask('m3', '边界怎么取？')
  answer('用左闭右开区间，循环条件是 left < right。')
  return events
}

/** A session stand-in that replays a fixed log. */
function sessionOf(events: SessionEventLike[]): SessionLike {
  return { id: 'session-p', snapshotEvents: () => events }
}

/** Fresh temp dir per test, removed afterwards. */
function tempStore(): { store: EditStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tt-'))
  return { store: new EditStore({ path: join(dir, 'edits.jsonl'), onError: () => {} }), dir }
}

test('the store writes one line per edit and reads it back', () => {
  const { store, dir } = tempStore()
  try {
    store.record({ session: 's1', action: 'mark', nodeId: 'n2', pinned: true, at: 1 })
    store.record({ session: 's1', action: 'reparent', nodeId: 'n3', parentId: 'n2', at: 2 })
    store.record({ session: 's2', action: 'remove', nodeId: 'n4', at: 3 })

    const lines = readFileSync(join(dir, 'edits.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)

    const reopened = new EditStore({ path: join(dir, 'edits.jsonl'), onError: () => {} })
    assert.deepEqual(reopened.opsFor('s1').map(op => op.action), ['mark', 'reparent'])
    assert.deepEqual(reopened.opsFor('s2').map(op => op.action), ['remove'])
    assert.deepEqual(reopened.opsFor('s3'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt line costs only that op', () => {
  const { dir } = tempStore()
  try {
    const path = join(dir, 'edits.jsonl')
    const store = new EditStore({ path, onError: () => {} })
    store.record({ session: 's1', action: 'mark', nodeId: 'n2', pinned: true, at: 1 })

    // A malformed line and an unknown action are both skipped, the good line stays.
    appendFileSync(path, '{ not json\n{"session":"s1","action":"bogus","nodeId":"n3"}\n')
    const reopened = new EditStore({ path, onError: () => {} })
    assert.equal(reopened.opsFor('s1').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('manual edits survive a full replay in a new service instance', () => {
  const { store, dir } = tempStore()
  try {
    const events = history()
    const session = sessionOf(events)
    const first = new TokenTreeService({ config: defaults(), logger, store })
    first.backfillFromSession(session)

    const tree = first.treeOf('session-p')
    const questions = [...tree.nodes.values()].filter(node => node.kind === 'question')
    assert.equal(questions.length, 3)
    const [q1, q2, q3] = questions

    first.reparent('session-p', q2.id, q1.id)
    first.remove('session-p', q3.id)
    first.mark('session-p', q1.id, { pinned: true })
    // Delete is reversible, so the node stays in the graph and is merely hidden.
    assert.equal(tree.hidden(q3.id), true)

    // A different process would rebuild the tree from the log and re-apply the log.
    const second = new TokenTreeService({ config: defaults(), logger, store: new EditStore({ path: join(dir, 'edits.jsonl'), onError: () => {} }) })
    second.backfillFromSession(session)
    const rebuilt = second.treeOf('session-p')

    assert.equal(rebuilt.node(q2.id).parentId, q1.id, 'reparent replayed')
    assert.equal(rebuilt.hidden(q3.id), true, 'remove replayed as a hidden branch')
    assert.equal(rebuilt.node(q1.id).metadata.pinned, true, 'mark replayed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale edit whose node no longer exists is skipped', () => {
  const { store, dir } = tempStore()
  try {
    const events = history()
    const session = sessionOf(events)
    // An op for a node this log never produces.
    store.record({ session: 'session-p', action: 'remove', nodeId: 'n999', at: 1 })
    store.record({ session: 'session-p', action: 'reparent', nodeId: 'n998', parentId: 'n1', at: 2 })

    const service = new TokenTreeService({ config: defaults(), logger, store })
    assert.doesNotThrow(() => service.backfillFromSession(session))
    const tree = service.treeOf('session-p')
    assert.equal([...tree.nodes.values()].filter(node => node.kind === 'question').length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
