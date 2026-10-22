/**
 * The session-scoped memory service.
 *
 * One `TokenTreeService` instance holds one tree per session. It is the only
 * component that reads the durable session log, so the plugin has a single place
 * where a conversation event becomes a node, an edge-cost change, or an
 * observation. Tools and hooks call into it; they never touch a tree directly.
 *
 * Everything the service derives is rebuildable from the log: nodes come from
 * `user/message`, `assistant/message`, and `tool/result`; edge costs come from
 * the tool outcomes those events carry; observations are a per-turn sliding view
 * of the same facts. Nothing is appended to the session log, so an unknown event
 * type can never make a stored session unreadable.
 *
 * @module dsh-token-tree/plugin/service
 */

import type { MemoryNode, NodeId, NodeKind } from '../core/types.ts'
import { MemoryTree } from '../core/graph.ts'
import { estimateTokens, leadingSentences } from '../core/tokens.ts'
import { loadTokenizerFile } from '../core/tokenizer.ts'
import { TokenRatio } from '../core/ratio.ts'
import { BillingFit, classCounts } from '../core/billing.ts'
import { resolveTokenizer, defaultTokenizerDir, discoverTokenizers } from './tokenizer-select.ts'
import type { Tokenize } from '../core/tokenizer.ts'
import { contentFeatures, cosine, embedText } from '../core/embedding.ts'
import type { RetrieveOptions, RetrieveResult } from '../core/retrieve.ts'
import { renderContextBlock, retrieveContext } from '../core/retrieve.ts'
import type { BacktrackPlan, BranchScore, Evaluation, Observation } from '../core/reflect.ts'
import { chooseBacktrack, describeBacktrack, describeFailure, evaluateProgress } from '../core/reflect.ts'
import type { ResolvedConfig } from './config.ts'
import type { AgentLike, LoggerLike, SessionEventLike, SessionLike } from './dsh.ts'
import type { EditOp, EditStore } from './store.ts'
import type { SettingsStore } from './settings.ts'
import { asMessage, buildInjectedMessage, isInjected, supervisorMessage, textOfContent } from './messages.ts'
import type { Classification, Constraint } from './requirements.ts'
import { activeConstraints, applyConstraint, classifyTurn } from './requirements.ts'

/**
 * Content features a node needs before it can close a topic.
 *
 * A topic ends at a real explanation; a one-line "let me search" is a step inside
 * the current turn, so a follow-up after it keeps chaining instead of opening a
 * new top-level branch.
 */
const NEW_TOPIC_MIN_FEATURES = 8

/** Precomputed statistics for one attachment decision. */
interface AttachmentContext {
  /** Embedding of the incoming question. */
  embedding: number[]
  /** Content features of the incoming question. */
  questionFeatures: Set<string>
  /** Content features of every node in the tree, computed once per decision. */
  nodeFeatures: Map<NodeId, Set<string>>
  /** Inverse document frequency of each question feature. */
  idf: Map<string, number>
  /** Largest IDF among the question's features, used for normalization. */
  maxIdf: number
}

/** Mutable per-session bookkeeping. */
export interface SessionState {
  /** Session identity. */
  readonly sessionId: string
  /** The memory tree. */
  readonly tree: MemoryTree
  /** Instructions that apply to everything after them, oldest first. */
  constraints: Constraint[]
  /**
   * The next assistant message is the acknowledgment of a constraint turn
   * ("收到，之后…"): it belongs to the instruction, not to the dialogue, so it must
   * not become a tree node either.
   */
  skipNextAnswer: boolean
  /** Whether this session's earlier log has already been replayed into the tree. */
  backfilled: boolean
  /** Highest event sequence already folded, so a replay cannot double-apply. */
  lastSeq: number
  /** Observations of the current turn, oldest first. */
  observations: Observation[]
  /** Tool names by call id, filled on `tool/call`. */
  readonly callNames: Map<string, string>
  /** Argument renderings by call id, used to detect an identical retry. */
  readonly callArgs: Map<string, string>
  /** Measured token count per message id, so a turn only pays for new messages. */
  readonly tokenCounts: Map<string, number>
  /** Tokens of the last measured prompt, until the provider reports its own number. */
  promptTokens?: number
  /** Last billed prompt size, for the increment-based drift check. */
  lastBilled?: number
  /** Last counted prompt size, kept alongside lastBilled. */
  lastCounted?: number
  /** Last hint decision, for /api/token-tree/settings and support. */
  lastHint?: { counted: number | undefined; above: number; fast: number; fired: boolean; reason: string }
  /** Shape of the last `decision.messages` we were given, for diagnosing the hook. */
  probe?: { count: number; chars: number; kinds: string[] }
  /** Character classes of the last prompt handed to the provider, for billing calibration. */
  pendingStats?: { wide: number; narrow: number }
  /** Current turn number. */
  turn: number
  /** Current step number. */
  step: number
  /** Steps started in the current turn. */
  steps: number
  /** Wall-clock start of the current turn. */
  turnStartedAt: number
  /** Reflections written in the current turn. */
  reflections: number
  /** Backtracks performed in the current turn. */
  backtracks: number
  /**
   * A node the user pinned as the anchor for the next turn: the next question is
   * attached there instead of wherever auto-attachment would put it. Cleared as
   * soon as one question uses it, so it steers exactly one turn.
   */
  manualAnchor?: NodeId
  /**
   * Set once this session has been compacted. Before that, older turns are still in
   * the model's context, so a per-turn retrieval hint would cost tokens for nothing;
   * after it, the hint is the only cue that the tree can bring facts back.
   */
  compacted?: boolean
}

/** Outcome of {@link TokenTreeService.supervise}. */
export interface SupervisionOutcome {
  /** Whether guidance was queued for another step. */
  injected: boolean
  /** Evaluation verdict, when one was reached. */
  verdict?: Evaluation['verdict']
  /** Causes backing the verdict. */
  reasons: string[]
  /** Backtrack plan applied, when any. */
  plan?: BacktrackPlan
  /** Why nothing happened, when nothing did. */
  skipped?: string
}

/** One node as the `tree_query` tool renders it. */
export interface NodeView {
  /** Node id. */
  nodeId: NodeId
  /** Node kind. */
  kind: NodeKind
  /** Full text. */
  content: string
  /** Compressed text, when the node carries one. */
  summary?: string
  /** Estimated tokens of `content`. */
  tokens: number
  /** Creation time. */
  timestamp: number
  /** Annotations. */
  metadata: Record<string, unknown>
  /** Parent id. */
  parentId: NodeId | null
  /** Children with their edge costs. */
  children: { nodeId: NodeId; kind: NodeKind; edgeCost: number; size: number }[]
  /** Parent chain with cumulative cost from the root. */
  pathToRoot: { nodeId: NodeId; edgeCost: number; cumulative: number }[]
}

/** Options of {@link TokenTreeService.query}. */
export interface QueryOptions {
  /** Node to describe; defaults to the current node. */
  nodeId?: NodeId
  /** Include the full text of the node and its children; defaults to `false`. */
  verbose?: boolean
}

/** Result of {@link TokenTreeService.query}. */
export interface QueryResult {
  /** Session the tree belongs to. */
  sessionId: string
  /** Current node id. */
  currentId: NodeId
  /** Structural counters. */
  stats: ReturnType<MemoryTree['stats']>
  /** The described node. */
  node: NodeView
  /** Incoming edge of the described node. */
  incoming?: { from: NodeId; cost: number; components: Record<string, number>; updates: number; lastReason?: string }
}

/** Read a finite number out of a durable payload. */
function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a string out of a durable payload. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Read a plain object out of a durable payload. */
function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Collapse whitespace and keep a short form for compression. */
function summarize(text: string): string | undefined {
  if (text.length < 240) return undefined
  return leadingSentences(text, 200)
}

/**
 * The one-line reminder appended when injection is off and the context is big enough
 * that older turns may already be gone from it.
 */
const HINT_TEXT = '[token-tree] Older turns may be summarised or trimmed. Before answering anything that '
  + 'depends on earlier details, call retrieve_context (weighted over this conversation\'s tree) '
  + 'to pull them back; do not guess from the summary.'

/**
 * Session-scoped weighted-tree memory.
 */
export class TokenTreeService {
  /** Effective configuration. */
  readonly config: ResolvedConfig
  private readonly logger: LoggerLike
  private readonly states = new Map<string, SessionState>()
  private readonly store: EditStore | undefined
  private readonly settings: SettingsStore | undefined
  private tokenizer: Tokenize | undefined
  private readonly ratio = new TokenRatio()
  /** Fitted from provider usage: the model-agnostic fallback when no tokenizer exists. */
  private readonly billing = new BillingFit()
  private readonly billedRatios: number[] = []
  /** Billed growth of the last measured turn, used to score candidate tokenizers. */
  private lastBilledDelta: number | undefined
  /** Text of the last prompt shape we observed, for re-scoring candidates. */
  private lastPromptSample: string | undefined
  /** Set once a drift retry has run, so it does not loop. */
  private driftRetried = false
  private driftWarned = false
  private tokenizerState: 'unknown' | 'ready' | 'missing' | 'failed' = 'unknown'
  private tokenizerVersion = 0
  private tokenizerAvailable: string[] = []
  private tokenizerName = ''

