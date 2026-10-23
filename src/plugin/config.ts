/**
 * Plugin configuration.
 *
 * The harness validates a plugin's `Config` export through the Standard Schema
 * interface (`~standard.validate`), so this module declares that interface
 * directly instead of depending on schemastery. Every field is optional in
 * `cordis.yml` and resolves to a documented default; an unknown key or a value
 * of the wrong type is reported as a validation issue at load time rather than
 * failing silently at first use.
 *
 * @module dsh-token-tree/plugin/config
 */

import type { LoopPolicy, WeightParams } from '../core/types.ts'
import { DEFAULT_LOOP_POLICY, DEFAULT_WEIGHT_PARAMS } from '../core/types.ts'

/** Raw configuration as written in `cordis.yml`. */
export interface Config {
  /** Edge and retrieval parameters; omitted keys keep their default. */
  weights?: Partial<WeightParams>
  /** Loop guard rails; omitted keys keep their default. */
  loop?: Partial<LoopPolicy>
  /** Embedding width used by the local hashed embedding. */
  embeddingDimension?: number
  /** Inject the weighted memory block at the first step of every turn. */
  autoInject?: boolean
  /**
   * When `autoInject` is off, append one short line per turn telling the model that
   * older history may be summarised and that `retrieve_context` is the way back to
   * it. Cheaper than the block, and it is what makes tool-first retrieval work.
   */
  retrievalHint?: boolean
  /**
   * Node count at which the retrieval hint starts appearing even without a compaction.
   * Below it a conversation still fits its own history, and the hint would be paid on
   * every turn for nothing (three measured experiments found no recall gain at that
   * scale). A session that has been compacted gets the hint immediately instead.
   */
  hintMinNodes?: number
  /**
   * Measured-context threshold for the hint, used when `tokenizerPath` is set.
   * The node count above is only a proxy; measured tokens are the quantity that decides
   * whether older history can still be in the model's context.
   */
  hintAboveTokens?: number
  /** Path to a HuggingFace `tokenizer.json`; absent falls back to the character estimate. */
  tokenizerPath?: string
  /**
   * Directory holding per-version tokenizers as `deepseek_v<N>_tokenizer/tokenizer.json`.
   *
   * Each model generation ships its own vocabulary, so the right file has to be picked by
   * version rather than guessed. Ignored when `tokenizerPath` names a file explicitly.
   */
  tokenizerDir?: string
  /**
   * Which tokenizer generation to use: `auto` (highest version present), a number like
   * `4`, or a model id whose version can be parsed (`deepseek-v3`, `deepseek-r1`).
   */
  tokenizerVersion?: string
  /** Model id, matched against installed tokenizer directory names before versions. */
  modelId?: string
  /**
   * Compact automatically once the measured conversation passes this many tokens.
   *
   * `0` disables it. Compaction is the only lever that reduces prompt size instead of
   * growing it, so this is off by default: losing detail is a decision for the user.
   */
  autoCompactAboveTokens?: number
  /**
   * Minimum delay between two automatic compactions, in milliseconds.
   *
   * Compaction is a model call whose input is the entire conversation (measured: 11k–727k
   * tokens, 99% cached), so an eager cooldown pays it repeatedly for little gain.
   */
  autoCompactCooldownMs?: number
  /** Fraction of the token budget to trust when the counts are estimates rather than measurements. */
  conservativeBudgetRatio?: number
  /** Reflect on failures and backtrack automatically at turn boundaries. */
  autoReflect?: boolean
  /** Track sessions that belong to subagents as well as root agents. */
  includeSubagents?: boolean
  /** Token budget of the automatically injected block. */
  injectBudgetTokens?: number
  /** Hard cap of nodes per session; the oldest inactive branch is pruned past it. */
  maxNodesPerSession?: number
  /** Log every edge-cost update at `info` level. */
  logEdgeUpdates?: boolean
  /**
   * Treat instruction turns ("keep answers under 100 words", "no longer limited")
   * as session-wide constraints instead of tree topics.
   */
  classifyConstraints?: boolean
  /**
   * How a new learner question picks its parent. `semantic` attaches it to the
   * earlier answer or question it is most related to (so follow-ups about a term
   * branch from the answer that introduced the term); `linear` always continues
   * from the current node.
   */
  attachments?: 'semantic' | 'linear'
  /** Minimum attachment score required to leave the default parent. */
  attachThreshold?: number
  /** How much better an older node must score than the default parent. */
  attachMargin?: number
  /** Below this score against the default parent, a question starts a new top-level branch. */
  newTopicBelow?: number
}

