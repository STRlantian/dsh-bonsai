/**
 * The conversation memory tree.
 *
 * `MemoryTree` owns nodes, edges, the agent's current position, and the only two
 * graph algorithms the recall policy needs: cheapest-path cost (Dijkstra over the
 * tree, charged differently up and down an edge) and subtree enumeration for
 * branch scoring.
 *
 * Traversal is deliberately asymmetric. Walking up toward the root pays only
 * `edge.cost`, because that path was actually traversed while the dialogue was
 * live. Walking down pays `edge.cost + params.descentPenalty`, because entering a
 * branch the agent already left is the "cache negative effect" this whole model
 * is about. `pathCost(current, node)` therefore returns the cost a retrieval
 * candidate really implies, while `pathCost(node, root)` degenerates to the plain
 * parent-chain sum the specification asks for.
 *
 * @module dsh-bonsai/core/graph
 */

import type {
  EdgeId,
  MemoryEdge,
  MemoryNode,
  NodeId,
  NodeKind,
  NodeMetadata,
  PathCostResult,
  SerializedTree,
  WeightParams,
} from './types.ts'
import { DEFAULT_WEIGHT_PARAMS } from './types.ts'
import { computeEdgeCost } from './weight.ts'
import { DEFAULT_EMBEDDING_DIMENSION, embedText } from './embedding.ts'
import { estimateTokens, topicLine, truncateToTokens } from './tokens.ts'

/** Nodes longer than this get a derived topic-line summary for matching. */
const SUMMARY_TRIGGER_TOKENS = 40
/** How much of the node the derived summary may keep. */
const SUMMARY_MAX_CHARS = 40

/** Options accepted by {@link MemoryTree.create}. */
export interface CreateTreeOptions {
  /** Session the tree belongs to. */
  sessionId: string
  /** Parameter overrides merged over {@link DEFAULT_WEIGHT_PARAMS}. */
  params?: Partial<WeightParams>
  /** Text of the synthetic root node. */
  rootContent?: string
  /** Clock override, mainly for tests. */
  now?: number
  /** Embedding width. */
  embeddingDimension?: number
}

/** Input of {@link MemoryTree.addNode}. */
export interface AddNodeInput {
  /** What the node represents. */
  kind: NodeKind
  /** Full text; also the embedding source when `embedding` is omitted. */
  content: string
  /** Compressed form used under budget pressure. */
  summary?: string
  /** Precomputed embedding, for deployments with a real embedding provider. */
  embedding?: number[]
  /** Parent; defaults to the current node. */
  parentId?: NodeId | null
  /** Creation time; defaults to `Date.now()`. */
  timestamp?: number
  /** Node annotations. */
  metadata?: NodeMetadata
  /** Move the current pointer to the new node; defaults to `true`. */
  setCurrent?: boolean
  /**
   * Measured token count, when the caller has a real tokenizer.
   *
   * Without it the node is sized by the character estimate, which is off by tens of
   * percent between scripts. Callers that can count exactly should always pass this.
   */
  tokens?: number
}

/** One adjacency step used by the path search. */
interface Step {
  id: NodeId
  weight: number
}

/** Branch summary returned by {@link MemoryTree.summarizeBranches}. */
export interface BranchSummary {
  /** Child that opens the branch. */
  nodeId: NodeId
  /** Incoming edge cost. */
  edgeCost: number
  /** Nodes in the branch, branch root included. */
  size: number
  /** Deepest offset below the branch root. */
  depth: number
  /** How many nodes in the branch carry `ok === false`. */
  failures: number
  /** Whether the user pinned any node in the branch. */
  pinned: boolean
}

/** Structural counters exposed to the `tree_query` tool. */
export interface TreeStats {
  /** Node count. */
  nodes: number
  /** Edge count. */
  edges: number
  /** Deepest node. */
  maxDepth: number
  /** Mean edge cost. */
  averageCost: number
  /** Sum of node token estimates. */
  totalTokens: number
  /** Cost of the cheapest path from the current node to the root. */
  rootPathCost: number
  /** Current node id. */
  currentId: NodeId
}

/** Copy metadata into a JSON-safe record. */
function copyMetadata(metadata: NodeMetadata | undefined): NodeMetadata {
  if (metadata === undefined) return {}
  const copy: NodeMetadata = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) copy[key] = value
  }
  return copy
}

