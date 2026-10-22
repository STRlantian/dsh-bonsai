/**
 * Weighted recall for the context buffer.
 *
 * Given a query and the agent's current node, every history node is scored by
 * topical relevance and by how expensive it is to reach from where the agent
 * stands:
 *
 * ```
 * relevance_i = max(0, cos(query, node_i.embedding))
 * pathCost_i  = cheapestPath(current, node_i).cost
 * pathWeight_i = exp(-lambda * pathCost_i)
 * score_i     = combine(relevance_i, pathWeight_i)
 *               * (node_i is an ancestor of current ? ancestorBoost : 1)
 *               * (node_i pinned by the user        ? pinBoost      : 1)
 * ```
 *
 * `combine` is `alpha * relevance + (1 - alpha) * pathWeight` (`linear`) or
 * `relevance^alpha * pathWeight^(1 - alpha)` (`product`).
 *
 * Selection then applies three filters in order: the weight threshold, the
 * Top-k cap, and a token budget filled greedily by `weight / token` value. Nodes
 * below `compressBelow` enter as a compressed summary so a structurally relevant
 * but low-scoring node can still fit.
 *
 * @module dsh-bonsai/core/retrieve
 */

import type { NodeId, NodeKind } from './types.ts'
import type { MemoryTree } from './graph.ts'
import { renderNodeText } from './graph.ts'
import { cosine, embedText } from './embedding.ts'
import { clamp01, combineScore, pathWeight } from './weight.ts'
import { estimateTokens } from './tokens.ts'

/** Options of {@link retrieveContext}. */
export interface RetrieveOptions {
  /** Query text; embedded with the tree's local embedding unless `queryEmbedding` is supplied. */
  query: string
  /** Precomputed query embedding. */
  queryEmbedding?: number[]
  /** Path origin; defaults to the tree's current node. */
  originId?: NodeId
  /** Token budget; defaults to `params.tokenBudget`. */
  budgetTokens?: number
  /** Candidate cap; defaults to `params.topK`. */
  topK?: number
  /** Weight floor; defaults to `params.threshold`. */
  threshold?: number
  /**
   * Admission floor on the **raw relevance** (cosine), applied before ranking.
   *
   * A combined-score floor cannot gate quality: the blend of relevance and path weight
   * compresses everything towards zero, so a high combined threshold empties the result
   * even when the query plainly matches (measured: 90% empty at 0.5). Raw cosine for a
   * genuinely relevant local-embedding node sits around 0.35–0.55, so admission belongs
   * there. Defaults to `params.admitRelevance`.
   */
  admitRelevance?: number
  /**
   * Whether matching may use a node's derived topic line as well as its full text.
   * Defaults to `params.summaryMatch`.
   */
  summaryMatch?: boolean
  /** Nodes never to return. */
  excludeIds?: NodeId[]
  /** Nodes returned even when they fail the floor or the cap. */
  mustIncludeIds?: NodeId[]
  /** Restrict to these node kinds. */
  kinds?: NodeKind[]
  /** Include the synthetic root; defaults to `false`. */
  includeRoot?: boolean
}

/** Why a node did not enter the buffer. */
export type DropReason = 'excluded' | 'kind' | 'root' | 'ignored' | 'admission' | 'threshold' | 'top-k' | 'budget' | 'empty'

/** Per-node score explanation, kept for the `tree_query` tool and the log. */
export interface ScoreBreakdown {
  /** Clamped cosine similarity. */
  relevance: number
  /** Cheapest-path cost from the origin. */
  pathCost: number
  /** `exp(-lambda * pathCost)`. */
  pathWeight: number
  /** Multiplier applied because the node is an ancestor of the origin. */
  ancestorBoost: number
  /** Multiplier applied because the user pinned the node. */
  pinBoost: number
  /** Whether relevance and path weight were mixed linearly or multiplicatively. */
  combine: 'linear' | 'product'
}

/** One node that entered the buffer. */
export interface SelectedNode {
  /** Node id. */
  nodeId: NodeId
  /** Node kind. */
  kind: NodeKind
  /** Final score. */
  weight: number
  /** Tokens the node occupies in the buffer. */
  tokens: number
  /** Whether a compressed summary was used instead of full content. */
  compressed: boolean
  /** Text placed in the buffer. */
  text: string
  /** Score components. */
  breakdown: ScoreBreakdown
}

/** One node that did not enter the buffer. */
export interface DroppedNode {
  /** Node id. */
  nodeId: NodeId
  /** Score it would have had, when it was scored at all. */
  weight: number
  /** First filter that rejected it. */
  reason: DropReason
}