/** Fully resolved configuration handed to `apply`. */
export interface ResolvedConfig {
  /** Effective edge and retrieval parameters. */
  weights: WeightParams
  /** Effective loop guard rails. */
  loop: LoopPolicy
  /** Embedding width. */
  embeddingDimension: number
  /** Whether to inject automatically. */
  autoInject: boolean
  /** Whether to append the one-line retrieval hint when injection is off. */
  retrievalHint: boolean
  /** Node count at which the hint starts appearing without a compaction. */
  hintMinNodes: number
  /** Measured-context threshold for the hint, when a tokenizer is configured. */
  hintAboveTokens: number
  /** Tokenizer file, or `undefined` to use the character estimate. */
  tokenizerPath?: string
  /** Directory holding per-version tokenizers. */
  tokenizerDir?: string
  /** Requested tokenizer generation: `auto`, a number, or a model id. */
  tokenizerVersion: string
  /** Model id, when the profile knows it: matched against installed tokenizer names. */
  modelId?: string
  /** Budget factor applied while token counts are estimates. */
  conservativeBudgetRatio: number
  /** Conversation size that triggers an automatic compaction; `0` disables it. */
  autoCompactAboveTokens: number
  /** Minimum gap between automatic compactions. */
  autoCompactCooldownMs: number
  /** Whether the first hint after a compaction lists the folded nodes. */
  compactionIndex: boolean
  /** Conversation tokens above which old tool results are folded; `0` disables it. */
  foldAboveTokens: number
  /** Recent turns left unfolded. */
  foldKeepTurns: number
  /** What folding removes: tool output only (`tools`) or whole turns (`turns`). */
  foldScope: string
  /** Whether to supervise failures. */
  autoReflect: boolean
  /** Whether subagent sessions are tracked. */
  includeSubagents: boolean
  /** Token budget of the injected block. */
  injectBudgetTokens: number
  /** Node cap per session. */
  maxNodesPerSession: number
  /** Whether edge updates are logged. */
  logEdgeUpdates: boolean
  /** Whether instruction turns are kept out of the tree. */
  classifyConstraints: boolean
  /** Parent-selection policy for a new question. */
  attachments: 'semantic' | 'linear'
  /** Minimum score to leave the default parent. */
  attachThreshold: number
  /** Required lead over the default parent. */
  attachMargin: number
  /** Below this score against the default parent, a question starts a new top-level branch. */
  newTopicBelow: number
}

/** Numeric weight fields, for validation. */
const WEIGHT_NUMBERS = [
  'wSemantic',
  'wTime',
  'wBranch',
  'wUser',
  'timeScaleMs',
  'timeGapCap',
  'minCost',
  'maxCost',
  'descentPenalty',
  'lambda',
  'alpha',
  'ancestorBoost',
  'pinBoost',
  'threshold',
  'admitRelevance',
  'topK',
  'tokenBudget',
  'compressBelow',
  'compressedTokens',
  'failureDelta',
  'successDelta',
  'ignorePenalty',
] as const satisfies readonly (keyof WeightParams)[]

/** Numeric loop fields, for validation. */
const LOOP_NUMBERS = [
  'maxSteps',
  'maxReflections',
  'maxBacktracks',
  'timeoutMs',
  'failureThreshold',
  'minBranchValue',
  'stallScore',
] as const satisfies readonly (keyof LoopPolicy)[]

/** One Standard Schema issue. */
export interface ConfigIssue {
  /** Human-readable problem. */
  readonly message: string
  /** Path inside the configuration object. */
  readonly path?: readonly (string | number)[]
}

/** Minimal Standard Schema v1 shape, as the Cordis loader reads it. */
export interface StandardSchemaLike<T> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    validate(value: unknown): { value: T; issues?: undefined } | { issues: readonly ConfigIssue[] }
  }
}

/** Report one validation problem. */
function issue(issues: ConfigIssue[], path: string, message: string): void {
  issues.push({ message, path: [path] })
}

/** Read a plain object or report a problem. */
function objectAt(value: unknown, path: string, issues: ConfigIssue[]): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issue(issues, path, 'must be an object')
    return undefined
  }
  return value as Record<string, unknown>
}

/**
 * Apply validated numeric overrides onto a defaults object.
 *
 * `Object.assign` is used instead of `target[key] = value` because the key is a
 * runtime string: the assign overload types the source as a record without
 * requiring the key to exist on the target, which keeps this file free of casts.
 */