/** Edge identifier for one ordered pair. */
export function edgeId(from: NodeId, to: NodeId): EdgeId {
  return `${from}->${to}`
}

/**
 * One conversation memory tree.
 *
 * Instances are mutable and single-session; the plugin keeps one per agent.
 */
export class MemoryTree {
  /** Session identifier. */
  readonly sessionId: string
  /** Effective parameters. */
  readonly params: WeightParams
  /** Embedding width used for nodes without a supplied embedding. */
  readonly embeddingDimension: number
  /** Nodes by id. */
  readonly nodes = new Map<NodeId, MemoryNode>()
  /** Edges by id. */
  readonly edges = new Map<EdgeId, MemoryEdge>()
  /** Root node id. */
  readonly rootId: NodeId
  /** Node the agent is currently working at. */
  currentId: NodeId

  private seq = 0

  /**
   * Build a tree with a synthetic root.
   * @param options - creation options.
   */
  constructor(options: CreateTreeOptions) {
    this.sessionId = options.sessionId
    this.params = { ...DEFAULT_WEIGHT_PARAMS, ...options.params }
    this.embeddingDimension = options.embeddingDimension ?? DEFAULT_EMBEDDING_DIMENSION
    const now = options.now ?? Date.now()
    this.rootId = this.nextId()
    const content = options.rootContent ?? 'session root'
    this.nodes.set(this.rootId, {
      id: this.rootId,
      kind: 'note',
      content,
      embedding: embedText(content, this.embeddingDimension),
      parentId: null,
      children: [],
      timestamp: now,
      tokens: estimateTokens(content),
      metadata: { tags: ['root'] },
    })
    this.currentId = this.rootId
  }

  /** Allocate the next node id. */
  private nextId(): NodeId {
    this.seq += 1
    return `n${this.seq}`
  }

  /**
   * Read a node, failing loud on an unknown id.
   * @param id - node id.
   * @returns The node.
   */
  node(id: NodeId): MemoryNode {
    const node = this.nodes.get(id)
    if (node === undefined) throw new Error(`dsh-bonsai: unknown node ${JSON.stringify(id)}`)
    return node
  }

  /**
   * Read an edge.
   * @param from - parent id.
   * @param to - child id.
   * @returns The edge, or `undefined` when the pair is unlinked.
   */
  edge(from: NodeId, to: NodeId): MemoryEdge | undefined {
    return this.edges.get(edgeId(from, to))
  }

  /**
   * Append one node, link it to its parent, and optionally move the cursor.
   * @param input - node description.
   * @returns The created node.
   */
  addNode(input: AddNodeInput): MemoryNode {
    const id = this.nextId()
    const content = input.content
    const timestamp = input.timestamp ?? Date.now()
    const node: MemoryNode = {
      id,
      kind: input.kind,
      content,
      embedding: input.embedding ?? embedText(content, this.embeddingDimension),
      parentId: null,
      children: [],
      timestamp,
      tokens: input.tokens ?? estimateTokens(content),
      metadata: copyMetadata(input.metadata),
    }
    if (input.summary !== undefined) node.summary = input.summary
    // Long nodes get a topic line as a derived summary: matching can then use the topic
    // (dense) while the model still receives the full text.
    if (node.summary === undefined && node.tokens > SUMMARY_TRIGGER_TOKENS) {
      const summary = topicLine(content, SUMMARY_MAX_CHARS)
      if (summary.length > 0 && summary.length < content.length) node.summary = summary
    }
    if (node.summary !== undefined) {
      node.summaryEmbedding = embedText(node.summary, this.embeddingDimension)
    }
    this.nodes.set(id, node)
    // A *missing* parent must never leave a silent second root: re-anchor on the
    // current node (or the root) so root-based readers still see the conversation.
    // An explicit `parentId: null` is deliberate and stays a root; `repair()`
    // re-attaches it afterwards.
    const requested = input.parentId === undefined ? this.currentId : input.parentId
    let anchor: NodeId | null = null
    if (requested !== null) {
      anchor = this.nodes.has(requested)
        ? requested
        : (this.currentId !== id && this.nodes.has(this.currentId) ? this.currentId : null)
    }
    if (anchor !== null && anchor !== id) this.link(anchor, id)
    if (input.setCurrent !== false) this.currentId = id
    return node
  }

