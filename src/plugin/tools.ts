/**
 * Model-facing tools.
 *
 * Five tools cover the loop: inspect the tree, recall a weighted context buffer,
 * write a reflection, pick a better branch, and mark a branch by hand. Each one
 * is a plain `ToolDefinition` object — the exact structure `ctx.tools.register`
 * accepts and `defineTool` would compile to — so the plugin can register them
 * without importing the harness packages.
 *
 * Every tool rejects a caller without an owning agent: the tree is per-session
 * state and a direct registry call has nowhere to write it.
 *
 * @module dsh-token-tree/plugin/tools
 */

import type { NodeId, NodeKind } from '../core/types.ts'
import { renderContextBlock } from '../core/retrieve.ts'
import { scoreBranch } from '../core/reflect.ts'
import type { ContentBlockLike, ToolDefinitionLike, ToolRunContextLike, AgentLike } from './dsh.ts'
import { buildInjectedMessage } from './messages.ts'
import type { TokenTreeService } from './service.ts'

/** Node kinds the `kinds` filter accepts. */
const NODE_KINDS: readonly NodeKind[] = ['question', 'answer', 'tool_result', 'reflection', 'note', 'goal']

/** Model-facing description shared by the tree tools. */
const COMMON = 'The weighted conversation tree indexes this session: every question, answer, tool result, and reflection is a node, '
  + 'and each parent→child edge carries a cost. Retrieval scores a node by topic relevance and by the cost of the path from the current node.'

/** Object schema helper for a tool's canonical output. */
function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties, required }
}

