import test from 'node:test'
import assert from 'node:assert/strict'

import { MemoryTree } from '../src/core/graph.ts'
import { DEFAULT_LOOP_POLICY } from '../src/core/types.ts'
import { chooseBacktrack, describeBacktrack, describeFailure, evaluateProgress, scoreBranch } from '../src/core/reflect.ts'
import type { Observation } from '../src/core/reflect.ts'

/** One observation with sane defaults. */
function obs(step: number, ok: boolean, toolName = 'search', argsKey = 'q'): Observation {
  return { step, toolName, argsKey, ok, at: step * 1_000, ...(ok ? {} : { error: 'boom' }) }
}

const policy = { ...DEFAULT_LOOP_POLICY, failureThreshold: 2, stallScore: 0.2, minBranchValue: 0.05 }

test('no observations means no verdict yet', () => {
  const evaluation = evaluateProgress({ observations: [], policy })
  assert.equal(evaluation.verdict, 'progress')
  assert.equal(evaluation.score, 0)
})

test('two consecutive failures are a failure', () => {
  const evaluation = evaluateProgress({ observations: [obs(1, true), obs(2, false), obs(3, false)], policy })
  assert.equal(evaluation.verdict, 'failed')
  assert.equal(evaluation.consecutiveFailures, 2)
  assert.ok(evaluation.reasons.some(reason => reason.includes('consecutive')))
})

test('an identical retry is a stall, not a failure', () => {
  const evaluation = evaluateProgress({ observations: [obs(1, false, 'fs_read', 'a.ts'), obs(2, false, 'fs_read', 'a.ts')], policy: { ...policy, failureThreshold: 5 } })
  assert.equal(evaluation.repeated, true)
  assert.equal(evaluation.verdict, 'stalled')
})

test('a healthy run progresses, and a reached goal is done', () => {
  assert.equal(evaluateProgress({ observations: [obs(1, true), obs(2, true)], policy }).verdict, 'progress')
  assert.equal(evaluateProgress({ observations: [obs(1, true)], policy, goalDone: true }).verdict, 'done')
})

/** Root with two siblings: the failed one and a pinned, successful one. */
function fork(): { tree: MemoryTree; failed: string; better: string } {
  const tree = new MemoryTree({ sessionId: 'backtrack', now: 0, params: { lambda: 0.3 } })
  tree.addNode({ kind: 'question', content: 'How do I compute attention weights?', timestamp: 1_000 })
  const failed = tree.addNode({ kind: 'answer', content: 'Call the flaky search tool.', timestamp: 2_000 }).id
  tree.addNode({ kind: 'tool_result', content: 'search failed with timeout', timestamp: 3_000, metadata: { ok: false, toolName: 'search' } })
  const better = tree.addNode({
    kind: 'answer',
    content: 'Call the local calculator tool instead.',
    parentId: tree.node(failed).parentId,
    timestamp: 4_000,
    metadata: { pinned: true },
  }).id
  tree.addNode({ kind: 'tool_result', content: 'calculator returned 0.42', parentId: better, timestamp: 5_000, metadata: { ok: true, toolName: 'calc' } })
  return { tree, failed, better }
}

test('branch scoring prefers the pinned, successful branch', () => {
  const { tree, failed, better } = fork()
  const parentId = tree.node(failed).parentId as string
  const failedScore = scoreBranch(tree, parentId, failed)
  const betterScore = scoreBranch(tree, parentId, better)
  assert.ok(betterScore.value > failedScore.value)
  assert.equal(betterScore.pinned, true)
  assert.equal(failedScore.failures, 1)
})

test('a failed branch backtracks to the better sibling', () => {
  const { tree, failed, better } = fork()
  const plan = chooseBacktrack(tree, failed, policy)
  assert.ok(plan !== null)
  assert.equal(plan.targetId, better)
  assert.equal(plan.escalated, 0)
  assert.ok(plan.reason.includes(better))
  assert.ok(describeBacktrack(plan).includes('backtracking'))
})

test('with no sibling worth taking the search climbs one level', () => {
  const tree = new MemoryTree({ sessionId: 'escalate', now: 0, params: { lambda: 0.3 } })
  const left = tree.addNode({ kind: 'question', content: 'First attempt', timestamp: 1_000 }).id
  const leaf = tree.addNode({ kind: 'answer', content: 'Dead end', timestamp: 2_000 }).id
  const right = tree.addNode({
    kind: 'question',
    content: 'Second attempt with a better plan',
    parentId: tree.rootId,
    timestamp: 3_000,
    metadata: { pinned: true },
  }).id
  tree.addNode({ kind: 'answer', content: 'A workable plan', parentId: right, timestamp: 4_000, metadata: { ok: true } })

  const plan = chooseBacktrack(tree, leaf, policy)
  assert.ok(plan !== null)
  assert.equal(plan.targetId, right)
  assert.equal(plan.escalated, 1)
})

test('a dead tree yields no plan and no reflection text', () => {
  const tree = new MemoryTree({ sessionId: 'dead', now: 0 })
  const only = tree.addNode({ kind: 'answer', content: 'Nothing else to try', timestamp: 1_000 }).id
  assert.equal(chooseBacktrack(tree, only, policy), null)
})

test('reflection text names the tool, the step, and the cause', () => {
  const text = describeFailure({ toolName: 'search', error: 'timeout', step: 3, attempt: 2 })
  assert.ok(text.startsWith('[reflection]'))
  assert.ok(text.includes('search'))
  assert.ok(text.includes('timeout'))
  assert.ok(text.includes('attempt 2'))
})