  /**
   * Link an existing node under an existing parent and price the edge.
   * @param parentId - parent node id.
   * @param childId - child node id, which must not already have a parent.
   * @returns The created edge.
   */
  link(parentId: NodeId, childId: NodeId): MemoryEdge {
    const parent = this.node(parentId)
    const child = this.node(childId)
    if (child.parentId !== null) {
      throw new Error(`dsh-bonsai: node ${childId} is already linked to ${child.parentId}`)
    }
    if (parentId === childId || this.isAncestor(childId, parentId)) {
      throw new Error(`dsh-bonsai: linking ${parentId} under ${childId} would create a cycle`)
    }
    const { cost, components } = computeEdgeCost(parent, child, this.params, {
      hasSibling: parent.children.length > 0,
    })
    const now = Date.now()
    const id = edgeId(parentId, childId)
    const edge: MemoryEdge = {
      id,
      from: parentId,
      to: childId,
      cost,
      components,
      createdAt: now,
      updatedAt: now,
      updates: 0,
    }
    this.edges.set(id, edge)
    child.metadata.branch = parent.children.length
    parent.children.push(childId)
    child.parentId = parentId
    return edge
  }

  /**
   * Detach one node and its whole subtree from the tree.
   *
   * The subtree keeps its internal shape; only the edge into `id` is priced away.
   * Used by the editor to move a branch, so the node is not destroyed here.
   * @param id - subtree root; the root itself cannot be detached.
   * @returns Removed node ids.
   */
  detach(id: NodeId): NodeId[] {
    if (id === this.rootId) throw new Error('dsh-bonsai: cannot detach the root')
    const node = this.node(id)
    const parentId = node.parentId
    if (parentId === null) return []
    const removed = this.subtree(id)
    const parent = this.node(parentId)
    parent.children = parent.children.filter(child => child !== id)
    node.parentId = null
    this.edges.delete(edgeId(parentId, id))
    if (this.currentId === id || removed.includes(this.currentId)) this.currentId = parentId
    return removed
  }

  /**
   * Move one node (with its subtree) under a different parent.
   *
   * This is the editor's "change parent" action. The edge into the moved node is
   * repriced against its new parent; a move into its own subtree is refused.
   * @param id - node to move.
   * @param parentId - new parent.
   * @returns The new incoming edge.
   */
  reparent(id: NodeId, parentId: NodeId): MemoryEdge {
    if (id === this.rootId) throw new Error('dsh-bonsai: cannot move the root')
    if (id === parentId) throw new Error('dsh-bonsai: cannot move a node under itself')
    const node = this.node(id)
    this.node(parentId)
    if (this.isAncestor(id, parentId)) {
      throw new Error(`dsh-bonsai: moving ${id} under ${parentId} would create a cycle`)
    }
    if (node.parentId === parentId) throw new Error(`dsh-bonsai: ${id} is already a child of ${parentId}`)
    this.detach(id)
    return this.link(parentId, id)
  }

  /**
   * Delete one node and its whole subtree.
   * @param id - subtree root; the root cannot be deleted.
   * @returns Deleted node ids, subtree root first.
   */
  remove(id: NodeId): NodeId[] {
    if (id === this.rootId) throw new Error('dsh-bonsai: cannot delete the root')
    this.node(id)
    const removed = this.subtree(id)
    const currentInside = removed.includes(this.currentId)
    this.detach(id)
    for (const victim of removed) {
      this.nodes.delete(victim)
      for (const [key, edge] of this.edges) {
        if (edge.from === victim || edge.to === victim) this.edges.delete(key)
      }
    }
    if (currentInside || !this.nodes.has(this.currentId)) this.currentId = this.rootId
    return removed
  }

  /**
   * Re-attach every node whose parent is missing or which became a second root.
   *
   * Replay and pruning can leave a node parentless; a root-based reader (the block
   * view, `/tree`, the panel) then cannot see that whole branch. Repairing is
   * cheaper than explaining an empty conversation, and it is idempotent.
   * @returns Ids of the nodes that were re-attached.
   */
  repair(): NodeId[] {
    const fixed: NodeId[] = []
    for (const node of this.nodes.values()) {
      if (node.id === this.rootId) continue
      const parentMissing = node.parentId !== null && !this.nodes.has(node.parentId)
      // A genuine second root is just as invisible as a dangling one.
      if (!parentMissing && node.parentId !== null) continue
      const stale = node.parentId
      ;(node as { parentId: NodeId | null }).parentId = null
      if (stale !== null) this.edges.delete(edgeId(stale, node.id))
      this.link(this.rootId, node.id)
      fixed.push(node.id)
    }
    return fixed
  }

