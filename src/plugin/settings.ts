/**
 * Runtime settings for the token tree.
 *
 * The plugin's `Config` is fixed when the profile loads: changing it means editing a
 * YAML file and restarting the host. That is the wrong cost for a switch a user flips
 * while looking at the tree ("stop injecting", "hint me earlier"), so these four knobs
 * also live in a small JSON file that can be edited from the UI and applied on the next
 * turn.
 *
 * The file is an override layer, not a copy of the config: absent keys keep the value
 * the profile declared.
 * @module dsh-token-tree/plugin/settings
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Keys the settings surface may override. */
const SETTING_KEYS = ['autoInject', 'retrievalHint', 'autoReflect', 'hintMinNodes', 'hintAboveTokens', 'tokenizerVersion', 'locale', 'autoCompactAboveTokens', 'compactionIndex', 'toolDeny', 'foldAboveTokens', 'foldKeepTurns', 'foldScope', 'foldPolicy', 'admitRelevance', 'summaryMatch'] as const

export interface SettingsOverrides {
  /** Push a memory block every turn instead of the one-line hint. */
  autoInject?: boolean
  /** Append the one-line retrieval hint when injection is off. */
  retrievalHint?: boolean
  /** Reflect and backtrack at turn boundaries. */
  autoReflect?: boolean
  /** Node count at which the hint starts appearing without a compaction. */
  hintMinNodes?: number
  /** Measured-context threshold (tokens) for the hint, when a tokenizer is loaded. */
  hintAboveTokens?: number
  /** Which tokenizer to use: `auto`, a generation, an installed name, or `off`. */
  tokenizerVersion?: string
  /** Interface language: `auto` follows the system, or `zh` / `en`. */
  locale?: string
  /** Conversation tokens that trigger an automatic compaction; `0` disables it. */
  autoCompactAboveTokens?: number
  /** Whether the first hint after a compaction lists the folded nodes. */
  compactionIndex?: boolean
  /** Tool names to hide from the agent; the schemas are a large part of every prompt. */
  toolDeny?: string[]
  /** Conversation tokens above which old tool results are folded out of the model view; 0 = off. */
  foldAboveTokens?: number
  /** How many recent turns to keep unfolded. */
  foldKeepTurns?: number
  /** What to fold: tool output only, or whole turns. */
  foldScope?: string
  /** When to fold: `threshold` waits for the size gate, `always` folds every finished turn. */
  foldPolicy?: string
  /**
   * Raw-relevance floor for admitting a node into the retrieval buffer (0–1).
   * Ranking still uses the blended score; this only decides who is allowed in.
   */
  admitRelevance?: number
  /** Match against a node's derived topic line as well as its full text. */
  summaryMatch?: boolean
}

/** The subset of the filesystem this module needs, injectable for tests. */
export interface SettingsIo {
  readFile(path: string): string
  writeFile(path: string, text: string): void
  exists(path: string): boolean
  makeDir(path: string): void
}

const diskIo: SettingsIo = {
  readFile: path => readFileSync(path, 'utf8'),
  writeFile: (path, text) => writeFileSync(path, text, 'utf8'),
  exists: path => existsSync(path),
  makeDir: path => { mkdirSync(path, { recursive: true }) },
}

/**
 * Where the settings file lives, honouring `DSH_HOME` the same way the edit log does.
 * @returns Absolute path to `settings.json`.
 */
export function defaultSettingsPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'token-tree', 'settings.json')
}

/**
 * Validate one candidate override.
 * @param key - setting name.
 * @param value - candidate value.
 * @returns The value when it has the right type, otherwise `undefined`.
 */
