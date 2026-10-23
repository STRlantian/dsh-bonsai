/**
 * Block view of a conversation tree.
 *
 * The compact panel shows one block per exchange (question + its answer + that
 * turn's tool results) instead of one node per event: a 400-node tree over 30
 * exchanges is unreadable at node granularity.
 *
 * The editor offers a second view — {@link nodesOf} — that exposes *every* node,
 * including answers, tool results, reflections and notes, because restructuring
 * sometimes needs to act on a node the block view hides.
 *
 * @module dsh-token-tree/plugin/blocks
 */

import type { MemoryTree } from '../core/graph.ts'
import type { MemoryNode, NodeId } from '../core/types.ts'
import { truncateToTokens } from '../core/tokens.ts'

/** How a block is attached to its parent. */
export type BlockOrigin = 'chain' | 'auto' | 'topic'

/** One tool call shown as a chip on a block. */
export interface BlockTool {
  /** Tool name. */
  name: string
  /** Whether the call succeeded. */
  ok: boolean
  /** Failure text, when it failed. */
  error?: string
}

/** One exchange. */
export interface BlockView {
  /** Question node id; also the block id. */
  id: NodeId
  /** Parent block id, `null` for a top-level branch. */
  parentId: NodeId | null
  /** How this block reached its parent. */
  origin: BlockOrigin
  /** Score recorded when the system attached this block; `auto` only. */
  score?: number
  /** Incoming edge cost. */
  cost: number
  /** Cheapest-path cost from the current focus, for distance colouring. */
  pathCost: number
  /** Question + answer token estimate. */
  tokens: number
  /** Question text. */
  question: string
  /** Answer text, empty until the assistant answers. */
  answer: string
  /** Tool calls that belonged to this exchange. */
  tools: BlockTool[]
  /** User pin. */
  pinned: boolean
  /** User ignore. */
  ignored: boolean
  /** Turn this exchange belongs to; the transcript locates rows by turn. */
  turn?: number
  /** Creation time of the question. */
  timestamp: number
}

/** Body of `GET /api/token-tree/tree`. */
export interface TreePayload {
  /** Session described. */
  sessionId: string
  /** Current focus node. */
  focusId: NodeId
  /** Node the next turn is anchored on, when the user picked one. */
  anchoredId?: NodeId
  /** Structural counters for the header. */
  stats: { blocks: number; branches: number; maxDepth: number; tokens: number }
  /** Instructions still in force; they are not blocks because they are session-wide. */
  constraints: { text: string; createdAt: number }[]
  /** Blocks in creation order. */
  blocks: BlockView[]
}

/** Longest text kept per side of a block. */
const MAX_SIDE_TOKENS = 320

/**
 * Read the answer that belongs to one question.
 *
 * The last answer child wins: a retried answer is appended under the same
 * question, and the newest one is what the user is looking at.
 * @param tree - memory tree.
 * @param question - question node.
 * @returns The answer node, when one exists.
 */
function answerOf(tree: MemoryTree, question: MemoryNode): MemoryNode | undefined {
  let found: MemoryNode | undefined
  for (const child of question.children) {
    const node = tree.node(child)
    if (node.kind === 'answer' && !tree.hidden(node.id)) found = node
  }
  return found
}

/**
 * Map a question's parent node to the block it belongs under.
 * @param tree - memory tree.
 * @param parentId - parent node of the question.
 * @returns Parent block id, or `null` for a top-level branch.
 */
function blockParent(tree: MemoryTree, parentId: NodeId | null): NodeId | null {
  if (parentId === null) return null
  if (parentId === tree.rootId) return null
  // A parent that was pruned leaves a dangling id; the block is top-level then.
  if (!tree.nodes.has(parentId)) return null
  const parent = tree.node(parentId)
  if (parent.kind === 'question') return parent.id
  if (parent.kind === 'answer') {
    const owner = parent.parentId === null || !tree.nodes.has(parent.parentId)
      ? undefined
      : tree.node(parent.parentId)
    return owner !== undefined && owner.kind === 'question' ? owner.id : null
  }
  return null
}

/**
 * Build the block view of one tree.
 * @param tree - memory tree to project.
 * @param options - focus node override.
 * @returns Payload ready to be served to the client.
 */
