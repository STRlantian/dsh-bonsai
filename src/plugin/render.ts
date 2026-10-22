/**
 * Text rendering of one conversation tree.
 *
 * Shared by the `/tree` command (and, later, by the header-button popover), so
 * the same summary reaches a human whichever surface asks. The outline follows
 * the root→focus spine and shows every off-spine sibling as one line: that keeps
 * the alternatives visible without dumping hundreds of tool leaves.
 *
 * @module dsh-token-tree/plugin/render
 */

import type { MemoryTree } from '../core/graph.ts'

/** Options of {@link renderTree}. */
export interface RenderTreeOptions {
  /** Start from this node instead of the current one. */
  nodeId?: string
  /** Maximum tree lines before eliding the rest; defaults to 40. */
  maxLines?: number
  /** How many levels of off-spine branches to expand; defaults to `0` (summarized as one line). */
  depth?: number
  /** Show tool-result nodes as their own lines; defaults to `false` (folded into a badge). */
  includeTools?: boolean
  /** Active session-wide instructions, shown above the tree. */
  constraints?: readonly string[]
}

/** Shorten one node's text for a tree line. */
function preview(text: string, width = 56): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`
}

/**
 * Render one tree as a compact multi-line outline.
 * @param tree - the tree to describe.
 * @param options - focus node, expansion depth, and line cap.
 * @returns Text suitable for a command result or a popover.
 */
export function renderTree(tree: MemoryTree, options: RenderTreeOptions = {}): string {
  const stats = tree.stats()
  const focusId = options.nodeId ?? tree.currentId
  tree.node(focusId)
  const maxLines = options.maxLines ?? 40
  const sideDepth = options.depth ?? 0
  const showTools = options.includeTools === true

  const counts = new Map<string, number>()
  for (const node of tree.nodes.values()) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1)
  const kinds = [...counts.entries()].sort((left, right) => right[1] - left[1])
    .map(([kind, count]) => `${kind}=${count}`)
    .join('  ')

  const lines: string[] = [
    `token-tree · ${stats.nodes} nodes, ${stats.edges} edges, depth ${stats.maxDepth}`
    + `, mean edge cost ${stats.averageCost.toFixed(2)} · ${stats.totalTokens} tokens`,
    `kinds: ${kinds}`,
    `focus: ${focusId}${focusId === tree.currentId ? ' (current)' : ''}`,
  ]
  const constraints = options.constraints ?? []
  if (constraints.length > 0) {
    lines.push(`constraints in force: ${constraints.map(text => `「${text}」`).join(' ')}`)
  }
  lines.push('')

  /**
   * Build one node line: marker, id, kind, incoming cost, badges, preview.
   * @param id - node to describe.
   * @param indent - outline depth.
   * @returns The formatted line.
   */
  const describeNode = (id: string, indent: number): string => {
    const node = tree.node(id)
    const edge = node.parentId === null ? undefined : tree.edge(node.parentId, id)
    const cost = edge === undefined
      ? ''
      : ` cost=${edge.cost.toFixed(2)}${edge.updates > 0 ? `(${edge.lastReason ?? 'updated'})` : ''}`
    const flags = [
      node.metadata.ok === false ? 'FAILED' : '',
      node.metadata.pinned === true ? 'pinned' : '',
      node.metadata.ignored === true ? 'ignored' : '',
    ].filter(flag => flag.length > 0)
    // Tool results are leaves of the answer that requested them; folding them
    // into a badge keeps the dialogue readable. `includeTools` expands them.
    const tools = showTools ? [] : node.children.filter(child => tree.node(child).kind === 'tool_result')
    const failed = tools.filter(child => tree.node(child).metadata.ok === false).length
    const badge = tools.length === 0
      ? ''
      : ` +${tools.length} tool${tools.length === 1 ? '' : 's'}${failed > 0 ? ` (${failed} failed)` : ''}`
    return `${'  '.repeat(indent)}${node.id === focusId ? '▶ ' : ''}${node.id} [${node.kind}]${cost}`
      + `${flags.length > 0 ? ` {${flags.join(',')}}` : ''}${badge} ${preview(node.content)}`
  }

  // The outline follows the root→focus spine; every off-spine sibling is shown
  // as one line so the alternatives stay visible without exploding the view.
  const spine = new Set(tree.pathCost(focusId, tree.rootId).path)
  let emitted = 0
  let elided = 0

  /**
   * Append one line and count it against the cap.
   * @param line - rendered line.
   */
  const emit = (line: string): void => {
    lines.push(line)
    emitted += 1
  }

  /**
   * Walk the spine, summarizing off-spine siblings.
   * @param id - node on the spine.
   * @param indent - outline depth.
   */
  const continueSpine = (id: string, indent: number): void => {
    if (emitted >= maxLines) {
      elided += 1
      return
    }
    emit(describeNode(id, indent))
    const children = tree.node(id).children
      .filter(child => showTools || tree.node(child).kind !== 'tool_result')
    const next = children.filter(child => spine.has(child))
    const sides = children.filter(child => !spine.has(child))
    for (const side of sides) {
      if (emitted >= maxLines) {
        elided += 1
        break
      }
      if (indent + 1 < sideDepth) {
        continueSpine(side, indent + 1)
        continue
      }
      const below = tree.subtree(side).length - 1
      emit(`${describeNode(side, indent + 1)}${below > 0 ? ` (+${below} below)` : ''}`)
    }
    for (const child of next) continueSpine(child, indent + 1)
  }
  continueSpine(tree.rootId, 0)

  if (elided > 0) lines.push(`… ${elided} more line(s) elided; pass a node id to focus`)

  const spineCost = tree.pathCost(focusId, tree.rootId)
  lines.push('')
  lines.push(`focus → root: cost ${spineCost.cost.toFixed(2)} over ${spineCost.path.length - 1} hop(s)`)
  const branches = tree.node(tree.rootId).children
    .map(child => ({ child, size: tree.subtree(child).length }))
    .sort((left, right) => right.size - left.size)
    .slice(0, 4)
  if (branches.length > 0) {
    lines.push(`top branches: ${branches.map(entry => `${entry.child}:${entry.size}`).join('  ')}`)
  }
  return lines.join('\n')
}
