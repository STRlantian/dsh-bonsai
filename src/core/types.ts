/**
 * Core data model of the weighted conversation tree.
 *
 * The tree is the durable shape of one learning dialogue: questions descend
 * into the concepts they mention, answers and tool results hang below the
 * question that triggered them, and reflections attach where something went
 * wrong. Every parent→child relationship carries a non-negative `cost`; higher
 * cost means "bringing this path back into the cache hurts more", which is what
 * retrieval later converts into a multiplicative weight.
 *
 * @module dsh-bonsai/core/types
 */

/** Opaque node identifier. */
export type NodeId = string

/** Opaque edge identifier, `${from}->${to}`. */
export type EdgeId = string

/** JSON data allowed in node metadata. */
export type JsonPrimitive = string | number | boolean | null

/** Lossless JSON value. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** What a node represents in the dialogue. */
export type NodeKind = 'question' | 'answer' | 'tool_result' | 'reflection' | 'note' | 'goal'

/** Annotation carried by a node. Unknown keys are preserved for callers. */
export interface NodeMetadata {
  /** Tool that produced this node, for `tool_result` nodes. */
  toolName?: string
  /** Provider tool-call id, when the node mirrors a real call. */
  toolCallId?: string
  /** Whether the producing operation succeeded. */
  ok?: boolean
  /** Failure text, when `ok` is false. */
  error?: string
  /** Agent step index that produced the node. */
  step?: number
  /** User pinned this branch: retrieval boosts it. */
  pinned?: boolean
  /** User ignored this branch: retrieval drops it and traversal penalizes it. */
  ignored?: boolean
  /** Free-form tags. */
  tags?: string[]
  /** Ordinal of this child among its siblings. */
  branch?: number
  /** Additional caller-provided annotations. */
  [key: string]: JsonValue | undefined
}

/** One dialogue node. */
export interface MemoryNode {
  /** Stable id. */
  id: NodeId
  /** What the node represents. */
  kind: NodeKind
  /** Full text used for embedding and for the model when budget allows. */
  content: string
  /** Optional compressed form used when the token budget is tight. */
  summary?: string
  /**
   * Embedding of `summary`, when a summary exists.
   *
   * Matching against the summary as well as the full text lets a long node be found by
   * its topic line without paying to embed it per query. Recall takes the better of the
   * two similarities.
   */
  summaryEmbedding?: number[]
  /** Measured token count of `summary`, when a tokenizer was available. */
  summaryTokens?: number
  /** Unit-length embedding of `content`. */
  embedding: number[]
  /** Parent node, `null` only for the root. */
  parentId: NodeId | null
  /** Child ids in insertion order. */
  children: NodeId[]
  /** Wall-clock creation time in epoch milliseconds. */
  timestamp: number
  /** Estimated token length of `content`. */
  tokens: number
  /** Node annotations. */
  metadata: NodeMetadata
}

/** Per-component explanation of one edge cost. */
export interface EdgeCostComponents {
  /** `1 - cos(parent, child)`, clamped to `[0, 1]`. */
  semanticJump: number
  /** `log1p(Δt / timeScaleMs)`, clamped to `[0, timeGapCap]`. */
  timeGap: number
  /** `1` when the edge opens a second branch under the same parent. */
  branchSwitch: number
  /** User mark: `1` ignored, `-0.5` pinned, `0` untouched. */
  userMark: number
}

/** One directed parent→child edge with its traversal cost. */
export interface MemoryEdge {
  /** `${from}->${to}`. */
  id: EdgeId
  /** Parent side. */
  from: NodeId
  /** Child side. */
  to: NodeId
  /** Non-negative traversal cost; higher is worse. */
  cost: number
  /** Cost breakdown before clamping. */
  components: EdgeCostComponents
  /** Creation time. */
  createdAt: number
  /** Last cost update. */
  updatedAt: number
  /** How many times the cost was adjusted by an observation. */
  updates: number
  /** Why the cost last changed. */
  lastReason?: string
}