export function blocksOf(
  tree: MemoryTree,
  options: {
    focusId?: NodeId
    anchoredId?: NodeId
    constraints?: readonly { text: string; createdAt: number }[]
  } = {},
): TreePayload {
  const focusId = options.focusId ?? tree.currentId
  const distance = tree.distancesFrom(focusId)
  const questions = [...tree.nodes.values()]
    .filter(node => node.kind === 'question' && !tree.hidden(node.id))
    .sort((left, right) => left.timestamp - right.timestamp)

  const blocks: BlockView[] = questions.map((question, index) => {
    const answer = answerOf(tree, question)
    const tools: BlockTool[] = []
    if (answer !== undefined) {
      for (const child of answer.children) {
        const node = tree.node(child)
        if (node.kind !== 'tool_result') continue
        tools.push({
          name: typeof node.metadata.toolName === 'string' ? node.metadata.toolName : 'tool',
          ok: node.metadata.ok !== false,
          ...(typeof node.metadata.error === 'string' ? { error: node.metadata.error } : {}),
        })
      }
    }
    const parentId = blockParent(tree, question.parentId)
    const edge = question.parentId === null || !tree.nodes.has(question.parentId)
      ? undefined
      : tree.edge(question.parentId, question.id)
    // The first block starts the session; every later block that grew straight
    // off the root opened a new topic.
    const attached = question.metadata.attached
    const origin: BlockOrigin = attached === 'semantic'
      ? 'auto'
      : attached === 'topic' || (parentId === null && index > 0)
        ? 'topic'
        : 'chain'
    const pathCost = distance.get(question.id) ?? 0
    return {
      id: question.id,
      parentId,
      origin,
      ...(question.metadata.attachScore === undefined ? {} : { score: Number(question.metadata.attachScore) }),
      cost: Number((edge?.cost ?? 0).toFixed(3)),
      // `distance` is measured from the focus, so a node the focus cannot reach
      // reports the far end rather than zero.
      pathCost: Number.isFinite(pathCost) ? Number(pathCost.toFixed(3)) : 0,
      tokens: question.tokens + (answer?.tokens ?? 0),
      question: truncateToTokens(question.content, MAX_SIDE_TOKENS),
      answer: answer === undefined ? '' : truncateToTokens(answer.content, MAX_SIDE_TOKENS),
      tools,
      pinned: question.metadata.pinned === true,
      ignored: question.metadata.ignored === true,
      ...(typeof question.metadata.turn === 'number' ? { turn: question.metadata.turn } : {}),
      timestamp: question.timestamp,
    }
  })

  // Fork points: a parent — the root included — with more than one child block.
  const childCounts = new Map<string, number>()
  for (const block of blocks) {
    const key = block.parentId ?? '__root__'
    childCounts.set(key, (childCounts.get(key) ?? 0) + 1)
  }
  const branches = [...childCounts.values()].filter(count => count > 1).length

  return {
    sessionId: tree.sessionId,
    focusId,
    ...(options.anchoredId === undefined ? {} : { anchoredId: options.anchoredId }),
    stats: {
      blocks: blocks.length,
      branches,
      maxDepth: tree.stats().maxDepth,
      tokens: blocks.reduce((total, block) => total + block.tokens, 0),
    },
    constraints: (options.constraints ?? []).map(entry => ({ text: entry.text, createdAt: entry.createdAt })),
    blocks,
  }
}

/** One node in the full-tree view. */
export interface NodeRow {
  /** Node id. */
  id: NodeId
  /** Parent node, `null` for the root or a repaired top-level node. */
  parentId: NodeId | null
  /** Node kind, so the row can be styled and filtered. */
  kind: string
  /** First line of the content, token-truncated. */
  preview: string
  /**
   * The answer that belongs to a question node, token-truncated.
   *
   * The graph draws one box per exchange: the question is the title and this is the
   * body, so a Q/A pair reads as a single unit instead of two chained boxes.
   */
  detail?: string
  /** Token estimate of the node, reasoning included. */
  tokens: number
  /** Share of `tokens` spent on reasoning, when the model reported any. */
  reasoningTokens?: number
  /** Cost of the edge into this node. */
  cost: number
  /** Cheapest-path cost from the focus, `0` when unreachable. */
  pathCost: number
  /** Distance from the root, for indentation. */
  depth: number
  /** User pin. */
  pinned: boolean
  /** User ignore. */
  ignored: boolean
  /** How the node reached its parent, when recorded. */
  attached?: string
  /** Turn the node belongs to; the transcript locates rows by turn. */
  turn?: number
  /** Creation time. */
  timestamp: number
}

/** Body of `GET /api/token-tree/tree?view=nodes`. */
export interface NodesPayload {
  /** Session described. */
  sessionId: string
  /** Current focus node. */
  focusId: NodeId
  /** Node the next turn is anchored on, when the user picked one. */
  anchoredId?: NodeId
  /** Counters for the header. */
  stats: { nodes: number; questions: number; answers: number; tools: number; maxDepth: number; branches: number; tokens: number }
  /** Instructions still in force. */
  constraints: { text: string; createdAt: number }[]
  /** Every node, parents before children. */
  nodes: NodeRow[]
  /**
   * Roots of hidden subtrees, newest first.
   *
   * Only nodes marked deleted themselves appear here: their descendants are hidden by
   * inheritance, so listing them would offer "restore" on rows the user never hid.
   */
  hidden: HiddenRow[]
}