function applyNumbers(
  target: object,
  source: Record<string, unknown> | undefined,
  keys: readonly string[],
  path: string,
  issues: ConfigIssue[],
): void {
  if (source === undefined) return
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) {
      issue(issues, `${path}.${key}`, `unknown parameter; known keys: ${keys.join(', ')}`)
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issue(issues, `${path}.${key}`, 'must be a finite number')
      continue
    }
    if (value < 0 && key !== 'minBranchValue') {
      issue(issues, `${path}.${key}`, 'must be non-negative')
      continue
    }
    Object.assign(target, { [key]: value })
  }
}

/** Read one optional scalar with a type check. */
function scalar<T>(
  source: Record<string, unknown>,
  key: string,
  check: (value: unknown) => value is T,
  issues: ConfigIssue[],
  expected: string,
): T | undefined {
  const value = source[key]
  if (value === undefined) return undefined
  if (!check(value)) {
    issue(issues, key, `must be ${expected}`)
    return undefined
  }
  return value
}

/**
 * The plugin's configuration schema.
 *
 * Exported as `Config` so the loader validates `cordis.yml` before `apply` runs;
 * `apply` receives the resolved {@link ResolvedConfig}.
 */
export const Config: StandardSchemaLike<ResolvedConfig> = {
  '~standard': {
    version: 1,
    vendor: 'dsh-token-tree',
    validate(value: unknown): { value: ResolvedConfig; issues?: undefined } | { issues: readonly ConfigIssue[] } {
      const issues: ConfigIssue[] = []
      const source = objectAt(value === undefined ? {} : value, 'config', issues) ?? {}

      const weights: WeightParams = { ...DEFAULT_WEIGHT_PARAMS }
      const weightsSource = objectAt(source.weights, 'weights', issues)
      const numericWeights = weightsSource === undefined ? undefined : { ...weightsSource }
      const combine = numericWeights?.combine
      if (numericWeights !== undefined) delete numericWeights.combine
      applyNumbers(weights, numericWeights, WEIGHT_NUMBERS, 'weights', issues)
      if (weights.threshold < 0 || weights.threshold > 1) issue(issues, 'weights.threshold', 'must be within [0, 1]')
      if (weights.admitRelevance < 0 || weights.admitRelevance > 1) issue(issues, 'weights.admitRelevance', 'must be within [0, 1]')
      if (weights.alpha < 0 || weights.alpha > 1) issue(issues, 'weights.alpha', 'must be within [0, 1]')
      if (weights.minCost > weights.maxCost) issue(issues, 'weights.minCost', 'must not exceed weights.maxCost')
      if (combine !== undefined && combine !== 'linear' && combine !== 'product') {
        issue(issues, 'weights.combine', 'must be "linear" or "product"')
      }
      if (combine === 'linear' || combine === 'product') weights.combine = combine

      const loop: LoopPolicy = { ...DEFAULT_LOOP_POLICY }
      applyNumbers(loop, objectAt(source.loop, 'loop', issues), LOOP_NUMBERS, 'loop', issues)
      for (const key of ['maxSteps', 'maxReflections', 'maxBacktracks', 'failureThreshold'] as const) {
        if (!Number.isInteger(loop[key])) issue(issues, `loop.${key}`, 'must be an integer')
      }

      const embeddingDimension = scalar(source, 'embeddingDimension', (input): input is number => typeof input === 'number' && Number.isInteger(input), issues, 'an integer') ?? 256
      if (embeddingDimension < 8) issue(issues, 'embeddingDimension', 'must be at least 8')

      const injectBudgetTokens = scalar(source, 'injectBudgetTokens', (input): input is number => typeof input === 'number' && Number.isInteger(input), issues, 'an integer')
        ?? 600
      const maxNodesPerSession = scalar(source, 'maxNodesPerSession', (input): input is number => typeof input === 'number' && Number.isInteger(input), issues, 'an integer')
        ?? 400

      const attachmentsRaw = source.attachments
      if (attachmentsRaw !== undefined && attachmentsRaw !== 'semantic' && attachmentsRaw !== 'linear') {
        issue(issues, 'attachments', 'must be "semantic" or "linear"')
      }
      const attachThreshold = scalar(source, 'attachThreshold', (input): input is number => typeof input === 'number' && Number.isFinite(input), issues, 'a finite number') ?? 0.18
      if (attachThreshold < 0 || attachThreshold > 1) issue(issues, 'attachThreshold', 'must be within [0, 1]')
      const attachMargin = scalar(source, 'attachMargin', (input): input is number => typeof input === 'number' && Number.isFinite(input), issues, 'a finite number') ?? 0.08
      if (attachMargin < 0 || attachMargin > 1) issue(issues, 'attachMargin', 'must be within [0, 1]')
      const newTopicBelow = scalar(source, 'newTopicBelow', (input): input is number => typeof input === 'number' && Number.isFinite(input), issues, 'a finite number') ?? 0.08
      if (newTopicBelow < 0 || newTopicBelow > 1) issue(issues, 'newTopicBelow', 'must be within [0, 1]')

      const resolved: ResolvedConfig = {
        weights,
        loop,
        embeddingDimension,
        // Tool-first by default: the block costs ~400+ uncached tokens every turn,
        // and a short conversation already carries its whole history. Callers that
        // want recall pushed automatically can set `autoInject: true`.
        autoInject: scalar(source, 'autoInject', (input): input is boolean => typeof input === 'boolean', issues, 'a boolean') ?? false,
        retrievalHint: scalar(source, 'retrievalHint', (input): input is boolean => typeof input === 'boolean', issues, 'a boolean') ?? true,
        // 40 nodes is roughly 20 exchanges: past this point a long session is the norm
        // and the hint stops being pure overhead.
        hintMinNodes: scalar(source, 'hintMinNodes', (input): input is number => typeof input === 'number' && Number.isInteger(input) && input > 0, issues, 'a positive integer') ?? 40,
        // With a tokenizer, the hint is gated on measured context size instead: below
        // this many tokens the history is still fully present, so the hint buys nothing.
        hintAboveTokens: scalar(source, 'hintAboveTokens', (input): input is number => typeof input === 'number' && Number.isInteger(input) && input > 0, issues, 'a positive integer') ?? 12000,
        // Optional path to a `tokenizer.json`. Absent means "use the character estimate".
        tokenizerPath: typeof source.tokenizerPath === 'string' && source.tokenizerPath.trim() !== ''
          ? source.tokenizerPath.trim()
          : undefined,
        tokenizerDir: typeof source.tokenizerDir === 'string' && source.tokenizerDir.trim() !== ''
          ? source.tokenizerDir.trim()
          : undefined,
        ...(typeof source.modelId === 'string' && source.modelId.trim() !== '' ? { modelId: source.modelId.trim() } : {}),
        conservativeBudgetRatio: scalar(source, 'conservativeBudgetRatio', (input): input is number => typeof input === 'number' && Number.isFinite(input) && input > 0 && input <= 1, issues, 'a number within (0, 1]') ?? 0.85,
        autoCompactAboveTokens: scalar(source, 'autoCompactAboveTokens', (input): input is number => typeof input === 'number' && Number.isInteger(input) && input >= 0, issues, 'a non-negative integer') ?? 0,
        autoCompactCooldownMs: scalar(source, 'autoCompactCooldownMs', (input): input is number => typeof input === 'number' && Number.isInteger(input) && input >= 0, issues, 'a non-negative integer') ?? 600000,
        compactionIndex: scalar(source, 'compactionIndex', (input): input is boolean => typeof input === 'boolean', issues, 'a boolean') ?? true,
        foldAboveTokens: scalar(source, 'foldAboveTokens', (input): input is number => typeof input === 'number' && Number.isInteger(input) && input >= 0, issues, 'a non-negative integer') ?? 40000,
        foldKeepTurns: scalar(source, 'foldKeepTurns', (input): input is number => typeof input === 'number' && Number.isInteger(input) && input >= 0, issues, 'a non-negative integer') ?? 3,
        foldScope: (() => {
          const scope = scalar(source, 'foldScope', (input): input is string => typeof input === 'string', issues, 'a string')
          return scope === 'tools' ? 'tools' : 'turns'
        })(),
        tokenizerVersion: typeof source.tokenizerVersion === 'string' && source.tokenizerVersion.trim() !== ''
          ? source.tokenizerVersion.trim()
          : typeof source.tokenizerVersion === 'number'
            ? String(source.tokenizerVersion)
            : 'auto',
        autoReflect: scalar(source, 'autoReflect', (input): input is boolean => typeof input === 'boolean', issues, 'a boolean') ?? true,
        includeSubagents: scalar(source, 'includeSubagents', (input): input is boolean => typeof input === 'boolean', issues, 'a boolean') ?? false,
        injectBudgetTokens,
        maxNodesPerSession,
        logEdgeUpdates: scalar(source, 'logEdgeUpdates', (input): input is boolean => typeof input === 'boolean', issues, 'a boolean') ?? true,
        classifyConstraints: scalar(source, 'classifyConstraints', (input): input is boolean => typeof input === 'boolean', issues, 'a boolean') ?? true,
        attachments: attachmentsRaw === 'linear' ? 'linear' : 'semantic',
        attachThreshold,
        attachMargin,
        newTopicBelow,
      }
      if (issues.length > 0) return { issues }
      return { value: resolved }
    },
  },
}