  /**
   * @param options - resolved configuration, logger, the durable edit log, and the
   *   runtime settings overrides.
   */
  constructor(options: { config: ResolvedConfig; logger: LoggerLike; store?: EditStore; settings?: SettingsStore }) {
    this.config = options.config
    this.logger = options.logger
    this.store = options.store
    this.settings = options.settings
  }

  /**
   * The switches that can be changed while the host runs.
   *
   * The profile's `Config` is the base; the settings file is an override layer on top,
   * so a switch flipped in the UI takes effect on the next turn without a restart.
   * @returns Effective value of each user-facing switch.
   */
  effective(): { autoInject: boolean; retrievalHint: boolean; autoReflect: boolean; hintMinNodes: number; admitRelevance: number; summaryMatch: boolean } {
    const overrides = this.settings?.all() ?? {}
    return {
      autoInject: overrides.autoInject ?? this.config.autoInject,
      retrievalHint: overrides.retrievalHint ?? this.config.retrievalHint,
      autoReflect: overrides.autoReflect ?? this.config.autoReflect,
      hintMinNodes: overrides.hintMinNodes ?? this.config.hintMinNodes,
      admitRelevance: overrides.admitRelevance ?? this.config.weights.admitRelevance,
      summaryMatch: overrides.summaryMatch ?? this.config.weights.summaryMatch,
    }
  }

  /**
   * Change one or more switches and persist them.
   * @param patch - keys to set; `null` clears an override.
   * @returns The effective switches after the change, plus the override set.
   */
  updateSettings(patch: Record<string, unknown>): {
    effective: ReturnType<TokenTreeService['effective']>
    overrides: Record<string, boolean | number | string>
  } {
    const overrides = this.settings === undefined ? {} : this.settings.apply(patch)
    this.logger.info(`token-tree: settings updated ${JSON.stringify(overrides)}`)
    // A different vocabulary invalidates every cached number, so re-resolve it here.
    if (Object.prototype.hasOwnProperty.call(patch, 'tokenizerVersion')) this.reloadTokenizer()
    return { effective: this.effective(), overrides: { ...overrides } }
  }

  /**
   * Tokens along the current conversation path (root → current node).
   *
   * This is the honest "how much conversation is there" number: the harness does not hand
   * the whole prompt to `agent/pre-step`, and the system prompt and tool definitions are a
   * constant that should not tilt the decision.
   * @param sessionId - session identity.
   * @returns Summed node tokens, using measured counts once the tokenizer is loaded.
   */
  conversationTokens(sessionId: string): number {
    const tree = this.stateOf(sessionId).tree
    let total = 0
    let cursor: NodeId | null = tree.currentId
    const seen = new Set<NodeId>()
    while (cursor !== null && !seen.has(cursor) && tree.nodes.has(cursor)) {
      seen.add(cursor)
      const node = tree.nodes.get(cursor)
      if (node === undefined) break
      total += node.tokens
      cursor = node.parentId
    }
    return total
  }

  /** The override file in use, for the settings panel to show. */
  settingsInfo(): {
    path: string | null
    overrides: Record<string, boolean | number | string>
    base: ReturnType<TokenTreeService['effective']> & { hintAboveTokens: number; tokenizerPath: string | null }
    tokenizer: {
      path: string | null
      state: string
      name: string
      version: number
      available: string[]
      requested: string
      choices: { id: string; label: string }[]
    }
    ratio: { wide: number; narrow: number; observations: number }
    billing: { wide: number; narrow: number; overhead: number; observations: number; active: boolean }
    budget: { factor: number; conservative: number }
    locale: string
    lastPrompt: SessionState['probe'] | null
    drift: { samples: number; ratio: number | null }
    lastHint: SessionState['lastHint'] | null
  } {
    return {
      path: this.settings === undefined ? null : this.settings.path,
      overrides: { ...(this.settings?.all() ?? {}) } as Record<string, boolean | number | string>,
      base: {
        autoInject: this.config.autoInject,
        retrievalHint: this.config.retrievalHint,
        autoReflect: this.config.autoReflect,
        hintMinNodes: this.config.hintMinNodes,
        admitRelevance: this.config.weights.admitRelevance,
        summaryMatch: this.config.weights.summaryMatch,
        hintAboveTokens: this.config.hintAboveTokens,
        tokenizerPath: this.config.tokenizerPath ?? null,
      },
      tokenizer: {
        path: this.config.tokenizerPath ?? null,
        state: this.tokenizerState,
        version: this.tokenizerVersion,
        name: this.tokenizerName,
        available: this.tokenizerAvailable,
        requested: this.config.tokenizerVersion,
        // Options for the settings dropdown: whatever is installed, discovered by scanning
        // for `tokenizer.json`, plus the two always-available choices.
        choices: this.tokenizerChoices(),
      },
      ratio: this.ratioInfo(),
      billing: this.billingInfo(),
      budget: { factor: Number(this.safeBudget(1000) / 1000), conservative: this.config.conservativeBudgetRatio },
      // Interface language: `auto` means "let the client follow the system".
      locale: this.settings?.all().locale ?? 'auto',
      lastPrompt: this.lastPromptInfo(),
      drift: this.driftInfo(),
      lastHint: this.lastHintInfo(),
    }
  }

  /** Sessions currently tracked. */
  get sessionIds(): string[] {
    return [...this.states.keys()]
  }

  /**
   * Read a session state, creating it on first use.
   * @param sessionId - session identity.
   * @returns The state.
   */
  stateOf(sessionId: string): SessionState {
    const existing = this.states.get(sessionId)
    if (existing !== undefined) return existing
    const tree = new MemoryTree({
      sessionId,
      params: this.config.weights,
      embeddingDimension: this.config.embeddingDimension,
    })
    const created: SessionState = {
      sessionId,
      tree,
      constraints: [],
      skipNextAnswer: false,
      backfilled: false,
      lastSeq: -1,
      observations: [],
      callNames: new Map(),
      callArgs: new Map(),
      tokenCounts: new Map(),
      turn: 0,
      step: 0,
      steps: 0,
      turnStartedAt: Date.now(),
      reflections: 0,
      backtracks: 0,
    }
    this.states.set(sessionId, created)
    this.logger.debug(`token-tree: opened tree for session ${sessionId}`)
    return created
  }

  /**
   * Read a session state, failing loud when the session was never seen.
   * @param sessionId - session identity.
   * @returns The state.
   */
  requireState(sessionId: string): SessionState {
    const state = this.states.get(sessionId)
    if (state === undefined) {
      throw new Error(`dsh-token-tree: session ${JSON.stringify(sessionId)} has no memory tree yet`)
    }
    return state
  }

  /**
   * Forget one session's tree.
   * @param sessionId - session identity.
   * @returns `true` when a tree was removed.
   */
  forget(sessionId: string): boolean {
    return this.states.delete(sessionId)
  }

  /**
   * Fold one durable session event into the tree.
   *
   * A resumed session does not re-emit its history through `session/event`, so the
   * first event after a restart would otherwise start from an empty tree. The first
   * touch of a session therefore replays the log the session already holds
   * (`snapshotEvents`), which is the same fold — the tree is derived, never stored.
   * @param session - session the event belongs to.
   * @param event - event envelope.
   */
  handleEvent(session: SessionLike, event: SessionEventLike): void {
    const state = this.stateOf(session.id)
    if (!state.backfilled) {
      state.backfilled = true
      const history = session.snapshotEvents?.() ?? []
      if (history.length > 0) {
        for (const entry of history) {
          this.applyEvent(state, entry)
          state.lastSeq = Math.max(state.lastSeq, entry.seq)
        }
        this.logger.info(`token-tree: replayed ${history.length} event(s) for session ${session.id}`)
        // The triggering event is normally the last one in that replay already.
        if (event.seq <= state.lastSeq) return
      }
    }
    this.applyEvent(state, event)
    state.lastSeq = Math.max(state.lastSeq, event.seq)
  }

