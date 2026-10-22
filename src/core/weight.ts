/**
 * Edge-cost formula.
 *
 * One parent→child edge is priced from four observable signals, then clamped to
 * a non-negative range. The cost is a *penalty*: a larger number means the path
 * is a worse thing to pull into the cache.
 *
 * ```
 * cost = clamp( wSemantic * semanticJump
 *            + wTime      * timeGap
 *            + wBranch    * branchSwitch
 *            + wUser      * userMark, minCost, maxCost )
 *
 * semanticJump = 1 - cos(parent.embedding, child.embedding)   in [0, 1]
 * timeGap      = log1p(dt / timeScaleMs)                      clamped to [0, timeGapCap]
 * branchSwitch = 1 when the parent already had a child (a fork), else 0
 * userMark     = +1 ignored, -0.5 pinned, 0 untouched
 * ```
 *
 * `timeGap` is a logarithm so that a two-hour gap is not sixty times a two-minute
 * one; `branchSwitch` makes a fresh alternative under an answered question more
 * expensive than continuing the active line; `userMark` is the only term that can
 * push a cost back down, and the clamp keeps every edge traversable.
 *
 * @module dsh-bonsai/core/weight
 */

import type { EdgeCostComponents, MemoryNode, WeightParams } from './types.ts'
import { cosine } from './embedding.ts'

/** Clamp a value into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Clamp a value into `[0, 1]`. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/**
 * Price one parent→child edge.
 * @param parent - the parent node.
 * @param child - the child node being linked.
 * @param params - weight parameters.
 * @param params.hasSibling - whether the parent already had at least one other child.
 * @returns The clamped cost and its per-term breakdown.
 */
export function computeEdgeCost(
  parent: MemoryNode,
  child: MemoryNode,
  params: WeightParams,
  options: { hasSibling: boolean },
): { cost: number; components: EdgeCostComponents } {
  const similarity = cosine(parent.embedding, child.embedding)
  const components: EdgeCostComponents = {
    semanticJump: clamp01(1 - similarity),
    timeGap: clamp(
      Math.log1p(Math.max(0, child.timestamp - parent.timestamp) / params.timeScaleMs),
      0,
      params.timeGapCap,
    ),
    branchSwitch: options.hasSibling ? 1 : 0,
    userMark: child.metadata.ignored === true ? 1 : child.metadata.pinned === true ? -0.5 : 0,
  }
  const raw = params.wSemantic * components.semanticJump
    + params.wTime * components.timeGap
    + params.wBranch * components.branchSwitch
    + params.wUser * components.userMark
  return { cost: clamp(raw, params.minCost, params.maxCost), components }
}

/**
 * Weight of a path given its cumulative cost.
 * @param pathCost - non-negative cumulative edge cost.
 * @param params - weight parameters.
 * @returns `exp(-lambda * pathCost)`, in `(0, 1]`.
 */
export function pathWeight(pathCost: number, params: WeightParams): number {
  return Math.exp(-params.lambda * Math.max(0, pathCost))
}

/**
 * Combine topical relevance and path weight into one score.
 * @param relevance - cosine similarity clamped to `[0, 1]`.
 * @param weight - path weight in `(0, 1]`.
 * @param params - weight parameters.
 * @returns The combined score before ancestor and pin boosts.
 */
export function combineScore(relevance: number, weight: number, params: WeightParams): number {
  const alpha = clamp01(params.alpha)
  if (params.combine === 'product') {
    const safeRelevance = Math.max(relevance, 1e-6)
    const safeWeight = Math.max(weight, 1e-6)
    return Math.pow(safeRelevance, alpha) * Math.pow(safeWeight, 1 - alpha)
  }
  return alpha * relevance + (1 - alpha) * weight
}