/** Result of one recall. */
export interface RetrieveResult {
  /** Query that produced this result. */
  query: string
  /** Origin node. */
  originId: NodeId
  /** Token budget applied. */
  budget: number
  /** Tokens consumed. */
  tokensUsed: number
  /** Nodes that entered the buffer, best first. */
  selected: SelectedNode[]
  /** Nodes that were filtered out. */
  dropped: DroppedNode[]
  /** Counters for the log line. */
  counts: {
    /** Nodes in the tree. */
    considered: number
    /** Nodes rejected by the weight floor. */
    belowThreshold: number
    /** Nodes rejected by the cap. */
    overCap: number
    /** Nodes rejected because the budget ran out. */
    overBudget: number
    /** Set when the admission floor admitted nothing and the query was retried without it. */
    relaxed?: boolean
  }
}

/** Candidate carried between the scoring and selection passes. */
interface Candidate {
  nodeId: NodeId
  kind: NodeKind
  weight: number
  relevance: number
  pathCost: number
  weightOfPath: number
  ancestorBoost: number
  pinBoost: number
  pinned: boolean
  must: boolean
  text: string
  tokens: number
  compressed: boolean
}

/**
 * Decide how one node enters the buffer at its score.
 * @param node - node to render.
 * @param weight - score the node reached.
 * @param params - weight parameters.
 * @returns Buffer text, token count, and compression flag.
 */
function materialize(
  tree: MemoryTree,
  nodeId: NodeId,
  weight: number,
): { text: string; tokens: number; compressed: boolean } {
  const node = tree.node(nodeId)
  const shouldCompress = weight < tree.params.compressBelow
    && (node.summary !== undefined || node.tokens > tree.params.compressedTokens)
  const text = renderNodeText(node, shouldCompress, tree.params.compressedTokens)
  return { text, tokens: estimateTokens(text), compressed: shouldCompress }
}

/**
 * Recall the context buffer for one query.
 * @param tree - memory tree to search.
 * @param options - query, origin, budget, and filters.
 * @returns Selected nodes with their score breakdown plus the drop log.
 */