  /**
   * Move the current pointer.
   * @param id - target node.
   * @returns The target node.
   */
  moveTo(id: NodeId): MemoryNode {
    const node = this.node(id)
    this.currentId = id
    return node
  }

  /**
   * Parent id of one node.
   * @param id - node id.
   * @returns Parent id, or `null` for the root.
   */
  parentOf(id: NodeId): NodeId | null {
    return this.node(id).parentId
  }

  /**
   * Ancestors of one node, nearest first, root last.
   * @param id - node id.
   * @returns Ancestor ids, excluding the node itself.
   */
  ancestors(id: NodeId): NodeId[] {
    const chain: NodeId[] = []
    let cursor = this.node(id).parentId
    // A parent that was pruned or never linked leaves the chain dangling. Reads
    // must survive that: stop at the break instead of throwing.
    while (cursor !== null && this.nodes.has(cursor)) {
      chain.push(cursor)
      cursor = this.node(cursor).parentId
    }
    return chain
  }

  /**
   * Whether `candidate` is an ancestor of `id`.
   * @param candidate - possible ancestor.
   * @param id - node id.
   * @returns `true` when `candidate` is on the parent chain of `id`.
   */
  isAncestor(candidate: NodeId, id: NodeId): boolean {
    let cursor = this.node(id).parentId
    while (cursor !== null && this.nodes.has(cursor)) {
      if (cursor === candidate) return true
      cursor = this.node(cursor).parentId
    }
    return false
  }

  /**
   * Depth of one node, root is `0`.
   * @param id - node id.
   * @returns Depth.
   */
  depth(id: NodeId): number {
    return this.ancestors(id).length
  }

  /**
   * Lowest common ancestor of two nodes.
   * @param left - first node.
   * @param right - second node.
   * @returns The LCA id, or `null` when the two nodes are unconnected.
   */
  lca(left: NodeId, right: NodeId): NodeId | null {
    const seen = new Set<NodeId>([left, ...this.ancestors(left)])
    let cursor: NodeId | null = right
    while (cursor !== null) {
      if (seen.has(cursor)) return cursor
      cursor = this.node(cursor).parentId
    }
    return null
  }

