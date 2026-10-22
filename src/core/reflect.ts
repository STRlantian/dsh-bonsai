/**
 * Evaluation, reflection, and backtracking policy.
 *
 * These are pure functions so the supervised loop can be tested without a model
 * or a harness: given the observations of the running turn and the tree, decide
 * whether the agent is progressing, what to write as a reflection, and which
 * sibling branch is worth retrying.
 *
 * @module dsh-bonsai/core/reflect
 */

import type { LoopPolicy, NodeId } from './types.ts'
import type { MemoryTree } from './graph.ts'

/** One completed tool call as the supervisor remembers it. */
export interface Observation {
  /** Agent step that issued the call. */
  step: number
  /** Tool name. */
  toolName: string
  /** Stable rendering of the arguments, used to detect an identical retry. */
  argsKey: string
  /** Whether the call succeeded. */
  ok: boolean
  /** Failure text for a failed call. */
  error?: string
  /** Wall-clock time of settlement. */
  at: number
}

/** Supervisor verdict for one step. */
export type Verdict = 'progress' | 'stalled' | 'failed' | 'done'

/** Result of {@link evaluateProgress}. */
export interface Evaluation {
  /** What the supervisor concluded. */
  verdict: Verdict
  /** Recency-weighted success score in `[-1, 1]`. */
  score: number
  /** Human-readable causes, kept short enough for a log line. */
  reasons: string[]
  /** Trailing failures. */
  consecutiveFailures: number
  /** Whether the last two observations are the same failed call. */
  repeated: boolean
}

/** Value of one branch below a fork. */
export interface BranchScore {
  /** Child that opens the branch. */
  nodeId: NodeId
  /** Estimated value; higher is more promising. */
  value: number
  /** Nodes in the branch. */
  size: number
  /** Nodes carrying `ok === false`. */
  failures: number
  /** Whether any node in the branch is user-pinned. */
  pinned: boolean
  /** Incoming edge cost. */
  edgeCost: number
}

/** Outcome of {@link chooseBacktrack}. */
export interface BacktrackPlan {
  /** Node the agent should move to. */
  targetId: NodeId
  /** Node the agent is leaving. */
  fromId: NodeId
  /** Fork whose sibling was chosen. */
  viaParentId: NodeId
  /** Why this branch won. */
  reason: string
  /** How many levels the search climbed before finding a candidate. */
  escalated: number
  /** Scored alternatives at the chosen fork. */
  candidates: BranchScore[]
}

/** Recency weights for the last observations. */
const RECENCY_DECAY = 0.6

/** How many observations the score looks at. */
const SCORE_WINDOW = 6

/**
 * Decide whether the turn is progressing.
 * @param input - observations of the turn, loop policy, and goal completion flag.
 * @returns The verdict with its explanation.
 */
export function evaluateProgress(input: {
  observations: readonly Observation[]
  policy: LoopPolicy
  goalDone?: boolean
}): Evaluation {
  const { observations, policy } = input
  const reasons: string[] = []
  if (input.goalDone === true) {
    return { verdict: 'done', score: 1, reasons: ['goal reached'], consecutiveFailures: 0, repeated: false }
  }
  if (observations.length === 0) {
    return { verdict: 'progress', score: 0, reasons: ['no observation yet'], consecutiveFailures: 0, repeated: false }
  }

  let consecutiveFailures = 0
  for (let index = observations.length - 1; index >= 0; index--) {
    if (observations[index].ok) break
    consecutiveFailures++
  }

  let weighted = 0
  let totalWeight = 0
  const window = observations.slice(-SCORE_WINDOW)
  for (let index = window.length - 1, age = 0; index >= 0; index--, age++) {
    const weight = Math.pow(RECENCY_DECAY, age)
    weighted += (window[index].ok ? 1 : -0.6) * weight
    totalWeight += weight
  }
  const score = totalWeight === 0 ? 0 : weighted / totalWeight

  const last = observations[observations.length - 1]
  const previous = observations[observations.length - 2]
  const repeated = previous !== undefined
    && last.ok === false
    && previous.ok === false
    && last.toolName === previous.toolName
    && last.argsKey === previous.argsKey
  if (repeated) reasons.push(`same failed call ${last.toolName} twice`)
  if (consecutiveFailures > 0) reasons.push(`${consecutiveFailures} consecutive failure(s)`)
  if (score < policy.stallScore) reasons.push(`score ${score.toFixed(2)} below stall floor`)

  if (consecutiveFailures >= policy.failureThreshold) {
    return { verdict: 'failed', score, reasons, consecutiveFailures, repeated }
  }
  if (repeated || score < policy.stallScore) {
    return { verdict: 'stalled', score, reasons, consecutiveFailures, repeated }
  }
  return { verdict: 'progress', score, reasons, consecutiveFailures, repeated }
}