/** Tunables for edge cost, path weighting, and retrieval. */
export interface WeightParams {
  /** Weight of the semantic-jump term. */
  wSemantic: number
  /** Weight of the time-gap term. */
  wTime: number
  /** Weight of the branch-switch term. */
  wBranch: number
  /** Weight of the user-mark term. */
  wUser: number
  /** Time scale for `log1p(Δt / timeScaleMs)`, in milliseconds. */
  timeScaleMs: number
  /** Upper clamp of the normalized time-gap term. */
  timeGapCap: number
  /** Lower clamp of any edge cost. */
  minCost: number
  /** Upper clamp of any edge cost. */
  maxCost: number
  /** Extra cost charged when a path traverses an edge downward. */
  descentPenalty: number
  /** Decay of path weight: `exp(-lambda * pathCost)`. */
  lambda: number
  /** Relevance share for `linear`; relevance exponent for `product`. */
  alpha: number
  /** How relevance and path weight combine. */
  combine: 'linear' | 'product'
  /** Multiplier applied to nodes on the ancestor chain of the query origin. */
  ancestorBoost: number
  /** Multiplier applied to user-pinned nodes. */
  pinBoost: number
  /** Nodes below this weight never enter the buffer. */
  threshold: number
  /**
   * Raw-relevance floor applied before ranking.
   *
   * Admission and ranking are different jobs: relevance says "is this about the
   * query", the blended weight says "how much do I want it". A local-embedding cosine
   * for a genuinely relevant node lands around 0.35–0.55, so gating on the blend (which
   * compresses towards zero) empties the buffer. 0.3 admits real matches and rejects
   * the noise floor.
   */
  admitRelevance: number
  /**
   * Whether matching may use a node's derived topic-line summary in addition to its
   * full text. Off makes recall depend on the whole content only.
   */
  summaryMatch: boolean
  /** Retrieval candidate cap before the budget pass. */
  topK: number
  /** Token budget of the assembled buffer. */
  tokenBudget: number
  /** Weight below which a node is compressed to its summary. */
  compressBelow: number
  /** Node content is truncated to this many tokens when compressed without a summary. */
  compressedTokens: number
  /** Cost delta applied to the failing edge. */
  failureDelta: number
  /** Cost delta removed from the succeeding edge. */
  successDelta: number
  /** Edge cost delta that a user "ignore" mark adds. */
  ignorePenalty: number
}

/** Default edge and retrieval parameters; every field is overridable from `cordis.yml`. */
export const DEFAULT_WEIGHT_PARAMS: WeightParams = {
  wSemantic: 1,
  wTime: 0.15,
  wBranch: 0.6,
  wUser: 0.4,
  timeScaleMs: 60_000,
  timeGapCap: 5,
  minCost: 0,
  maxCost: 10,
  descentPenalty: 0.35,
  lambda: 0.5,
  alpha: 0.6,
  combine: 'linear',
  ancestorBoost: 1.15,
  pinBoost: 1.5,
  threshold: 0.12,
  admitRelevance: 0.3,
  summaryMatch: true,
  topK: 12,
  tokenBudget: 2000,
  compressBelow: 0.25,
  compressedTokens: 48,
  failureDelta: 0.75,
  successDelta: 0.25,
  ignorePenalty: 1.5,
}

/** Guard rails of the supervised loop. */
export interface LoopPolicy {
  /** Hard cap of model steps per turn. */
  maxSteps: number
  /** Hard cap of reflection nodes written per turn. */
  maxReflections: number
  /** Hard cap of backtrack operations per turn. */
  maxBacktracks: number
  /** Wall-clock budget of one turn, in milliseconds. */
  timeoutMs: number
  /** Consecutive failures that trigger reflection, then backtracking. */
  failureThreshold: number
  /** Minimum estimated branch value worth backtracking to. */
  minBranchValue: number
  /** Stop the turn when the estimated progress score stays below this. */
  stallScore: number
}

/** Default loop guard rails. */
export const DEFAULT_LOOP_POLICY: LoopPolicy = {
  maxSteps: 12,
  maxReflections: 4,
  maxBacktracks: 3,
  timeoutMs: 120_000,
  failureThreshold: 2,
  minBranchValue: 0.05,
  stallScore: 0.2,
}

/** Result of a path-cost query. */
export interface PathCostResult {
  /** Origin node. */
  from: NodeId
  /** Destination node. */
  to: NodeId
  /** Total cost of the cheapest path. */
  cost: number
  /** Nodes along that path, origin first. */
  path: NodeId[]
}

/** Serialized tree, as written to disk or to a session event. */
export interface SerializedTree {
  /** Session the tree belongs to. */
  sessionId: string
  /** Root node id. */
  rootId: NodeId
  /** Node the agent is currently working at. */
  currentId: NodeId
  /** Parameters the tree was built with. */
  params: WeightParams
  /** All nodes. */
  nodes: MemoryNode[]
  /** All edges. */
  edges: MemoryEdge[]
}