/** One hidden branch root, as listed in the recycle bin. */
export interface HiddenRow {
  /** Node id. */
  id: NodeId
  /** What it is. */
  kind: string
  /** One-line preview. */
  preview: string
  /** Where it used to hang. */
  parentId: NodeId | null
  /** Turn it belongs to. */
  turn?: number
  /** Nodes in the hidden subtree, including the root. */
  subtreeSize: number
  /** Tokens in the hidden subtree. */
  tokens: number
}

/** Longest preview kept in the node view. */
const MAX_PREVIEW_TOKENS = 80

/**
 * Build the node-granular view: every question, answer, tool result, reflection
 * and note, in tree order.
 * @param tree - memory tree to project.
 * @param options - focus override and the pending manual anchor.
 * @returns Payload ready to be served to the client.
 */
export function nodesOf(
  tree: MemoryTree,
  options: {
    focusId?: NodeId
    anchoredId?: NodeId
    constraints?: readonly { text: string; createdAt: number }[]
  } = {},
): NodesPayload {
  const focusId = options.focusId ?? tree.currentId
  const distance = tree.distancesFrom(focusId)
  const rows: NodeRow[] = []
  const seen = new Set<NodeId>()

  const visit = (id: NodeId, depth: number): void => {
    if (seen.has(id) || depth > 200) return
    seen.add(id)
    // A soft-deleted branch is not shown at all, children included.
    if (tree.hidden(id)) return
    const node = tree.node(id)
    rows.push({
      id,
      parentId: node.parentId,
      kind: node.kind,
      preview: truncateToTokens(node.content, MAX_PREVIEW_TOKENS),
      // The answer under a question travels with it, so the graph can draw one box
      // per exchange instead of two.
      ...(node.kind === 'question' && answerOf(tree, node) !== undefined
        ? { detail: truncateToTokens(answerOf(tree, node)!.content, MAX_PREVIEW_TOKENS) }
        : {}),
      tokens: node.tokens,
      ...(typeof node.metadata.reasoningTokens === 'number' && node.metadata.reasoningTokens > 0
        ? { reasoningTokens: node.metadata.reasoningTokens }
        : {}),
      cost: Number((node.parentId === null ? 0 : (tree.edge(node.parentId, id)?.cost ?? 0)).toFixed(3)),
      pathCost: Number.isFinite(distance.get(id) ?? Number.POSITIVE_INFINITY) ? Number((distance.get(id) ?? 0).toFixed(3)) : 0,
      depth,
      pinned: node.metadata.pinned === true,
      ignored: node.metadata.ignored === true,
      ...(typeof node.metadata.attached === 'string' ? { attached: node.metadata.attached } : {}),
      ...(typeof node.metadata.turn === 'number' ? { turn: node.metadata.turn } : {}),
      timestamp: node.timestamp,
    })
    for (const child of node.children) visit(child, depth + 1)
  }

  visit(tree.rootId, 0)
  // Anything not reachable from the root still belongs to the conversation.
  for (const node of tree.nodes.values()) if (!seen.has(node.id)) visit(node.id, 0)

  let questions = 0
  let answers = 0
  let tools = 0
  let branches = 0
  for (const node of tree.nodes.values()) {
    if (tree.hidden(node.id)) continue
    if (node.kind === 'question') questions++
    else if (node.kind === 'answer') answers++
    else if (node.kind === 'tool_result') tools++
    if (node.children.length > 1) branches++
  }

  const hidden: HiddenRow[] = []
  for (const node of tree.nodes.values()) {
    if (node.metadata.deleted !== true) continue
    const subtree = tree.subtree(node.id)
    hidden.push({
      id: node.id,
      kind: node.kind,
      preview: (node.summary ?? node.content).replace(/\s+/g, ' ').slice(0, 80),
      parentId: node.parentId,
      ...(typeof node.metadata.turn === 'number' ? { turn: node.metadata.turn } : {}),
      subtreeSize: subtree.length,
      tokens: subtree.reduce((sum, id) => sum + (tree.nodes.get(id)?.tokens ?? 0), 0),
    })
  }
  // Newest first: the last hidden branch is the one most likely to be wanted back.
  hidden.sort((left, right) => Number(right.id.slice(1)) - Number(left.id.slice(1)))

  return {
    sessionId: tree.sessionId,
    focusId,
    ...(options.anchoredId === undefined ? {} : { anchoredId: options.anchoredId }),
    stats: {
      nodes: rows.length,
      questions,
      answers,
      tools,
      maxDepth: tree.stats().maxDepth,
      branches,
      tokens: tree.stats().totalTokens,
    },
    constraints: (options.constraints ?? []).map(entry => ({ text: entry.text, createdAt: entry.createdAt })),
    nodes: rows,
    hidden,
  }
}