function coerce(key: keyof SettingsOverrides, value: unknown): boolean | number | string | string[] | undefined {
  if (key === 'foldAboveTokens') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
    return value
  }
  if (key === 'foldScope') {
    if (typeof value !== 'string') return undefined
    const scope = value.trim().toLowerCase()
    return scope === 'tools' || scope === 'turns' ? scope : undefined
  }
  if (key === 'foldPolicy') {
    if (typeof value !== 'string') return undefined
    const policy = value.trim().toLowerCase()
    return policy === 'always' || policy === 'threshold' ? policy : undefined
  }
  if (key === 'foldKeepTurns') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
    return value
  }
  if (key === 'toolDeny') {
    if (!Array.isArray(value)) return undefined
    const names = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim())
    return names.length === 0 ? undefined : [...new Set(names)]
  }
  if (key === 'compactionIndex') {
    if (typeof value !== 'boolean') return undefined
    return value
  }
  if (key === 'autoCompactAboveTokens') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
    return value
  }
  if (key === 'locale') {
    if (typeof value !== 'string') return undefined
    const normalised = value.trim().toLowerCase()
    if (normalised !== 'auto' && normalised !== 'zh' && normalised !== 'en') return undefined
    return normalised
  }
  if (key === 'tokenizerVersion') {
    if (typeof value !== 'string' || value.trim() === '') return undefined
    return value.trim()
  }
  if (key === 'hintAboveTokens') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
    return value
  }
  if (key === 'hintMinNodes') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined
    return value
  }
  if (key === 'summaryMatch') {
    if (typeof value !== 'boolean') return undefined
    return value
  }
  if (key === 'admitRelevance') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return undefined
    return value
  }
  if (typeof value !== 'boolean') return undefined
  return value
}

/**
 * A small persisted set of overrides.
 *
 * Writes are best-effort: a read-only home must not break a session, so a failed save
 * logs and keeps the in-memory value (the switch still works until restart).
 */
export class SettingsStore {
  readonly path: string
  private current: SettingsOverrides
  private readonly io: SettingsIo
  private readonly onError: (message: string) => void

  constructor(options: { path?: string; io?: SettingsIo; onError?: (message: string) => void } = {}) {
    this.path = options.path ?? defaultSettingsPath()
    this.io = options.io ?? diskIo
    this.onError = options.onError ?? (() => {})
    this.current = this.readFile()
  }

  /**
   * Load the file, ignoring a corrupt one rather than failing the plugin load.
   * @returns The overrides found, or `{}`.
   */
  private readFile(): SettingsOverrides {
    try {
      if (!this.io.exists(this.path)) return {}
      const parsed = JSON.parse(this.io.readFile(this.path)) as unknown
      if (parsed === null || typeof parsed !== 'object') return {}
      return this.validate(parsed as Record<string, unknown>)
    } catch (error) {
      this.onError(`token-tree: ignoring unreadable settings (${error instanceof Error ? error.message : String(error)})`)
      return {}
    }
  }

  /**
   * Keep only the keys that are present and well-typed.
   * @param source - parsed JSON object.
   * @returns A clean override set.
   */
  private validate(source: Record<string, unknown>): SettingsOverrides {
    const out: SettingsOverrides = {}
    for (const key of SETTING_KEYS) {
      if (!(key in source)) continue
      const value = coerce(key, source[key])
      if (value !== undefined) (out as Record<string, boolean | number | string | string[]>)[key] = value
    }
    return out
  }

  /** Current overrides. */
  all(): SettingsOverrides {
    return { ...this.current }
  }

  /**
   * Merge a patch into the stored overrides and persist the result.
   *
   * A `null` value clears a key, so the UI can hand control back to the profile config.
   * @param patch - partial update; `null` removes a key.
   * @returns The overrides after the update.
   */
  apply(patch: Record<string, unknown>): SettingsOverrides {
    const next: SettingsOverrides = { ...this.current }
    for (const key of SETTING_KEYS) {
      if (!(key in patch)) continue
      const raw = patch[key]
      if (raw === null) {
        delete next[key]
        continue
      }
      const value = coerce(key, raw)
      if (value !== undefined) (next as Record<string, boolean | number | string | string[]>)[key] = value
    }
    this.current = next
    this.persist()
    return { ...next }
  }

  /** Write the file; failures are reported but never thrown. */
  private persist(): void {
    try {
      this.io.makeDir(dirname(this.path))
      this.io.writeFile(this.path, `${JSON.stringify(this.current, undefined, 2)}\n`)
    } catch (error) {
      this.onError(`token-tree: could not save settings (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}