/** Signal a single node contributes to its branch. */
function signalOf(tree: MemoryTree, nodeId: NodeId): number {
  const node = tree.node(nodeId)
  if (node.metadata.ignored === true) return -1.5
  if (node.metadata.pinned === true) return 1.2
  switch (node.kind) {
    case 'reflection': return -0.6
    case 'goal': return 0.5
    case 'tool_result': return node.metadata.ok === false ? -0.6 : 0.4
    case 'answer': return 0.2
    case 'question': return 0.15
    case 'note': return 0
  }
}

/**
 * Score one branch as a backtrack candidate.
 * @param tree - memory tree.
 * @param parentId - fork the branch hangs below.
 * @param branchRootId - child that opens the branch.
 * @returns Value, size, and failure count of the branch.
 */
export function scoreBranch(tree: MemoryTree, parentId: NodeId, branchRootId: NodeId): BranchScore {
  const members = tree.subtree(branchRootId)
  const baseDepth = tree.ancestors(branchRootId).length
  let value = 0
  let failures = 0
  let pinned = false
  for (const member of members) {
    const depth = tree.ancestors(member).length - baseDepth
    value += Math.exp(-tree.params.lambda * depth) * signalOf(tree, member)
    const node = tree.node(member)
    if (node.metadata.ok === false) failures++
    if (node.metadata.pinned === true) pinned = true
  }
  const edge = tree.edge(parentId, branchRootId)
  const edgeCost = edge?.cost ?? 0
  const discounted = value * Math.exp(-tree.params.lambda * edgeCost) / (1 + Math.log1p(members.length))
  return { nodeId: branchRootId, value: Math.round(discounted * 10_000) / 10_000, size: members.length, failures, pinned, edgeCost }
}

/**
 * Choose a sibling branch to retry after a failure.
 *
 * The search climbs from the failing node to its parent and asks whether any
 * other child of that parent looks better than the branch just abandoned. It
 * climbs further only when no sibling clears `policy.minBranchValue`.
 * @param tree - memory tree.
 * @param fromId - node whose branch failed.
 * @param policy - loop guard rails, including `minBranchValue`.
 * @returns The plan, or `null` when no alternative is worth trying.
 */
export function chooseBacktrack(tree: MemoryTree, fromId: NodeId, policy: LoopPolicy): BacktrackPlan | null {
  const failedBranch = new Set(tree.subtree(fromId))
  let cursor: NodeId | null = tree.node(fromId).parentId
  let escalated = 0
  while (cursor !== null) {
    const fork: NodeId = cursor
    const siblings = tree.node(fork).children.filter(child => !failedBranch.has(child))
    const candidates = siblings
      .map(child => scoreBranch(tree, fork, child))
      .sort((left, right) => right.value - left.value)
    const best = candidates[0]
    if (best !== undefined && best.value >= policy.minBranchValue) {
      return {
        targetId: best.nodeId,
        fromId,
        viaParentId: fork,
        reason: `branch ${best.nodeId} scores ${best.value} (${best.size} nodes, ${best.failures} failure(s))`,
        escalated,
        candidates,
      }
    }
    cursor = tree.node(fork).parentId
    escalated++
  }
  return null
}

/**
 * Compose the text of a reflection node written after a failure.
 * @param input - failure facts.
 * @returns A short, model-readable reflection.
 */
export function describeFailure(input: {
  toolName: string
  error?: string
  step: number
  attempt: number
}): string {
  const detail = input.error === undefined || input.error.length === 0 ? 'no error detail' : input.error
  return `[reflection] step ${input.step}: tool ${input.toolName} failed (attempt ${input.attempt}). `
    + `Cause: ${detail}. The edge into this branch gained cost; consider a different sub-question or a different tool.`
}

/**
 * Compose the text of a reflection node written when the agent backtracks.
 * @param plan - chosen backtrack plan.
 * @returns A short, model-readable reflection.
 */
export function describeBacktrack(plan: BacktrackPlan): string {
  const alternatives = plan.candidates
    .slice(0, 3)
    .map(candidate => `${candidate.nodeId}=${candidate.value}`)
    .join(', ')
  return `[reflection] backtracking from ${plan.fromId} to ${plan.targetId} under ${plan.viaParentId}: `
    + `${plan.reason}${alternatives.length === 0 ? '' : ` (candidates: ${alternatives})`}. `
    + 'Continue from that branch instead of repeating the failed one.'
}