  /**
   * Nodes of one subtree, parents before children.
   * @param id - subtree root.
   * @returns Subtree node ids, root first.
   */
  subtree(id: NodeId): NodeId[] {
    const collected: NodeId[] = []
    const stack: NodeId[] = [id]
    while (stack.length > 0) {
      const cursor = stack.pop() as NodeId
      collected.push(cursor)
      const children = this.node(cursor).children
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index])
    }
    return collected
  }

  /**
   * Adjacency of one node for path search: up and down are priced differently.
   * @param id - node id.
   * @returns Steps reachable in one hop.
   */
  private steps(id: NodeId): Step[] {
    const node = this.node(id)
    const steps: Step[] = []
    if (node.parentId !== null) {
      const edge = this.edge(node.parentId, id)
      /* c8 ignore next -- a linked node always owns its edge. */
      if (edge !== undefined) steps.push({ id: node.parentId, weight: edge.cost })
    }
    for (const child of node.children) {
      const edge = this.edge(id, child)
      /* c8 ignore next -- a child always owns its edge. */
      if (edge === undefined) continue
      steps.push({ id: child, weight: edge.cost + this.params.descentPenalty })
    }
    return steps
  }

  /**
   * Single-source cheapest-path search.
   * @param from - origin node.
   * @returns Distances and predecessors, both keyed by node id.
   */
  private search(from: NodeId): { distance: Map<NodeId, number>; previous: Map<NodeId, NodeId> } {
    this.node(from)
    const distance = new Map<NodeId, number>([[from, 0]])
    const previous = new Map<NodeId, NodeId>()
    const settled = new Set<NodeId>()
    for (;;) {
      let current: NodeId | undefined
      let best = Number.POSITIVE_INFINITY
      for (const [id, value] of distance) {
        if (settled.has(id) || value >= best) continue
        current = id
        best = value
      }
      if (current === undefined) break
      settled.add(current)
      for (const step of this.steps(current)) {
        if (settled.has(step.id)) continue
        const candidate = best + step.weight
        const known = distance.get(step.id)
        if (known === undefined || candidate < known) {
          distance.set(step.id, candidate)
          previous.set(step.id, current)
        }
      }
    }
    return { distance, previous }
  }

  /**
   * Cheapest-path distance from one node to every reachable node.
   * @param from - origin node.
   * @returns Distance by node id; the origin maps to `0`.
   */
  distancesFrom(from: NodeId): Map<NodeId, number> {
    return this.search(from).distance
  }

  /**
   * Cheapest path between two nodes.
   *
   * `pathCost(node, rootId)` is the plain parent-chain sum from the
   * specification; `pathCost(currentId, node)` is what retrieval uses and pays
   * {@link WeightParams.descentPenalty} for every edge walked downward.
   * @param from - origin node.
   * @param to - destination node.
   * @returns Total cost and the nodes on the cheapest path, origin first.
   */
  pathCost(from: NodeId, to: NodeId): PathCostResult {
    this.node(to)
    if (from === to) return { from, to, cost: 0, path: [from] }
    const { distance, previous } = this.search(from)
    const cost = distance.get(to)
    if (cost === undefined) {
      // Unreachable is a state, not a crash: a pruned or re-anchored branch simply
      // has no priced path to its root, and readers must still see the rest.
      return { from, to, cost: Number.POSITIVE_INFINITY, path: [] }
    }
    const path: NodeId[] = [to]
    let cursor: NodeId | undefined = to
    while (cursor !== from) {
      const step = previous.get(cursor)
      /* c8 ignore next -- the search proved reachability above. */
      if (step === undefined) break
      path.push(step)
      cursor = step
    }
    path.reverse()
    return { from, to, cost, path }
  }

  /**
   * Adjust one edge cost and record why.
   * @param from - parent id.
   * @param to - child id.
   * @param delta - signed change, clamped into `[minCost, maxCost]` afterwards.
   * @param reason - short machine-readable reason for the log.
   * @returns The updated edge.
   */
  adjustEdge(from: NodeId, to: NodeId, delta: number, reason: string): MemoryEdge {
    const edge = this.edge(from, to)
    if (edge === undefined) throw new Error(`dsh-bonsai: no edge ${from}->${to}`)
    edge.cost = Math.min(this.params.maxCost, Math.max(this.params.minCost, edge.cost + delta))
    edge.updatedAt = Date.now()
    edge.updates++
    edge.lastReason = reason
    return edge
  }

  /**
   * Adjust the edge that enters one node.
   * @param id - child node id.
   * @param delta - signed change.
   * @param reason - short machine-readable reason.
   * @returns The updated edge, or `undefined` for the root.
   */
  adjustIncomingEdge(id: NodeId, delta: number, reason: string): MemoryEdge | undefined {
    const parentId = this.node(id).parentId
    if (parentId === null) return undefined
    return this.adjustEdge(parentId, id, delta, reason)
  }

  /**
   * Apply or clear a user mark, keeping the incoming edge consistent.
   * @param id - node id.
   * @param marks - fields to set; `undefined` leaves a field untouched.
   * @returns The updated node.
   */
  mark(id: NodeId, marks: { pinned?: boolean; ignored?: boolean; deleted?: boolean }): MemoryNode {
    const node = this.node(id)
    const penalty = this.params.ignorePenalty
    if (marks.ignored !== undefined && marks.ignored !== node.metadata.ignored) {
      node.metadata.ignored = marks.ignored
      this.adjustIncomingEdge(id, marks.ignored ? penalty : -penalty, marks.ignored ? 'user/ignore' : 'user/unignore')
    }
    if (marks.pinned !== undefined && marks.pinned !== node.metadata.pinned) {
      node.metadata.pinned = marks.pinned
      this.adjustIncomingEdge(id, marks.pinned ? -penalty / 2 : penalty / 2, marks.pinned ? 'user/pin' : 'user/unpin')
    }
    // Deletion is a mark, not surgery: the node and its subtree stay in the graph so
    // they can be restored, and read paths skip anything whose branch is marked.
    if (marks.deleted !== undefined && marks.deleted !== node.metadata.deleted) {
      node.metadata.deleted = marks.deleted
    }
    return node
  }

  /**
   * Whether a node or one of its ancestors is marked deleted.
   *
   * Read paths use this instead of removing nodes, so "delete" stays reversible and
   * the edge costs across the rest of the tree do not move.
   * @param id - node to test.
   * @returns `true` when the node should be treated as gone.
   */
  hidden(id: NodeId): boolean {
    let cursor: NodeId | null = id
    const seen = new Set<NodeId>()
    while (cursor !== null && !seen.has(cursor) && this.nodes.has(cursor)) {
      seen.add(cursor)
      const node = this.nodes.get(cursor)
      if (node === undefined) return false
      if (node.metadata.deleted === true) return true
      cursor = node.parentId
    }
    return false
  }

  /**
   * Summarize the branches that start at one node.
   * @param parentId - node whose children are the branches.
   * @returns One summary per child, in insertion order.
   */
  summarizeBranches(parentId: NodeId): BranchSummary[] {
    const parent = this.node(parentId)
    return parent.children.map((childId) => {
      const edge = this.edge(parentId, childId)
      const members = this.subtree(childId)
      let depth = 0
      let failures = 0
      let pinned = false
      for (const member of members) {
        depth = Math.max(depth, this.ancestors(member).length - this.ancestors(childId).length)
        const node = this.node(member)
        if (node.metadata.ok === false) failures++
        if (node.metadata.pinned === true) pinned = true
      }
      return {
        nodeId: childId,
        edgeCost: edge?.cost ?? 0,
        size: members.length,
        depth,
        failures,
        pinned,
      }
    })
  }

  /**
   * Structural counters for diagnostics.
   * @returns Tree statistics.
   */
  stats(): TreeStats {
    let maxDepth = 0
    let costSum = 0
    let totalTokens = 0
    for (const node of this.nodes.values()) {
      maxDepth = Math.max(maxDepth, this.ancestors(node.id).length)
      totalTokens += node.tokens
    }
    for (const edge of this.edges.values()) costSum += edge.cost
    // A disconnected current branch reports `Infinity`; clamp it so the value stays
    // a real number through JSON and the schema check.
    const rootPath = this.pathCost(this.currentId, this.rootId).cost
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      maxDepth,
      averageCost: this.edges.size === 0 ? 0 : costSum / this.edges.size,
      totalTokens,
      rootPathCost: Number.isFinite(rootPath) ? rootPath : 0,
      currentId: this.currentId,
    }
  }

  /**
   * Detached copy of the tree as plain JSON.
   * @returns Serializable snapshot.
   */
  toJSON(): SerializedTree {
    return {
      sessionId: this.sessionId,
      rootId: this.rootId,
      currentId: this.currentId,
      params: { ...this.params },
      nodes: [...this.nodes.values()].map(node => ({ ...node, metadata: copyMetadata(node.metadata) })),
      edges: [...this.edges.values()].map(edge => ({ ...edge, components: { ...edge.components } })),
    }
  }

  /**
   * Rebuild a tree from a snapshot without repricing edges.
   * @param data - snapshot produced by {@link MemoryTree.toJSON}.
   * @returns A tree with identical costs.
   */
  static fromJSON(data: SerializedTree): MemoryTree {
    const tree = new MemoryTree({
      sessionId: data.sessionId,
      params: data.params,
      rootContent: 'placeholder',
    })
    tree.nodes.clear()
    tree.edges.clear()
    for (const node of data.nodes) {
      tree.nodes.set(node.id, { ...node, children: [...node.children], metadata: copyMetadata(node.metadata) })
    }
    for (const edge of data.edges) {
      tree.edges.set(edge.id, { ...edge, components: { ...edge.components } })
    }
    const highest = [...tree.nodes.keys()]
      .map(id => Number.parseInt(id.replace(/^n/, ''), 10))
      .filter(value => Number.isFinite(value))
      .reduce((left, right) => Math.max(left, right), 0)
    tree.seq = highest
    ;(tree as { rootId: NodeId }).rootId = data.rootId
    tree.currentId = data.currentId
    return tree
  }
}

/**
 * Render one node's text at a given compression level.
 * @param node - node to render.
 * @param compressed - whether the budget forced compression.
 * @param fallbackTokens - token ceiling used when the node has no summary.
 * @returns Text to place in the buffer.
 */
export function renderNodeText(node: MemoryNode, compressed: boolean, fallbackTokens: number): string {
  if (!compressed) return node.content
  if (node.summary !== undefined) return node.summary
  return truncateToTokens(node.content, fallbackTokens)
}