  /**
   * Replay a session's history without waiting for its next event.
   * @param session - the session to fold, typically from the agent registry.
   */
  backfillFromSession(session: SessionLike): void {
    const state = this.stateOf(session.id)
    if (state.backfilled) return
    state.backfilled = true
    const history = session.snapshotEvents?.() ?? []
    for (const entry of history) {
      this.applyEvent(state, entry)
      state.lastSeq = Math.max(state.lastSeq, entry.seq)
    }
    // A replayed log can reference nodes this instance never created (compaction
    // markers, pruned branches). Re-attach them so no branch is invisible.
    const repaired = state.tree.repair()
    if (repaired.length > 0) {
      this.logger.info(`token-tree: re-attached ${repaired.length} orphaned node(s) in session ${session.id}`)
    }
    // Manual edits have no event of their own: replay them over the rebuilt tree.
    this.applyStoredEdits(state)
    if (history.length > 0) this.logger.info(`token-tree: replayed ${history.length} event(s) for session ${session.id}`)
  }

  /**
   * Replay the durable edit log over a freshly rebuilt tree.
   *
   * Operations are applied in the recorded order and each one is skipped when its
   * node no longer exists — a stale log must never break a session.
   * @param state - session state whose tree was just replayed.
   */
  private applyStoredEdits(state: SessionState): void {
    if (this.store === undefined) return
    const ops = this.store.opsFor(state.sessionId)
    if (ops.length === 0) return
    let applied = 0
    for (const op of ops) {
      if (!state.tree.nodes.has(op.nodeId)) continue
      try {
        if (op.action === 'reparent') {
          if (op.parentId === undefined || !state.tree.nodes.has(op.parentId)) continue
          if (state.tree.node(op.nodeId).parentId === op.parentId) continue
          state.tree.reparent(op.nodeId, op.parentId)
          applied++
        } else if (op.action === 'remove') {
          // Legacy log entries came from the destructive version; replay them as the
          // soft mark so an old log cannot delete nodes outright.
          state.tree.mark(op.nodeId, { deleted: true })
          applied++
        } else {
          state.tree.mark(op.nodeId, {
            ...(op.pinned === undefined ? {} : { pinned: op.pinned }),
            ...(op.ignored === undefined ? {} : { ignored: op.ignored }),
            ...(op.deleted === undefined ? {} : { deleted: op.deleted }),
          })
          applied++
        }
      } catch (error) {
        this.logger.warn(`token-tree: skipped stored ${op.action} on ${op.nodeId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.logger.info(`token-tree: replayed ${applied}/${ops.length} stored edit(s) for session ${state.sessionId}`)
  }

  /** Persist one edit, when a store is configured. */
  private remember(op: EditOp): void {
    this.store?.record(op)
  }

  /**
   * Apply one event envelope to one session state.
   * @param state - session state.
   * @param event - event envelope.
   */
  private applyEvent(state: SessionState, event: SessionEventLike): void {
    const data = objectField(event.data) ?? {}
    const at = numberField(event.time) ?? Date.now()
    switch (event.type) {
      case 'compaction/start':
      case 'compaction/end': {
        // Once history has been summarised, older facts really can be missing from the
        // model's context, so the retrieval hint starts to earn its tokens.
        state.compacted = true
        return
      }
      case 'turn/start': {
        state.turn = numberField(data.turn) ?? state.turn + 1
        state.step = 0
        state.steps = 0
        state.reflections = 0
        state.backtracks = 0
        state.observations = []
        state.turnStartedAt = at
        return
      }
      case 'step/start': {
        state.step = numberField(data.step) ?? state.step
        state.steps++
        return
      }
      case 'user/message': {
        this.ingestUserMessage(state, data, at)
        return
      }
      case 'assistant/message': {
        this.observeBilling(state, data)
        this.ingestAssistantMessage(state, data, at)
        return
      }
      case 'tool/call': {
        const callId = stringField(data.callId)
        const name = stringField(data.name)
        if (callId !== undefined && name !== undefined) {
          state.callNames.set(callId, name)
          state.callArgs.set(callId, stringField(data.arguments) ?? '')
        }
        return
      }
      case 'tool/result': {
        this.ingestToolResult(state, data, at)
        return
      }
      case 'turn/end': {
        state.observations = []
        return
      }
      default:
        return
    }
  }

  /** Turn one learner message into a question node. */
  private ingestUserMessage(state: SessionState, message: Record<string, unknown>, at: number): void {
    if (isInjected(message)) return
    // Only a genuine learner turn opens a question node. The harness itself
    // appends user-role messages for runtime context, skill catalogs, AGENTS.md
    // reminders, subagent notices and job callbacks; indexing those as questions
    // would bury the real dialogue under harness bookkeeping.
    const sourceKind = stringField(objectField(message.source)?.kind)
    if (sourceKind !== 'user') return
    const text = textOfContent(message.content)
    if (text.length === 0) return
    // An instruction ("keep answers under 100 words", "no longer limited") is not
    // a topic: it must not become a tree node, and it replaces whatever constraint
    // it supersedes. The tree keeps only what was asked *about*.
    const classification: Classification = this.config.classifyConstraints
      ? classifyTurn(text)
      : { kind: 'topic', reason: 'disabled', cancels: false }
    if (classification.kind === 'constraint') {
      state.constraints = applyConstraint(state.constraints, text, at, classification)
      // The assistant's acknowledgment belongs to the instruction, not the dialogue.
      state.skipNextAnswer = true
      this.logger.info(
        `token-tree: constraint ${classification.cancels ? 'cancelled' : 'recorded'} (${classification.reason}): `
        + `${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`,
      )
      return
    }
    const summary = summarize(text)
    const embedding = embedText(text, this.config.embeddingDimension)
    const placement = this.pickQuestionParent(state, text, embedding)
    const parentId = placement.parentId
    const attached = placement.manual === true || parentId !== state.tree.currentId
    state.tree.addNode({
      kind: 'question',
      content: text,
      tokens: this.countTokens(text),
      embedding,
      parentId,
      timestamp: at,
      metadata: {
        step: state.step,
        turn: state.turn,
        ...(placement.manual === true
          ? { attached: 'manual', attachScore: 1 }
          : attached
            ? {
              attached: parentId === state.tree.rootId ? 'topic' : 'semantic',
              attachScore: Number(placement.score.toFixed(3)),
            }
            : {}),
      },
      ...(summary === undefined ? {} : { summary }),
    })
    if (placement.manual === true) {
      this.logger.info(`token-tree: question attached to the user-picked anchor ${parentId} (session ${state.sessionId})`)
    } else if (attached) {
      this.logger.info(`token-tree: question attached to ${parentId} instead of the last answer (session ${state.sessionId})`)
    }
    this.prune(state)
  }

  /**
   * Similarity used to decide where a follow-up question belongs.
   *
   * The local embedding is coarse, so most of the signal is lexical — but plain
   * overlap fails on its own: "介绍" matches everything, and a long answer dilutes
   * a short question's terms. So the lexical half is the *rarest shared term*,
   * normalized by the rarest term of the question: sharing "线段树" scores near 1,
   * sharing only "介绍" scores near 0.
   * @param input - question embedding/features plus the tree-wide term statistics.
   * @param node - candidate parent.
   * @returns Score in `[0, 1]`.
   */
  private attachmentScore(input: AttachmentContext, node: MemoryNode): number {
    const semantic = Math.max(0, cosine(input.embedding, node.embedding))
    const features = input.nodeFeatures.get(node.id) ?? contentFeatures(node.content)
    let best = 0
    for (const feature of input.questionFeatures) {
      if (!features.has(feature)) continue
      const weight = input.idf.get(feature) ?? 0
      if (weight > best) best = weight
    }
    const lexical = input.maxIdf === 0 ? 0 : best / input.maxIdf
    return 0.45 * semantic + 0.55 * lexical
  }

  /**
   * Precompute the term statistics one attachment decision needs.
   * @param state - session state.
   * @param text - incoming question.
   * @param embedding - incoming question embedding.
   * @returns Question features plus document frequencies and their normalization.
   */
  private attachmentContext(state: SessionState, text: string, embedding: number[]): AttachmentContext {
    const questionFeatures = contentFeatures(text)
    const nodeFeatures = new Map<NodeId, Set<string>>()
    const documentFrequency = new Map<string, number>()
    let nodeCount = 0
    for (const node of state.tree.nodes.values()) {
      const features = contentFeatures(node.content)
      nodeFeatures.set(node.id, features)
      nodeCount++
      for (const feature of features) {
        if (!questionFeatures.has(feature)) continue
        documentFrequency.set(feature, (documentFrequency.get(feature) ?? 0) + 1)
      }
    }
    const idf = new Map<string, number>()
    let maxIdf = 0
    for (const feature of questionFeatures) {
      const frequency = documentFrequency.get(feature) ?? 0
      const weight = Math.log(1 + (nodeCount + 1) / (1 + frequency))
      idf.set(feature, weight)
      if (weight > maxIdf) maxIdf = weight
    }
    return { embedding, questionFeatures, nodeFeatures, idf, maxIdf }
  }

  /**
   * Choose the parent of a new question.
   *
   * `linear` keeps the conversation a chain. `semantic` looks for the earlier
   * answer or question the new one is really about: the answer that introduced
   * the term being asked about, and it only leaves the default parent when it wins
   * by `attachMargin` and clears `attachThreshold`. That is what turns "keep
   * asking about the nouns inside the last answer" into a real tree instead of one
   * very deep line.
   * @param state - session state.
   * @param text - question text.
   * @param embedding - question embedding.
   * @returns Parent node id.
   */
  private pickQuestionParent(
    state: SessionState,
    text: string,
    embedding: number[],
  ): { parentId: NodeId; score: number; manual?: boolean } {
    const tree = state.tree
    // A user-picked anchor wins over every heuristic, and steers exactly one turn.
    if (state.manualAnchor !== undefined) {
      const anchor = state.manualAnchor
      state.manualAnchor = undefined
      if (tree.nodes.has(anchor)) return { parentId: anchor, score: 1, manual: true }
    }
    const defaultId = tree.currentId
    if (this.config.attachments === 'linear') return { parentId: defaultId, score: 0 }
    const context = this.attachmentContext(state, text, embedding)
    const defaultNode = tree.node(defaultId)
    const defaultScore = this.attachmentScore(context, defaultNode)
    let bestId = defaultId
    let bestScore = defaultScore
    for (const node of tree.nodes.values()) {
      if (node.id === tree.rootId || node.id === defaultId) continue
      // Only explanations can adopt a follow-up: a question does not introduce a
      // term, it asks about one.
      if (node.kind !== 'answer') continue
      const score = this.attachmentScore(context, node)
      if (score > bestScore) {
        bestScore = score
        bestId = node.id
      }
    }
    if (bestId !== defaultId
      && bestScore >= this.config.attachThreshold
      && bestScore >= defaultScore + this.config.attachMargin) {
      return { parentId: bestId, score: bestScore }
    }
    // A turn that has nothing in common with where the dialogue currently stands
    // starts a new top-level branch instead of extending the line. Without this,
    // "introduce segment trees" after "what is complexity" hangs under the
    // complexity answer and the whole session stays one chain by construction.
    // Only a substantive explanation can close a topic: a one-line "let me search"
    // is a step inside the current turn, not the end of a thread.
    const substantive = defaultNode.kind === 'answer' && contentFeatures(defaultNode.content).size >= NEW_TOPIC_MIN_FEATURES
    if (defaultId !== tree.rootId && substantive && defaultScore < this.config.newTopicBelow) {
      this.logger.info(`token-tree: new topic branch under the root (score ${defaultScore.toFixed(3)} below ${this.config.newTopicBelow})`)
      return { parentId: tree.rootId, score: defaultScore }
    }
    return { parentId: defaultId, score: defaultScore }
  }

  /** Turn one assistant message into an answer node. */
  private ingestAssistantMessage(state: SessionState, data: Record<string, unknown>, at: number): void {
    const message = asMessage(data.message) ?? {}
    const text = textOfContent(message.content)
    if (text.length === 0) return
    if (state.skipNextAnswer) {
      state.skipNextAnswer = false
      this.logger.debug(`token-tree: skipped the acknowledgment of a constraint turn (session ${state.sessionId})`)
      return
    }
    const summary = summarize(text)
    state.tree.addNode({
      kind: 'answer',
      content: text,
      tokens: this.countTokens(text),
      timestamp: at,
      metadata: { step: numberField(data.step) ?? state.step, turn: numberField(data.turn) ?? state.turn },
      ...(summary === undefined ? {} : { summary }),
    })
    this.prune(state)
  }

  /** Turn one tool result into a tool node, and reprice the edge into it. */
  private ingestToolResult(state: SessionState, data: Record<string, unknown>, at: number): void {
    const message = asMessage(data.message) ?? {}
    const callId = stringField(message.toolCallId) ?? ''
    const toolName = state.callNames.get(callId) ?? 'tool'
    const failed = message.isError === true
    const text = textOfContent(message.content)
    const errorInfo = objectField(data.error)
    const errorText = failed
      ? stringField(errorInfo?.reason) ?? stringField(errorInfo?.code) ?? (text.length === 0 ? 'no error detail' : text.slice(0, 200))
      : undefined
    const content = text.length === 0 ? `(${toolName} produced no text)` : text
    const summary = summarize(content)
    const node = state.tree.addNode({
      kind: 'tool_result',
      content,
      timestamp: at,
      metadata: {
        toolName,
        toolCallId: callId,
        ok: !failed,
        step: numberField(data.step) ?? state.step,
        turn: numberField(data.turn) ?? state.turn,
        ...(errorText === undefined ? {} : { error: errorText }),
      },
      // A tool result is a leaf of the answer that requested it: the dialogue
      // focus stays on that answer, so the next learner question branches from
      // it instead of hanging off the last tool output, which would turn the
      // whole conversation into one very deep chain.
      setCurrent: false,
      ...(summary === undefined ? {} : { summary }),
    })
    const delta = failed ? this.config.weights.failureDelta : -this.config.weights.successDelta
    const edge = state.tree.adjustIncomingEdge(node.id, delta, failed ? 'tool/failure' : 'tool/success')
    this.logEdge(state, edge, node.id, delta, failed ? 'tool/failure' : 'tool/success')
    state.observations.push({
      step: state.step,
      toolName,
      argsKey: state.callArgs.get(callId) ?? '',
      ok: !failed,
      ...(errorText === undefined ? {} : { error: errorText }),
      at,
    })
    this.prune(state)
  }

  /** Log one edge-cost change so the update is visible in the harness log. */
  private logEdge(
    state: SessionState,
    edge: { from: NodeId; to: NodeId; cost: number; updates: number } | undefined,
    nodeId: NodeId,
    delta: number,
    reason: string,
  ): void {
    if (!this.config.logEdgeUpdates) return
    if (edge === undefined) {
      this.logger.warn(`token-tree: node ${nodeId} has no incoming edge; ${reason} skipped (session ${state.sessionId})`)
      return
    }
    const before = edge.cost - delta
    this.logger.info(
      `token-tree: edge ${edge.from}->${edge.to} cost ${before.toFixed(3)} -> ${edge.cost.toFixed(3)} `
      + `(${reason}, delta ${delta > 0 ? '+' : ''}${delta.toFixed(2)}, updates ${edge.updates}, session ${state.sessionId})`,
    )
  }

  /** Keep a session under the node cap by dropping the oldest inactive branch. */
  private prune(state: SessionState): void {
    const tree = state.tree
    const cap = this.config.maxNodesPerSession
    while (tree.nodes.size > cap) {
      const keep = new Set<NodeId>([tree.currentId, ...tree.ancestors(tree.currentId)])
      const branches = tree.node(tree.rootId).children
        .filter(child => !keep.has(child) && tree.node(child).metadata.pinned !== true)
      if (branches.length === 0) {
        this.logger.warn(`token-tree: session ${state.sessionId} reached ${tree.nodes.size} nodes and nothing is prunable`)
        return
      }
      branches.sort((left, right) => this.branchTimestamp(tree, left) - this.branchTimestamp(tree, right))
      const victim = branches[0]
      const removed = tree.detach(victim)
      this.logger.info(`token-tree: pruned ${removed.length} node(s) from branch ${victim} (session ${state.sessionId})`)
    }
  }

  /** Newest timestamp inside one branch, used to prune the coldest branch first. */
  private branchTimestamp(tree: MemoryTree, branchRoot: NodeId): number {
    let newest = 0
    for (const id of tree.subtree(branchRoot)) newest = Math.max(newest, tree.node(id).timestamp)
    return newest
  }

  /**
   * Read one session's tree, creating an empty one on first use.
   * @param sessionId - session identity.
   * @returns The tree.
   */
  treeOf(sessionId: string): MemoryTree {
    return this.stateOf(sessionId).tree
  }

  /**
   * Run weighted recall for one session.
   * @param sessionId - session identity.
   * @param options - query and retrieval overrides.
   * @returns The recall result.
   */
  retrieve(sessionId: string, options: RetrieveOptions): RetrieveResult {
    const state = this.stateOf(sessionId)
    // Both retrieval switches are adjustable at runtime, so the two modes can be
    // compared without editing the profile.
    const overrides = this.settings?.all() ?? {}
    const admitRelevance = options.admitRelevance ?? overrides.admitRelevance ?? this.config.weights.admitRelevance
    const summaryMatch = options.summaryMatch ?? overrides.summaryMatch ?? this.config.weights.summaryMatch
    return retrieveContext(state.tree, {
      originId: state.tree.currentId,
      admitRelevance,
      summaryMatch,
      ...options,
      // Only the budget is scaled: the caller's own budget is respected, then discounted
      // when the token counts are estimates rather than measurements.
      budgetTokens: this.safeBudget(options.budgetTokens ?? this.config.weights.tokenBudget),
    })
  }

  /**
   * How much of a token budget to actually trust.
   *
   * A budget decision made on estimated counts must not be spent as if it were measured:
   * the estimate can be 40% off in either direction, and overrunning a hard cap is worse
   * than injecting less. So the budget is discounted while the counts are estimates, and
   * discounted further while the drift monitor is unhappy.
   * @param base - requested token budget.
   * @returns The budget to use.
   */
  safeBudget(base: number): number {
    const exact = this.tokenizer !== undefined
      || (this.tokenizerState === 'unknown' && this.tokenizerRequested() !== 'off')
    let factor = exact ? 1 : this.config.conservativeBudgetRatio
    const drift = this.driftInfo()
    if (drift.ratio !== null && (drift.ratio < 0.85 || drift.ratio > 1.2)) factor *= 0.9
    return Math.max(64, Math.round(base * factor))
  }

  /**
   * Build the memory block injected at a step.
   * @param sessionId - session identity.
   * @param query - text to score against.
   * @param budgetTokens - optional budget override.
   * @returns The rendered block, or `undefined` when nothing qualified.
   */
  memoryBlock(sessionId: string, query: string, budgetTokens?: number): string | undefined {
    const result = this.retrieve(sessionId, {
      query,
      budgetTokens: budgetTokens ?? this.config.injectBudgetTokens,
    })
    const constraints = activeConstraints(this.stateOf(sessionId).constraints)
    const preamble = constraints.length === 0
      ? ''
      : `[token-tree constraints] still in force: ${constraints.map(entry => entry.text).join(' | ')}\n`
    if (result.selected.length === 0) return preamble.length === 0 ? undefined : preamble.trimEnd()
    return `${preamble}${renderContextBlock(result)}`
  }

  /**
   * One-line nudge that tells the model where the older history went.
   *
   * Used when automatic injection is off: the block is expensive, but a model that
   * never learns `retrieve_context` exists will not use it. The line is deliberately
   * short and only appears when it can pay for itself: after this session has been
   * compacted (older turns really may be gone), or once the tree is big enough that
   * the window is likely to be under pressure.
   * @param sessionId - session identity.
   * @returns The line, or `undefined` while retrieval cannot matter yet.
   */
  retrievalHint(sessionId: string): string | undefined {
    const state = this.stateOf(sessionId)
    const tree = state.tree
    // A compacted session has already lost history, so no further gate is needed.
    if (state.compacted === true) return HINT_TEXT
    // The measured size of the conversation so far, from node tokens (re-counted from
    // estimates to real numbers when the tokenizer loads). Deliberately not based on
    // `decision.messages`: at `agent/pre-step` those hold only the newest message, so a
    // threshold applied to them never fires — measured on a live host: 394 tokens on
    // turn one while the conversation was already growing.
    const tokenizer = this.loadTokenizer()
    const above = this.aboveTokens()
    if (tokenizer !== undefined) {
      const counted = this.conversationTokens(sessionId)
      state.promptTokens = counted
      const fired = counted >= above
      state.lastHint = { counted, above, fast: counted, fired, reason: fired ? 'conversation over threshold' : 'conversation under threshold' }
      return fired ? HINT_TEXT : undefined
    }
    const fired = tree.nodes.size >= this.effective().hintMinNodes
    state.lastHint = {
      counted: undefined,
      above,
      fast: 0,
      fired,
      reason: fired ? 'no tokenizer: node count over hintMinNodes' : 'no tokenizer: node count under hintMinNodes',
    }
    return fired ? HINT_TEXT : undefined
  }

  /**
   * Feed the learned ratio from the newest messages without counting the whole context.
   *
   * Costs one tokenization of at most a few messages, and only for messages that have no
   * cached count yet, so it stays cheap on every turn after the first.
   * @param sessionId - session identity.
   * @param messages - messages of the pending request.
   */
  private warmRatio(sessionId: string, messages: readonly unknown[]): void {
    const tokenizer = this.loadTokenizer()
    if (tokenizer === undefined) return
    const state = this.stateOf(sessionId)
    const recent = messages.slice(-3)
    for (const message of recent) {
      const text = messageText(message)
      if (text === '') continue
      const id = typeof message === 'object' && message !== null && typeof (message as { id?: unknown }).id === 'string'
        ? (message as { id: string }).id
        : undefined
      if (id !== undefined && state.tokenCounts.has(id)) continue
      const counted = tokenizer.count(text)
      this.ratio.observe(text, counted)
      if (id !== undefined) state.tokenCounts.set(id, counted)
    }
  }

  /**
   * Tokens in the messages the model is about to receive.
   *
   * Per-message counts are cached by id, so a turn only pays for the messages that are
   * new since the last check rather than for the whole conversation.
   * @param sessionId - session identity.
   * @param messages - messages of the pending request.
   * @returns Measured tokens when a tokenizer is loaded, `undefined` otherwise.
   */
  contextTokens(sessionId: string, messages: readonly unknown[]): number | undefined {
    const tokenizer = this.loadTokenizer()
    if (tokenizer === undefined) return undefined
    const state = this.stateOf(sessionId)
    let total = 0
    for (const message of messages) {
      const text = messageText(message)
      if (text === '') continue
      const id = typeof message === 'object' && message !== null && typeof (message as { id?: unknown }).id === 'string'
        ? (message as { id: string }).id
        : undefined
      const cached = id === undefined ? undefined : state.tokenCounts.get(id)
      if (cached !== undefined) {
        total += cached
        continue
      }
      const counted = tokenizer.count(text)
      // Every exact count is also a training sample for the cheap estimator.
      this.ratio.observe(text, counted)
      if (id !== undefined) state.tokenCounts.set(id, counted)
      total += counted
    }
    return total
  }

  /**
   * The tokenizer choice in force: a runtime override wins over the profile config.
   * @returns `auto`, a generation, an installed name, or `off`.
   */
  private tokenizerRequested(): string {
    const override = this.settings?.all().tokenizerVersion
    return override ?? this.config.tokenizerVersion
  }

  /**
   * Re-resolve the tokenizer after the choice changed.
   *
   * Switching generations must drop the cached reader and re-count every node, otherwise
   * the tree keeps numbers from the vocabulary the user just switched away from.
   */
  private reloadTokenizer(): void {
    this.tokenizer = undefined
    this.tokenizerState = 'unknown'
    this.tokenizerVersion = 0
    this.tokenizerAvailable = []
    this.tokenizerName = ''
    if (this.loadTokenizer() !== undefined) this.recountNodeTokens()
  }

  /**
   * Load the tokenizer once, or report that none is configured.
   * @returns The counter, or `undefined` when the file is absent or unusable.
   */
  private loadTokenizer(): Tokenize | undefined {
    if (this.tokenizerState === 'missing' || this.tokenizerState === 'failed') return undefined
    if (this.tokenizer !== undefined) return this.tokenizer
    // The tokenizer is chosen by model generation: an explicit file wins, otherwise the
    // version named in configuration (or the newest generation on disk) is used.
    const choice = resolveTokenizer({
      ...(this.config.tokenizerPath === undefined ? {} : { explicitPath: this.config.tokenizerPath }),
      dir: this.config.tokenizerDir ?? defaultTokenizerDir(),
      ...(this.config.modelId === undefined ? {} : { modelId: this.config.modelId }),
      requested: this.tokenizerRequested(),
    })
    if (choice === undefined) {
      this.tokenizerState = 'missing'
      return undefined
    }
    const path = choice.path
    try {
      this.tokenizer = loadTokenizerFile(path)
      this.tokenizerState = 'ready'
      this.tokenizerVersion = choice.version
      this.tokenizerAvailable = choice.available
      this.tokenizerName = choice.name
      this.logger.info(`token-tree: tokenizer v${choice.version} loaded from ${path} (${choice.reason}; available: ${choice.available.join(', ') || 'n/a'})`)
      // Trees built before the tokenizer was available carry estimates. Re-counting once
      // makes every budget decision from here on use billed-equivalent numbers.
      this.recountNodeTokens()
      return this.tokenizer
    } catch (error) {
      this.tokenizerState = 'failed'
      this.logger.warn(`token-tree: tokenizer unavailable at ${path} (${error instanceof Error ? error.message : String(error)}); falling back to estimates`)
      return undefined
    }
  }

  /**
   * Replace estimated node token counts with measured ones.
   *
   * `node.tokens` is what the retrieval budget and the payload report, so this is the
   * step that makes those numbers honest. It also feeds the learned ratio, which is what
   * lets the cheap path stay useful for the next context.
   */
  private recountNodeTokens(): void {
    const tokenizer = this.tokenizer
    if (tokenizer === undefined) return
    let counted = 0
    for (const state of this.states.values()) {
      for (const node of state.tree.nodes.values()) {
        const tokens = tokenizer.count(node.content)
        if (tokens > 0) node.tokens = tokens
        if (node.summary !== undefined) {
          node.summaryTokens = tokenizer.count(node.summary)
        }
        this.ratio.observe(node.content, tokens)
        counted++
      }
      state.tokenCounts.clear()
    }
    if (counted > 0) {
      const { wide, narrow } = this.ratio.coefficients()
      this.logger.info(`token-tree: re-counted ${counted} node(s) with the real tokenizer (ratio: ${wide.toFixed(3)} tok/wide-char, ${narrow.toFixed(3)} tok/narrow-char)`)
    }
  }

  /**
   * A cheap token estimate that improves as the session is used.
   * @param text - text to estimate.
   * @returns Estimated tokens from the learned two-class ratio.
   */
  estimateTokens(text: string): number {
    return this.ratio.estimate(text)
  }

  /** The last hint decision of the most recently touched session, for support. */
  private lastHintInfo(): SessionState['lastHint'] | null {
    let latest: { at: number; hint: SessionState['lastHint'] } | undefined
    for (const state of this.states.values()) {
      if (state.lastHint === undefined) continue
      if (latest === undefined || state.turnStartedAt >= latest.at) latest = { at: state.turnStartedAt, hint: state.lastHint }
    }
    return latest === undefined ? null : latest.hint
  }

  /**
   * Tokens for one piece of text, measured when a tokenizer is loaded.
   *
   * Every node is sized through here, so `node.tokens` is a billed-equivalent number from
   * the moment the node is created rather than an estimate corrected later.
   * @param text - node content.
   * @returns Measured or estimated tokens.
   */
  private countTokens(text: string): number {
    const tokenizer = this.loadTokenizer()
    if (tokenizer === undefined) {
      // No vocabulary for this model: use what the bills have taught us, and fall back to
      // the character estimate until there is enough signal.
      if (this.billing.observations >= 2) return this.billing.estimate(text)
      return estimateTokens(text)
    }
    const tokens = tokenizer.count(text)
    if (tokens > 0) this.ratio.observe(text, tokens)
    return tokens
  }

  /**
   * Record the character classes of a prompt that is about to be sent.
   *
   * The billed size of the same request arrives later, on `assistant/message`; pairing the
   * two is what calibrates token counting for models with no tokenizer file.
   * @param sessionId - session identity.
   * @param messages - messages of the pending request.
   */
  /**
   * Record what the host handed us at `agent/pre-step`.
   * @param sessionId - session identity.
   * @param messages - the decision's message list.
   */
  notePromptShape(sessionId: string, messages: readonly unknown[]): void {
    const kinds: string[] = []
    let chars = 0
    for (const message of messages) {
      const text = messageText(message)
      chars += text.length
      const record = message as { source?: { kind?: unknown } }
      kinds.push(typeof record.source?.kind === 'string' ? record.source.kind : '?')
    }
    this.stateOf(sessionId).probe = { count: messages.length, chars, kinds }
  }

  notePromptStats(sessionId: string): void {
    // The character classes of the conversation so far, from the tree. Measured on a live
    // host: `decision.messages` at `agent/pre-step` is usually just the newest message — and
    // sometimes empty — so pairing it with the billed prompt would teach the fit almost
    // nothing. The path grows with the prompt, which is the property the regression needs.
    const tree = this.stateOf(sessionId).tree
    let wide = 0
    let narrow = 0
    let cursor: NodeId | null = tree.currentId
    const seen = new Set<NodeId>()
    while (cursor !== null && !seen.has(cursor) && tree.nodes.has(cursor)) {
      seen.add(cursor)
      const node = tree.nodes.get(cursor)
      if (node === undefined) break
      const counts = classCounts(node.content)
      wide += counts.wide
      narrow += counts.narrow
      cursor = node.parentId
    }
    if (wide + narrow === 0) return
    this.stateOf(sessionId).pendingStats = { wide, narrow }
    // A bounded sample of the same text, so a candidate tokenizer can be scored against
    // the billed growth without re-reading the tree.
    if (this.lastPromptSample === undefined || this.lastPromptSample.length < 4_000) {
      this.lastPromptSample = sampleText(tree, sessionId, 4_000)
    }
  }

  /**
   * Options for the tokenizer dropdown.
   *
   * Built from what is actually on disk, so adding a vocabulary later needs no code change:
   * drop `<anything>/tokenizer.json` into the tokenizer directory and it shows up.
   * @returns Options with a stable id and a human label.
   */
  tokenizerChoices(): { id: string; label: string }[] {
    const choices: { id: string; label: string }[] = [
      { id: 'auto', label: '自动（最新一代）' },
    ]
    const dir = this.config.tokenizerDir ?? defaultTokenizerDir()
    for (const entry of discoverTokenizers(dir)) {
      const generation = /^deepseek[_-]v(\d+)[_-]tokenizer$/i.exec(entry.name)
      const label = generation === null ? entry.name : `DeepSeek v${generation[1]}`
      choices.push({ id: entry.version === undefined ? entry.name : String(entry.version), label })
    }
    choices.push({ id: 'off', label: '自主学习（不用词表）' })
    return choices
  }

  /**
   * The billing-calibrated fit, for the settings panel.
   * @returns Coefficients, sample count and whether it is being used.
   */
  billingInfo(): { wide: number; narrow: number; overhead: number; observations: number; active: boolean } {
    const { wide, narrow, overhead } = this.billing.coefficients()
    return {
      wide: Number(wide.toFixed(4)),
      narrow: Number(narrow.toFixed(4)),
      overhead: Math.round(overhead),
      observations: this.billing.observations,
      active: this.tokenizer === undefined && this.billing.identifiable(),
    }
  }

  /** Shape of the last prompt handed to `agent/pre-step`, for diagnostics. */
  private lastPromptInfo(): SessionState['probe'] | null {
    let latest: SessionState['probe'] | undefined
    for (const state of this.states.values()) {
      if (state.probe !== undefined) latest = state.probe
    }
    return latest ?? null
  }

  /** Current learned ratio, for the settings panel and the logs. */
  ratioInfo(): { wide: number; narrow: number; observations: number } {
    const { wide, narrow } = this.ratio.coefficients()
    return { wide, narrow, observations: this.ratio.observations }
  }

  /**
   * The measured-context threshold in force, honouring a runtime override.
   * @returns Token count at which the hint starts appearing.
   */
  private aboveTokens(): number {
    const override = this.settings?.all().hintAboveTokens
    return override ?? this.config.hintAboveTokens
  }

  /**
   * Compare the last counted prompt with what the provider actually billed.
   *
   * The tokenizer file belongs to a model version. When the provider ships a new model
   * with a different vocabulary, counts silently drift — nothing crashes, the numbers
   * just stop matching the invoice. This keeps a short history of
   * `billed / counted` so a drift becomes visible instead of quietly skewing every budget
   * decision.
   * @param state - session whose prompt was just counted.
   * @param data - the `assistant/message` payload, which carries `usage`.
   */
  private observeBilling(state: SessionState, data: Record<string, unknown>): void {
    const usage = objectField(data.usage)
    if (usage === undefined) return
    const billed = (numberField(usage.inputTokens) ?? 0)
      + (numberField(usage.cacheReadTokens) ?? 0)
      + (numberField(usage.cacheWriteTokens) ?? 0)
    if (billed <= 0) return
    // Teach the model-agnostic estimator first: the character classes we saw, against what
    // the provider billed for the same request. This is the only tokenizer a closed-source
    // model will ever have, and it must work even when no exact count exists.
    const stats = state.pendingStats
    state.pendingStats = undefined
    if (stats !== undefined) this.billing.observe(stats.wide, stats.narrow, billed)
    const counted = state.promptTokens
    state.promptTokens = undefined
    if (counted === undefined || counted <= 0) return
    // Compare *increments*, not absolutes: the billed prompt also carries the system
    // prompt, tool definitions and runtime context, none of which we count. What we can
    // compare is how much each side grew since the previous measured turn — that is the
    // tokenizer's own accuracy, which is the thing that drifts with a new model.
    const previousBilled = state.lastBilled
    const previousCounted = state.lastCounted
    state.lastBilled = billed
    state.lastCounted = counted
    if (previousBilled === undefined || previousCounted === undefined) return
    const billedDelta = billed - previousBilled
    const countedDelta = counted - previousCounted
    if (billedDelta < 50 || countedDelta < 50) return
    this.billedRatios.push(billedDelta / countedDelta)
    if (this.billedRatios.length > 20) this.billedRatios.shift()
    if (this.billedRatios.length < 3) return
    const mean = this.billedRatios.reduce((sum, value) => sum + value, 0) / this.billedRatios.length
    this.lastBilledDelta = billedDelta
    if ((mean < 0.85 || mean > 1.2) && this.driftWarned === false) {
      this.driftWarned = true
      this.logger.warn(
        `token-tree: billed growth is ${mean.toFixed(2)}× the local tokenizer's — the tokenizer file may belong to an older model; `
        + 'update `tokenizerPath` to the current `tokenizer.json`',
      )
      this.reselectTokenizer(mean)
    }
  }

  /**
   * Try the other installed tokenizers when the current one stops matching the bill.
   *
   * Scoring is the billed growth of the last measured turn against each candidate's count
   * of the same prompt shape: the right vocabulary reproduces the invoice's increment, the
   * wrong one is off by a factor. Only a candidate that is clearly better wins, and the
   * attempt happens once per process.
   * @param mean - the drifted ratio, for the log line.
   */
  private reselectTokenizer(mean: number): void {
    if (this.driftRetried) return
    this.driftRetried = true
    const sample = this.lastPromptSample
    const expected = this.lastBilledDelta
    if (sample === undefined || expected === undefined || expected < 50) return
    const dir = this.config.tokenizerDir ?? defaultTokenizerDir()
    const candidates = discoverTokenizers(dir).filter(entry => entry.path !== (this.config.tokenizerPath ?? ''))
    if (candidates.length === 0) return
    const score = (tokenizer: Tokenize): number => {
      try {
        const counted = tokenizer.count(sample)
        if (counted <= 0) return Number.POSITIVE_INFINITY
        return Math.abs(counted - expected) / expected
      } catch {
        return Number.POSITIVE_INFINITY
      }
    }
    let best: { name: string; version: number; tokenizer: Tokenize; error: number } | undefined
    for (const entry of candidates) {
      try {
        const tokenizer = loadTokenizerFile(entry.path)
        const error = score(tokenizer)
        if (best === undefined || error < best.error) best = { name: entry.name, version: entry.version ?? 0, tokenizer, error }
      } catch {
        // An unreadable candidate is simply not a candidate.
      }
    }
    if (best === undefined || this.tokenizer === undefined) return
    const currentError = score(this.tokenizer)
    if (!(best.error < currentError * 0.95)) {
      this.logger.info(
        `token-tree: drift ${mean.toFixed(2)}× could not be fixed by another tokenizer (${best.name} scores ${best.error.toFixed(2)} vs ${currentError.toFixed(2)})`,
      )
      return
    }
    this.tokenizer = best.tokenizer
    this.tokenizerName = best.name
    this.tokenizerVersion = best.version
    this.logger.warn(
      `token-tree: switched tokenizer to ${best.name} (error ${best.error.toFixed(2)} vs ${currentError.toFixed(2)}) after billed growth drifted ${mean.toFixed(2)}×`,
    )
    this.recountNodeTokens()
  }

  /**
   * Drift between our tokenizer and the provider's billing.
   * @returns Mean `billed / counted` over the last few turns, plus the sample count.
   */
  driftInfo(): { samples: number; ratio: number | null } {
    if (this.billedRatios.length === 0) return { samples: 0, ratio: null }
    const mean = this.billedRatios.reduce((sum, value) => sum + value, 0) / this.billedRatios.length
    return { samples: this.billedRatios.length, ratio: Number(mean.toFixed(3)) }
  }

  /**
   * Active constraints of one session, newest first.
   * @param sessionId - session identity.
   * @returns Active constraint texts.
   */
  constraintsOf(sessionId: string): Constraint[] {
    return activeConstraints(this.stateOf(sessionId).constraints)
  }

  /**
   * Evaluate the current turn and, when it is failing, reflect and backtrack.
   * @param agent - agent whose turn is stopping.
   * @param turn - turn number from the event payload.
   * @returns What the supervisor did.
   */
  supervise(agent: AgentLike, turn: number): SupervisionOutcome {
    const state = this.stateOf(agent.session.id)
    if (!this.effective().autoReflect) return { injected: false, reasons: [], skipped: 'autoReflect disabled' }
    const evaluation = evaluateProgress({ observations: state.observations, policy: this.config.loop })
    if (evaluation.verdict === 'progress' || evaluation.verdict === 'done') {
      return { injected: false, verdict: evaluation.verdict, reasons: evaluation.reasons, skipped: 'turn is healthy' }
    }
    const now = Date.now()
    if (now - state.turnStartedAt > this.config.loop.timeoutMs) {
      return { injected: false, verdict: evaluation.verdict, reasons: evaluation.reasons, skipped: 'turn budget exhausted' }
    }
    if (state.steps >= this.config.loop.maxSteps) {
      return { injected: false, verdict: evaluation.verdict, reasons: evaluation.reasons, skipped: 'step budget exhausted' }
    }
    if (state.reflections >= this.config.loop.maxReflections) {
      return { injected: false, verdict: evaluation.verdict, reasons: evaluation.reasons, skipped: 'reflection budget exhausted' }
    }

    const tree = state.tree
    const last = state.observations[state.observations.length - 1]
    const reflection = describeFailure({
      toolName: last?.toolName ?? 'unknown',
      ...(last?.error === undefined ? {} : { error: last.error }),
      step: state.step,
      attempt: evaluation.consecutiveFailures,
    })
    tree.addNode({ tokens: this.countTokens(reflection), kind: 'reflection', content: reflection, timestamp: now, setCurrent: false, metadata: { step: state.step, turn } })
    state.reflections++

    let plan: BacktrackPlan | undefined
    let guidance = 'Try a different sub-question, or a different tool, before answering again.'
    if (state.backtracks < this.config.loop.maxBacktracks) {
      const candidate = chooseBacktrack(tree, tree.currentId, this.config.loop)
      if (candidate !== null) {
        plan = candidate
        tree.moveTo(candidate.targetId)
        tree.addNode({
          kind: 'reflection',
          content: describeBacktrack(candidate),
          tokens: this.countTokens(describeBacktrack(candidate)),
          timestamp: now,
          setCurrent: false,
          metadata: { step: state.step, turn, backtracks: state.backtracks + 1 },
        })
        state.backtracks++
        guidance = `Backtracked to ${candidate.targetId}: ${candidate.reason}. Continue there instead of repeating the failed branch.`
      }
    }

    const text = supervisorMessage(evaluation.reasons, guidance)
    agent.inject(buildInjectedMessage(text))
    this.logger.info(
      `token-tree: supervisor ${evaluation.verdict} on session ${state.sessionId} `
      + `(turn ${turn}, reflections ${state.reflections}, backtracks ${state.backtracks}, plan ${plan?.targetId ?? 'none'})`,
    )
    return { injected: true, verdict: evaluation.verdict, reasons: evaluation.reasons, ...(plan === undefined ? {} : { plan }) }
  }

  /**
   * Describe one node and its surroundings.
   * @param sessionId - session identity.
   * @param options - node selection.
   * @returns The description.
   */
  query(sessionId: string, options: QueryOptions = {}): QueryResult {
    const state = this.stateOf(sessionId)
    const tree = state.tree
    const nodeId = options.nodeId ?? tree.currentId
    const node = tree.node(nodeId)
    const pathToRoot: { nodeId: NodeId; edgeCost: number; cumulative: number }[] = []
    let cumulative = 0
    let cursor: NodeId | null = nodeId
    while (cursor !== null) {
      const parentId: NodeId | null = tree.node(cursor).parentId
      if (parentId === null) break
      const edge = tree.edge(parentId, cursor)
      const cost = edge?.cost ?? 0
      cumulative += cost
      pathToRoot.push({ nodeId: cursor, edgeCost: Number(cost.toFixed(4)), cumulative: Number(cumulative.toFixed(4)) })
      cursor = parentId
    }
    const incomingEdge = node.parentId === null ? undefined : tree.edge(node.parentId, nodeId)
    return {
      sessionId,
      currentId: tree.currentId,
      stats: tree.stats(),
      node: {
        nodeId,
        kind: node.kind,
        content: options.verbose === true ? node.content : leadingSentences(node.content, 400),
        ...(node.summary === undefined ? {} : { summary: node.summary }),
        tokens: node.tokens,
        timestamp: node.timestamp,
        metadata: { ...node.metadata },
        parentId: node.parentId,
        children: node.children.map((childId) => {
          const childEdge = tree.edge(nodeId, childId)
          return {
            nodeId: childId,
            kind: tree.node(childId).kind,
            edgeCost: Number((childEdge?.cost ?? 0).toFixed(4)),
            size: tree.subtree(childId).length,
          }
        }),
        pathToRoot,
      },
      ...(incomingEdge === undefined ? {} : {
        incoming: {
          from: incomingEdge.from,
          cost: Number(incomingEdge.cost.toFixed(4)),
          components: {
            semanticJump: Number(incomingEdge.components.semanticJump.toFixed(4)),
            timeGap: Number(incomingEdge.components.timeGap.toFixed(4)),
            branchSwitch: incomingEdge.components.branchSwitch,
            userMark: incomingEdge.components.userMark,
          },
          updates: incomingEdge.updates,
          ...(incomingEdge.lastReason === undefined ? {} : { lastReason: incomingEdge.lastReason }),
        },
      }),
    }
  }

  /**
   * Write a reflection node the model or the user asked for.
   * @param sessionId - session identity.
   * @param note - reflection text.
   * @param options - node kind, target, and whether to raise the edge cost.
   * @returns The created node and the affected edge cost.
   */
  reflect(
    sessionId: string,
    note: string,
    options: { kind?: 'reflection' | 'goal'; nodeId?: NodeId; raiseCost?: boolean } = {},
  ): { nodeId: NodeId; edgeCost?: number } {
    const state = this.stateOf(sessionId)
    const tree = state.tree
    const anchor = options.nodeId ?? tree.currentId
    tree.node(anchor)
    const node = tree.addNode({
      kind: options.kind ?? 'reflection',
      content: note,
      tokens: this.countTokens(note),
      timestamp: Date.now(),
      parentId: anchor,
      setCurrent: false,
      metadata: { manual: true, step: state.step },
    })
    let edgeCost: number | undefined
    if (options.raiseCost === true) {
      const edge = tree.adjustIncomingEdge(node.id, this.config.weights.failureDelta, 'reflect/manual')
      edgeCost = edge?.cost
      this.logEdge(state, edge, node.id, this.config.weights.failureDelta, 'reflect/manual')
    }
    return { nodeId: node.id, ...(edgeCost === undefined ? {} : { edgeCost }) }
  }

  /**
   * Move the agent to the best alternative branch.
   * @param sessionId - session identity.
   * @param options - starting node, and whether to only report the plan.
   * @returns The plan, the applied target, and the scored candidates.
   */
  backtrack(
    sessionId: string,
    options: { fromNodeId?: NodeId; dryRun?: boolean } = {},
  ): { plan: BacktrackPlan | null; candidates: BranchScore[]; applied: boolean; currentId: NodeId } {
    const state = this.stateOf(sessionId)
    const tree = state.tree
    const from = options.fromNodeId ?? tree.currentId
    const plan = chooseBacktrack(tree, from, this.config.loop)
    if (plan !== null && options.dryRun !== true) {
      tree.addNode({
        kind: 'reflection',
        content: describeBacktrack(plan),
        tokens: this.countTokens(describeBacktrack(plan)),
        timestamp: Date.now(),
        setCurrent: false,
        metadata: { step: state.step, manual: true },
      })
      tree.moveTo(plan.targetId)
      state.backtracks++
      this.logger.info(`token-tree: manual backtrack ${from} -> ${plan.targetId} (session ${sessionId})`)
    }
    return {
      plan,
      candidates: plan?.candidates ?? [],
      applied: plan !== null && options.dryRun !== true,
      currentId: tree.currentId,
    }
  }

  /**
   * Apply or clear a user mark on one node.
   * @param sessionId - session identity.
   * @param nodeId - node to mark.
   * @param marks - fields to set.
   * @returns The node state and its incoming edge cost.
   */
  mark(sessionId: string, nodeId: NodeId, marks: { pinned?: boolean; ignored?: boolean }): { metadata: Record<string, unknown>; edgeCost?: number } {
    const state = this.stateOf(sessionId)
    const node = state.tree.mark(nodeId, marks)
    this.remember({
      session: sessionId,
      action: 'mark',
      nodeId,
      ...(marks.pinned === undefined ? {} : { pinned: marks.pinned }),
      ...(marks.ignored === undefined ? {} : { ignored: marks.ignored }),
      at: Date.now(),
    })
    const edge = node.parentId === null ? undefined : state.tree.edge(node.parentId, nodeId)
    return {
      metadata: { ...node.metadata },
      ...(edge === undefined ? {} : { edgeCost: Number(edge.cost.toFixed(4)) }),
    }
  }

  /**
   * Anchor the next turn on a node the user picked.
   *
   * This is the manual half of branching: auto-attachment guesses a parent from
   * topic overlap, and this overrides that guess for exactly one question. The
   * anchor also moves the current pointer so `/tree` and the editor show the same
   * place the next message will grow from.
   * @param sessionId - session identity.
   * @param nodeId - node to continue from.
   * @returns The anchored node and how the next question will attach.
   */
  focus(sessionId: string, nodeId: NodeId): { nodeId: NodeId; kind: string; preview: string; children: number } {
    const state = this.stateOf(sessionId)
    const node = state.tree.node(nodeId)
    state.manualAnchor = nodeId
    state.tree.moveTo(nodeId)
    return {
      nodeId,
      kind: node.kind,
      preview: node.content.slice(0, 120),
      children: node.children.length,
    }
  }

  /**
   * Drop a pending manual anchor, returning to automatic placement.
   * @param sessionId - session identity.
   * @returns Whether an anchor was pending.
   */
  unfocus(sessionId: string): boolean {
    const state = this.stateOf(sessionId)
    const had = state.manualAnchor !== undefined
    state.manualAnchor = undefined
    return had
  }

  /**
   * The node a manual anchor currently points at.
   * @param sessionId - session identity.
   * @returns The node id, when one is pending.
   */
  anchoredNode(sessionId: string): NodeId | undefined {
    return this.stateOf(sessionId).manualAnchor
  }

  /**
   * Move one node (and its subtree) under a different parent.
   * @param sessionId - session identity.
   * @param nodeId - node to move.
   * @param parentId - new parent.
   * @returns The repriced incoming edge.
   */
  reparent(sessionId: string, nodeId: NodeId, parentId: NodeId): { nodeId: NodeId; parentId: NodeId; cost: number } {
    const state = this.stateOf(sessionId)
    const edge = state.tree.reparent(nodeId, parentId)
    this.remember({ session: sessionId, action: 'reparent', nodeId, parentId, at: Date.now() })
    this.logger.info(`token-tree: moved ${nodeId} under ${parentId} (session ${sessionId}, new cost ${edge.cost.toFixed(3)})`)
    return { nodeId, parentId, cost: Number(edge.cost.toFixed(4)) }
  }

  /**
   * Hide one node and its subtree.
   *
   * This is a reversible mark, not a removal: the nodes stay in the tree (and in the
   * edit log) so {@link restore} can bring the branch back, and every read path skips
   * hidden branches. A destructive delete would be the only operation in this plugin
   * that can lose the user's data.
   * @param sessionId - session identity.
   * @param nodeId - subtree root.
   * @returns How many nodes are now hidden.
   */
  remove(sessionId: string, nodeId: NodeId): { removed: number; soft: boolean } {
    const state = this.stateOf(sessionId)
    state.tree.mark(nodeId, { deleted: true })
    this.remember({ session: sessionId, action: 'mark', nodeId, deleted: true, at: Date.now() })
    const hidden = state.tree.subtree(nodeId).filter(id => state.tree.hidden(id)).length
    this.logger.info(`token-tree: hid ${hidden} node(s) at ${nodeId} (session ${sessionId}, reversible)`)
    return { removed: hidden, soft: true }
  }

  /**
   * Bring a hidden branch back.
   * @param sessionId - session identity.
   * @param nodeId - subtree root that was hidden.
   * @returns How many nodes are visible again.
   */
  restore(sessionId: string, nodeId: NodeId): { restored: number } {
    const state = this.stateOf(sessionId)
    state.tree.mark(nodeId, { deleted: false })
    this.remember({ session: sessionId, action: 'mark', nodeId, deleted: false, at: Date.now() })
    const visible = state.tree.subtree(nodeId).filter(id => !state.tree.hidden(id)).length
    this.logger.info(`token-tree: restored ${visible} node(s) at ${nodeId} (session ${sessionId})`)
    return { restored: visible }
  }
}


/**
 * Flatten one message's text blocks for counting.
 * @param message - message of the pending request.
 * @returns The text the model will see, or an empty string.
 */
function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const value = (block as { text?: unknown }).text
      if (typeof value === 'string') text += value
    }
  }
  return text
}
/**
 * A bounded slice of the conversation text, for scoring tokenizer candidates.
 * @param tree - session tree.
 * @param sessionId - session identity.
 * @param limit - maximum characters.
 * @returns Joined text of the nodes on the current path, newest first.
 */
function sampleText(tree: MemoryTree, sessionId: string, limit: number): string {
  const state = tree as unknown as { currentId: NodeId; nodes: Map<NodeId, { content: string; parentId: NodeId | null }> }
  let text = ''
  let cursor: NodeId | null = state.currentId
  const seen = new Set<NodeId>()
  while (cursor !== null && !seen.has(cursor) && text.length < limit) {
    seen.add(cursor)
    const node = state.nodes.get(cursor)
    if (node === undefined) break
    text = node.content + text
    cursor = node.parentId
  }
  void sessionId
  return text.slice(-limit)
}