/** Name one required argument. */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-token-tree: "${key}" must be a non-empty string`)
  }
  return value
}

/** Read an optional boolean argument. */
function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Read an optional integer argument. */
function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/** Read an optional number argument. */
function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read an optional string argument. */
function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Read an optional string array argument. */
function optionalStrings(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (!Array.isArray(value)) return undefined
  const items = value.filter((entry): entry is string => typeof entry === 'string')
  return items.length === 0 ? undefined : items
}

/** Read an optional node-kind filter. */
function optionalKinds(args: Record<string, unknown>, key: string): NodeKind[] | undefined {
  const values = optionalStrings(args, key)
  if (values === undefined) return undefined
  const kinds = values.filter((entry): entry is NodeKind => (NODE_KINDS as readonly string[]).includes(entry))
  return kinds.length === 0 ? undefined : kinds
}

/** Resolve the owning agent or fail loud. */
function requireAgent(exec: ToolRunContextLike): AgentLike {
  if (exec.agent === undefined) {
    throw new Error('dsh-token-tree: this tool needs an owning agent session; call it from a model turn')
  }
  return exec.agent
}

/** Render a value as one text block. */
function textBlock(text: string): ContentBlockLike[] {
  return [{ type: 'text', text }]
}

/**
 * Build the tool definitions this plugin registers.
 * @param service - session memory service backing every tool.
 * @returns The tool definitions, in registration order.
 */
export function createTools(service: TokenTreeService): ToolDefinitionLike[] {
  const retrieveTool: ToolDefinitionLike = {
    name: 'retrieve_context',
    description: `${COMMON} `
      + 'Use this to pull the most valuable history back into context for a query: it scores every node, applies the weight floor, '
      + 'Top-k cap, and token budget, then returns the selected nodes and injects them for your next step.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What you are about to work on or ask about.' },
        budgetTokens: { type: 'integer', description: 'Token budget of the returned buffer; defaults to the configured budget.' },
        topK: { type: 'integer', description: 'Maximum number of nodes to consider for the buffer.' },
        threshold: { type: 'number', description: 'Minimum weight in [0, 1]; lower-scored nodes are dropped.' },
        inject: { type: 'boolean', description: 'Queue the buffer as context for your next step; defaults to true.' },
        kinds: {
          type: 'array',
          description: 'Restrict to these node kinds.',
          items: { type: 'string', enum: ['question', 'answer', 'tool_result', 'reflection', 'note', 'goal'] },
        },
      },
    },
    output: {
      schema: objectSchema({
        query: { type: 'string' },
        originId: { type: 'string' },
        tokensUsed: { type: 'integer' },
        budget: { type: 'integer' },
        injected: { type: 'boolean' },
        dropped: { type: 'integer' },
        selected: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['nodeId', 'kind', 'weight', 'tokens', 'compressed', 'text'],
            properties: {
              nodeId: { type: 'string' },
              kind: { type: 'string' },
              weight: { type: 'number' },
              tokens: { type: 'integer' },
              compressed: { type: 'boolean' },
              text: { type: 'string' },
            },
          },
        },
      }, ['query', 'originId', 'tokensUsed', 'budget', 'injected', 'dropped', 'selected']),
      render: (_args, value) => {
        const record = value as { selected: { nodeId: string; kind: string; weight: number; tokens: number; compressed: boolean }[]; tokensUsed: number; budget: number; injected: boolean; dropped: number }
        if (record.selected.length === 0) {
          return textBlock(`No node qualified for "${String((value as { query?: string }).query ?? '')}".`)
        }
        const lines = record.selected.map(node =>
          `- ${node.nodeId} ${node.kind} w=${node.weight} tokens=${node.tokens}${node.compressed ? ' (compressed)' : ''}`)
        return textBlock(
          `Retrieved ${record.selected.length} node(s), ${record.tokensUsed}/${record.budget} tokens, ${record.dropped} dropped, `
          + `injected=${record.injected}.\n${lines.join('\n')}`,
        )
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const record = args as Record<string, unknown>
      const query = requireString(record, 'query')
      const kinds = optionalKinds(record, 'kinds')
      const budgetTokens = optionalInteger(record, 'budgetTokens')
      const topK = optionalInteger(record, 'topK')
      const threshold = optionalNumber(record, 'threshold')
      const result = service.retrieve(agent.session.id, {
        query,
        ...(budgetTokens === undefined ? {} : { budgetTokens }),
        ...(topK === undefined ? {} : { topK }),
        ...(threshold === undefined ? {} : { threshold }),
        ...(kinds === undefined ? {} : { kinds }),
      })
      const block = renderContextBlock(result)
      const shouldInject = optionalBoolean(record, 'inject') !== false && block.length > 0
      if (shouldInject) agent.inject(buildInjectedMessage(block))
      return {
        query,
        originId: result.originId,
        tokensUsed: result.tokensUsed,
        budget: result.budget,
        injected: shouldInject,
        dropped: result.dropped.length,
        selected: result.selected.map(node => ({
          nodeId: node.nodeId,
          kind: node.kind,
          weight: node.weight,
          tokens: node.tokens,
          compressed: node.compressed,
          text: node.text,
        })),
      }
    },
  }

  const queryTool: ToolDefinitionLike = {
    name: 'tree_query',
    description: `${COMMON} `
      + 'Use this to inspect the tree: the current node, its children with their edge costs, the parent chain with cumulative cost, '
      + 'and structural counters. Pass `format: "branches"` to compare sibling branches.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nodeId: { type: 'string', description: 'Node to describe; defaults to the current node.' },
        format: { type: 'string', enum: ['node', 'branches', 'stats'], description: 'What to return; defaults to "node".' },
        verbose: { type: 'boolean', description: 'Return full node text instead of a truncated preview.' },
      },
    },
    output: {
      schema: objectSchema({
        sessionId: { type: 'string' },
        currentId: { type: 'string' },
        stats: {
          type: 'object',
          additionalProperties: false,
          required: ['nodes', 'edges', 'maxDepth', 'averageCost', 'totalTokens', 'rootPathCost', 'currentId'],
          properties: {
            nodes: { type: 'integer' },
            edges: { type: 'integer' },
            maxDepth: { type: 'integer' },
            averageCost: { type: 'number' },
            totalTokens: { type: 'integer' },
            rootPathCost: { type: 'number' },
            currentId: { type: 'string' },
          },
        },
        node: {
          type: 'object',
          additionalProperties: true,
          properties: {},
        },
        branches: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['nodeId', 'value', 'size', 'failures', 'pinned', 'edgeCost'],
            properties: {
              nodeId: { type: 'string' },
              value: { type: 'number' },
              size: { type: 'integer' },
              failures: { type: 'integer' },
              pinned: { type: 'boolean' },
              edgeCost: { type: 'number' },
            },
          },
        },
      }, ['sessionId', 'currentId', 'stats', 'node']),
      render: (_args, value) => {
        const record = value as {
          currentId: string
          stats: { nodes: number; edges: number; maxDepth: number; averageCost: number; totalTokens: number; rootPathCost: number }
          node: { nodeId: string; kind: string; content: string; children: { nodeId: string; kind: string; edgeCost: number; size: number }[]; pathToRoot: { nodeId: string; cumulative: number }[] }
          branches?: { nodeId: string; value: number; size: number; failures: number; pinned: boolean }[]
        }
        const head = `Tree: ${record.stats.nodes} nodes, ${record.stats.edges} edges, depth ${record.stats.maxDepth}, `
          + `mean edge cost ${record.stats.averageCost.toFixed(3)}, ${record.stats.totalTokens} tokens. Current node ${record.currentId}.`
        const node = `Node ${record.node.nodeId} (${record.node.kind}): ${record.node.content}`
        const children = record.node.children.length === 0
          ? 'No children.'
          : `Children: ${record.node.children.map(child => `${child.nodeId}(${child.kind}, cost ${child.edgeCost}, ${child.size} nodes)`).join(', ')}.`
        const path = record.node.pathToRoot.length === 0
          ? 'At the root.'
          : `Path to root: ${record.node.pathToRoot.map(step => `${step.nodeId}@${step.cumulative}`).join(' <- ')}.`
        const branches = record.branches === undefined
          ? ''
          : `\nBranches: ${record.branches.map(branch => `${branch.nodeId} value ${branch.value} (${branch.size} nodes, ${branch.failures} failures${branch.pinned ? ', pinned' : ''})`).join('; ')}.`
        return textBlock(`${head}\n${node}\n${children}\n${path}${branches}`)
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const record = args as Record<string, unknown>
      const nodeId = optionalString(record, 'nodeId')
      const described = service.query(agent.session.id, {
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(optionalBoolean(record, 'verbose') === true ? { verbose: true } : {}),
      })
      const format = optionalString(record, 'format') ?? 'node'
      if (format !== 'branches') {
        return {
          sessionId: described.sessionId,
          currentId: described.currentId,
          stats: described.stats,
          node: described.node,
        }
      }
      const state = service.requireState(agent.session.id)
      const parentId: NodeId = described.node.parentId ?? described.node.nodeId
      const branches = state.tree.node(parentId).children.map(child => scoreBranch(state.tree, parentId, child))
      return {
        sessionId: described.sessionId,
        currentId: described.currentId,
        stats: described.stats,
        node: described.node,
        branches,
      }
    },
  }

  const reflectTool: ToolDefinitionLike = {
    name: 'tree_reflect',
    description: `${COMMON} `
      + 'Use this to record a short reflection after a wrong turn, a failed tool, or a corrected misunderstanding, or to record the '
      + 'current goal. `raiseCost: true` also makes the branch you are on more expensive to recall.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['note'],
      properties: {
        note: { type: 'string', description: 'The reflection: what went wrong or what you learned, in one or two sentences.' },
        kind: { type: 'string', enum: ['reflection', 'goal'], description: 'Node kind; defaults to "reflection".' },
        nodeId: { type: 'string', description: 'Attach the note under this node instead of the current one.' },
        raiseCost: { type: 'boolean', description: 'Increase the cost of the edge into the new node.' },
      },
    },
    output: {
      schema: objectSchema({
        nodeId: { type: 'string' },
        kind: { type: 'string' },
        edgeCost: { type: 'number' },
      }, ['nodeId', 'kind']),
      render: (_args, value) => {
        const record = value as { nodeId: string; kind: string; edgeCost?: number }
        return textBlock(`Recorded ${record.kind} ${record.nodeId}${record.edgeCost === undefined ? '' : ` (edge cost now ${record.edgeCost})`}.`)
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const record = args as Record<string, unknown>
      const note = requireString(record, 'note')
      const kind = optionalString(record, 'kind') === 'goal' ? 'goal' : 'reflection'
      const nodeId = optionalString(record, 'nodeId')
      const created = service.reflect(agent.session.id, note, {
        kind,
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(optionalBoolean(record, 'raiseCost') === true ? { raiseCost: true } : {}),
      })
      return { nodeId: created.nodeId, kind, ...(created.edgeCost === undefined ? {} : { edgeCost: created.edgeCost }) }
    },
  }

  const backtrackTool: ToolDefinitionLike = {
    name: 'tree_backtrack',
    description: `${COMMON} `
      + 'Use this when the current branch is failing: it climbs from the current node to the nearest fork, scores the other branches, '
      + 'moves you to the best one, and records why. Pass `dryRun: true` to see the candidates without moving.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fromNodeId: { type: 'string', description: 'Branch that failed; defaults to the current node.' },
        dryRun: { type: 'boolean', description: 'Only report the plan.' },
      },
    },
    output: {
      schema: objectSchema({
        applied: { type: 'boolean' },
        currentId: { type: 'string' },
        targetId: { type: 'string' },
        viaParentId: { type: 'string' },
        reason: { type: 'string' },
        escalated: { type: 'integer' },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['nodeId', 'value', 'size', 'failures', 'pinned', 'edgeCost'],
            properties: {
              nodeId: { type: 'string' },
              value: { type: 'number' },
              size: { type: 'integer' },
              failures: { type: 'integer' },
              pinned: { type: 'boolean' },
              edgeCost: { type: 'number' },
            },
          },
        },
      }, ['applied', 'currentId', 'candidates']),
      render: (_args, value) => {
        const record = value as { applied: boolean; currentId: string; targetId?: string; reason?: string; candidates: { nodeId: string; value: number }[] }
        if (record.targetId === undefined) return textBlock('No alternative branch scored high enough; the tree has nowhere better to go.')
        const list = record.candidates.map(candidate => `${candidate.nodeId}=${candidate.value}`).join(', ')
        return textBlock(`${record.applied ? 'Moved' : 'Would move'} to ${record.targetId}: ${record.reason ?? ''}\nCandidates: ${list || 'none'}. Current ${record.currentId}.`)
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const record = args as Record<string, unknown>
      const fromNodeId = optionalString(record, 'fromNodeId')
      const outcome = service.backtrack(agent.session.id, {
        ...(fromNodeId === undefined ? {} : { fromNodeId }),
        ...(optionalBoolean(record, 'dryRun') === true ? { dryRun: true } : {}),
      })
      const plan = outcome.plan
      return {
        applied: outcome.applied,
        currentId: outcome.currentId,
        candidates: outcome.candidates,
        ...(plan === null ? {} : {
          targetId: plan.targetId,
          viaParentId: plan.viaParentId,
          reason: plan.reason,
          escalated: plan.escalated,
        }),
      }
    },
  }

  const markTool: ToolDefinitionLike = {
    name: 'tree_mark',
    description: `${COMMON} `
      + 'Use this for an explicit learner instruction: pin a branch so recall prefers it, or ignore one so recall drops it. '
      + 'Marking changes the cost of the edge into the node and is reversible.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string', description: 'Node to mark.' },
        pinned: { type: 'boolean', description: 'Pin (true) or unpin (false) the node.' },
        ignored: { type: 'boolean', description: 'Ignore (true) or restore (false) the node.' },
      },
    },
    output: {
      schema: objectSchema({
        nodeId: { type: 'string' },
        pinned: { type: 'boolean' },
        ignored: { type: 'boolean' },
        edgeCost: { type: 'number' },
      }, ['nodeId']),
      render: (_args, value) => {
        const record = value as { nodeId: string; pinned: boolean; ignored: boolean; edgeCost?: number }
        const marks = [record.pinned ? 'pinned' : '', record.ignored ? 'ignored' : ''].filter(part => part.length > 0)
        return textBlock(`Node ${record.nodeId}: ${marks.length === 0 ? 'unmarked' : marks.join(', ')}`
          + `${record.edgeCost === undefined ? '' : `, edge cost ${record.edgeCost}`}.`)
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const record = args as Record<string, unknown>
      const nodeId = requireString(record, 'nodeId')
      const pinned = optionalBoolean(record, 'pinned')
      const ignored = optionalBoolean(record, 'ignored')
      if (pinned === undefined && ignored === undefined) {
        throw new Error('dsh-token-tree: pass "pinned" and/or "ignored"')
      }
      const marked = service.mark(agent.session.id, nodeId, {
        ...(pinned === undefined ? {} : { pinned }),
        ...(ignored === undefined ? {} : { ignored }),
      })
      return {
        nodeId,
        pinned: marked.metadata.pinned === true,
        ignored: marked.metadata.ignored === true,
        ...(marked.edgeCost === undefined ? {} : { edgeCost: marked.edgeCost }),
      }
    },
  }

  const focusTool: ToolDefinitionLike = {
    name: 'tree_focus',
    description: `${COMMON} `
      + 'Use this when the learner names a node to continue from: the next user question is attached under that node '
      + 'instead of wherever auto-attachment would put it. The anchor applies to exactly one turn.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string', description: 'Node the next question should hang under; pass "clear" to drop the anchor.' },
      },
    },
    output: {
      schema: objectSchema({
        nodeId: { type: 'string' },
        kind: { type: 'string' },
        preview: { type: 'string' },
        children: { type: 'number' },
        cleared: { type: 'boolean' },
      }, []),
      render: (_args, value) => {
        const record = value as { nodeId?: string; kind?: string; preview?: string; children?: number; cleared?: boolean }
        if (record.cleared === true) return textBlock('Manual anchor cleared; the next turn attaches automatically again.')
        return textBlock(`Next question will hang under ${record.nodeId} (${record.kind}, ${record.children ?? 0} child(ren)): `
          + `${record.preview ?? ''}`)
      },
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const record = args as Record<string, unknown>
      const nodeId = requireString(record, 'nodeId')
      if (nodeId === 'clear') {
        service.unfocus(agent.session.id)
        return { cleared: true, nodeId: 'clear' }
      }
      const anchored = service.focus(agent.session.id, nodeId)
      return { ...anchored, cleared: false }
    },
  }

  return [retrieveTool, queryTool, reflectTool, backtrackTool, markTool, focusTool]
}