export function retrieveContext(tree: MemoryTree, options: RetrieveOptions): RetrieveResult {
  const params = tree.params
  const originId = options.originId ?? tree.currentId
  tree.node(originId)
  const queryEmbedding = options.queryEmbedding ?? embedText(options.query, tree.embeddingDimension)
  const budget = Math.max(0, options.budgetTokens ?? params.tokenBudget)
  const topK = Math.max(1, options.topK ?? params.topK)
  const threshold = options.threshold ?? params.threshold
  const admitRelevance = Math.min(1, Math.max(0, options.admitRelevance ?? params.admitRelevance))
  const summaryMatch = options.summaryMatch ?? params.summaryMatch
  const exclude = new Set(options.excludeIds ?? [])
  const must = new Set(options.mustIncludeIds ?? [])
  const kinds = options.kinds === undefined ? undefined : new Set(options.kinds)
  const distances = tree.distancesFrom(originId)

  /**
   * Score every node with one admission floor.
   * @param admit - raw-relevance floor to apply (0 disables admission).
   * @returns Candidates, drops and the below-threshold counter for this pass.
   */
  const collect = (admit: number): { dropped: DroppedNode[]; candidates: Candidate[]; belowThreshold: number } => {
    const dropped: DroppedNode[] = []
    const candidates: Candidate[] = []
    let belowThreshold = 0

    for (const node of tree.nodes.values()) {
    if (node.id === tree.rootId && options.includeRoot !== true && !must.has(node.id)) {
      dropped.push({ nodeId: node.id, weight: 0, reason: 'root' })
      continue
    }
    if (exclude.has(node.id)) {
      dropped.push({ nodeId: node.id, weight: 0, reason: 'excluded' })
      continue
    }
    if (kinds !== undefined && !kinds.has(node.kind)) {
      dropped.push({ nodeId: node.id, weight: 0, reason: 'kind' })
      continue
    }
    if (node.tokens === 0) {
      dropped.push({ nodeId: node.id, weight: 0, reason: 'empty' })
      continue
    }
    if (node.metadata.ignored === true && !must.has(node.id)) {
      dropped.push({ nodeId: node.id, weight: 0, reason: 'ignored' })
      continue
    }
    // A soft-deleted branch is invisible to recall unless the caller demands it.
    if (!must.has(node.id) && tree.hidden(node.id)) {
      dropped.push({ nodeId: node.id, weight: 0, reason: 'ignored' })
      continue
    }
    const contentSimilarity = clamp01(cosine(queryEmbedding, node.embedding))
    // Matching may also use the node's topic line: a long tool result stays findable by
    // its summary without embedding anything per query.
    const summarySimilarity = summaryMatch && node.summaryEmbedding !== undefined
      ? clamp01(cosine(queryEmbedding, node.summaryEmbedding))
      : 0
    const relevance = Math.max(contentSimilarity, summarySimilarity)
    // Admission happens on raw relevance, before the blend: a node that is not close
    // to the query should not enter the ranking at all, and a node that is close must
    // not be filtered out because the blend pushes its score down.
    if (relevance < admit && !must.has(node.id) && node.metadata.pinned !== true) {
      dropped.push({ nodeId: node.id, weight: relevance, reason: 'admission' })
      continue
    }
    const pathCost = distances.get(node.id)
    /* c8 ignore next -- every node is reachable inside one tree. */
    const resolvedCost = pathCost ?? Number.POSITIVE_INFINITY
    const weightOfPath = pathWeight(resolvedCost, params)
    const ancestorBoost = node.id !== originId && tree.isAncestor(node.id, originId)
      ? params.ancestorBoost
      : 1
    const pinned = node.metadata.pinned === true
    const pinBoost = pinned ? params.pinBoost : 1
    const weight = combineScore(relevance, weightOfPath, params) * ancestorBoost * pinBoost
    if (weight < threshold && !must.has(node.id)) {
      belowThreshold++
      dropped.push({ nodeId: node.id, weight, reason: 'threshold' })
      continue
    }
    const rendered = materialize(tree, node.id, weight)
    candidates.push({
      nodeId: node.id,
      kind: node.kind,
      weight,
      relevance,
      pathCost: resolvedCost,
      weightOfPath,
      ancestorBoost,
      pinBoost,
      pinned,
      must: must.has(node.id),
      ...rendered,
    })
    }

    return { dropped, candidates, belowThreshold }
  }

  let { dropped, candidates, belowThreshold } = collect(admitRelevance)
  // Fallback ladder, step one: an empty buffer is a failure, not precision. If the
  // floor admitted nothing, retry once without it and say so in the result.
  let relaxed = false
  if (candidates.length === 0 && admitRelevance > 0) {
    const retried = collect(0)
    dropped = retried.dropped
    candidates = retried.candidates
    belowThreshold = retried.belowThreshold
    relaxed = candidates.length > 0
  }

  // Fallback is the retry above: an empty buffer is a failure, so the floor is dropped
  // once and the best-scoring available nodes come back. Because the blend includes
  // path weight, those are naturally the ones nearest the reader. An explicit
  // "walk up the ancestors" rung was measured to be unreachable: every case that
  // empties the relaxed pass (all branches ignored or hidden) also empties the
  // ancestor chain, since it obeys the same marks.

  const compelled = candidates.filter(candidate => candidate.must)
  const optional = candidates.filter(candidate => !candidate.must).sort((left, right) => right.weight - left.weight)
  const capacity = Math.max(0, topK - compelled.length)
  const capped = [...compelled, ...optional.slice(0, capacity)]
  let overCap = 0
  for (const candidate of optional.slice(capacity)) {
    overCap++
    dropped.push({ nodeId: candidate.nodeId, weight: candidate.weight, reason: 'top-k' })
  }

  // Budget pass: value per token, compelled nodes reserved first.
  const ordered = [...capped].sort((left, right) => {
    if (left.must !== right.must) return left.must ? -1 : 1
    return right.weight / Math.max(1, right.tokens) - left.weight / Math.max(1, left.tokens)
  })
  const chosen: Candidate[] = []
  let tokensUsed = 0
  let overBudget = 0
  for (const candidate of ordered) {
    if (tokensUsed + candidate.tokens > budget) {
      overBudget++
      dropped.push({ nodeId: candidate.nodeId, weight: candidate.weight, reason: 'budget' })
      continue
    }
    tokensUsed += candidate.tokens
    chosen.push(candidate)
  }
  chosen.sort((left, right) => right.weight - left.weight)

  return {
    query: options.query,
    originId,
    budget,
    tokensUsed,
    selected: chosen.map(candidate => ({
      nodeId: candidate.nodeId,
      kind: candidate.kind,
      weight: round(candidate.weight),
      tokens: candidate.tokens,
      compressed: candidate.compressed,
      text: candidate.text,
      breakdown: {
        relevance: round(candidate.relevance),
        pathCost: round(candidate.pathCost),
        pathWeight: round(candidate.weightOfPath),
        ancestorBoost: candidate.ancestorBoost,
        pinBoost: candidate.pinBoost,
        combine: params.combine,
      },
    })),
    dropped,
    counts: {
      considered: tree.nodes.size,
      belowThreshold,
      overCap,
      overBudget,
      ...(relaxed ? { relaxed: true } : {}),
    },
  }
}

/** Round to four decimals for logs and tool output. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * Render one recall result as the model-facing context block.
 * @param result - recall result.
 * @param options - optional node labels, keyed by node id.
 * @returns A compact block, or an empty string when nothing was selected.
 */
export function renderContextBlock(result: RetrieveResult, options: { labels?: Record<NodeId, string> } = {}): string {
  if (result.selected.length === 0) return ''
  const header = `[token-tree memory] ${result.selected.length}/${result.counts.considered} nodes, `
    + `${result.tokensUsed}/${result.budget} tokens, origin ${result.originId}`
  const lines = result.selected.map((node) => {
    const label = options.labels?.[node.nodeId] ?? node.kind
    const flags = [node.compressed ? 'compressed' : '', `w=${node.weight}`, `path=${node.breakdown.pathCost}`]
      .filter(part => part.length > 0)
      .join(' ')
    return `- (${node.nodeId} ${label} ${flags}) ${node.text}`
  })
  return [header, ...lines].join('\n')
}
