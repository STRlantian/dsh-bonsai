/**
 * Pick the tokenizer that matches the model in use.
 *
 * DSH is not DeepSeek-only: a profile can point at any provider, and every model family
 * ships its own vocabulary. Shipping "all tokenizers" is not an option, so the rule is:
 * look for whatever is installed, match it to the model by name or by generation, and say
 * clearly when nothing matches — in that case the plugin falls back to its own estimate
 * plus the learned ratio, which is why the drift alarm exists.
 *
 * Accepted layouts under the tokenizer directory:
 *
 *   deepseek_v4_tokenizer/tokenizer.json   → generation 4 (name `deepseek-v4`)
 *   qwen2.5/tokenizer.json                 → named entry, matched by model id
 *   tokenizer.json                         → a single default tokenizer
 *
 * @module dsh-token-tree/plugin/tokenizer-select
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** One tokenizer found on disk. */
export interface TokenizerEntry {
  /** Directory name, or `default` for a tokenizer sitting directly in the root. */
  name: string
  /** Generation number parsed from the name, when it looks like `deepseek_v<N>`. */
  version?: number
  /** Absolute path to `tokenizer.json`. */
  path: string
}

/** What was chosen, and why. */
export interface TokenizerChoice {
  /** Absolute path to `tokenizer.json`. */
  path: string
  /** Name of the chosen entry. */
  name: string
  /** Generation number, `0` when the entry is not version-shaped. */
  version: number
  /** Every entry found, for the settings panel. */
  available: string[]
  /** One line explaining the decision, for the log and the settings panel. */
  reason: string
}

/**
 * Where per-model tokenizers live by default.
 * @returns `$DSH_HOME/token-tree`, matching the edit log and settings locations.
 */
export function defaultTokenizerDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'token-tree')
}

/**
 * Normalise a name for comparison: lowercase, letters and digits only.
 * @param value - raw name.
 * @returns Comparable form.
 */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Read the generation out of a name.
 *
 * Accepts `4`, `v4`, `deepseek-v4`, and the `r1` spelling, which is the generation after
 * v2 and before v3 — the same vocabulary family as v3.
 * @param requested - version string from configuration.
 * @returns The generation, or `undefined` when nothing can be parsed.
 */
export function parseGeneration(requested: string): number | undefined {
  const trimmed = requested.trim().toLowerCase()
  if (trimmed === '' || trimmed === 'auto') return undefined
  const direct = /^(?:v)?(\d+)$/.exec(trimmed)
  if (direct !== null) return Number(direct[1])
  if (/\br1\b/.test(trimmed)) return 3
  const fromModel = /v(\d+)(?![0-9])/.exec(trimmed)
  if (fromModel !== null) return Number(fromModel[1])
  return undefined
}

/**
 * List every tokenizer installed in a directory.
 * @param dir - tokenizer root.
 * @returns Entries, version-shaped ones first by generation, then the rest by name.
 */
export function discoverTokenizers(dir: string): TokenizerEntry[] {
  if (!existsSync(dir)) return []
  const entries: TokenizerEntry[] = []
  const rootFile = join(dir, 'tokenizer.json')
  if (existsSync(rootFile)) entries.push({ name: 'default', path: rootFile })
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name, 'tokenizer.json')
    if (!existsSync(path)) continue
    const shaped = /^deepseek[_-]v(\d+)[_-]tokenizer$/i.exec(entry.name)
    entries.push({
      name: entry.name,
      path,
      ...(shaped === null ? {} : { version: Number(shaped[1]) }),
    })
  }
  const versioned = entries.filter(entry => entry.version !== undefined).sort((left, right) => (left.version ?? 0) - (right.version ?? 0))
  const named = entries.filter(entry => entry.version === undefined).sort((left, right) => left.name.localeCompare(right.name))
  return [...versioned, ...named]
}

/**
 * Backwards-compatible view: only the generation-numbered entries.
 * @param dir - tokenizer root.
 * @returns Ascending `{ version, path }` pairs.
 */
export function discoverGenerations(dir: string): { version: number; path: string }[] {
  return discoverTokenizers(dir)
    .filter(entry => entry.version !== undefined)
    .map(entry => ({ version: entry.version as number, path: entry.path }))
}

/**
 * Choose a tokenizer.
 *
 * Order: explicit file → `off` → model id (by name, then by generation) → requested
 * generation → requested name → `auto` (newest generation, else first entry). A fallback
 * is always reported in `reason`, because silently using the wrong vocabulary is exactly
 * the failure this is meant to make visible.
 * @param options - explicit path, directory, requested version, and the model id.
 * @returns The choice, or `undefined` when nothing usable is installed.
 */
export function resolveTokenizer(options: {
  explicitPath?: string
  dir?: string
  requested: string
  modelId?: string
}): TokenizerChoice | undefined {
  const requested = options.requested.trim().toLowerCase()
  if (requested === 'off') return undefined
  if (options.explicitPath !== undefined && options.explicitPath !== '') {
    if (!existsSync(options.explicitPath)) return undefined
    return { path: options.explicitPath, name: 'explicit', version: 0, available: [], reason: 'explicit tokenizerPath' }
  }
  const dir = options.dir
  if (dir === undefined || dir === '') return undefined
  const entries = discoverTokenizers(dir)
  if (entries.length === 0) return undefined
  const available = entries.map(entry => (entry.version === undefined ? entry.name : `${entry.name} (v${entry.version})`))
  const byName = (candidate: string | undefined): TokenizerEntry | undefined => {
    if (candidate === undefined || candidate === '') return undefined
    const wanted = normalise(candidate)
    if (wanted === '') return undefined
    return entries.find(entry => normalise(entry.name) === wanted)
      ?? entries.find(entry => normalise(entry.name).includes(wanted) || wanted.includes(normalise(entry.name)))
  }
  const byVersion = (version: number | undefined): TokenizerEntry | undefined =>
    version === undefined ? undefined : entries.find(entry => entry.version === version)
  const newest = (): TokenizerEntry => {
    const versioned = entries.filter(entry => entry.version !== undefined)
    if (versioned.length > 0) return versioned[versioned.length - 1]
    return entries[0]
  }
  const build = (entry: TokenizerEntry, reason: string): TokenizerChoice => ({
    path: entry.path,
    name: entry.name,
    version: entry.version ?? 0,
    available,
    reason,
  })

  // 1. The model id, when the profile knows it.
  if (options.modelId !== undefined && options.modelId !== '') {
    const named = byName(options.modelId)
    if (named !== undefined) return build(named, `matched model id "${options.modelId}"`)
    const versioned = byVersion(parseGeneration(options.modelId))
    if (versioned !== undefined) return build(versioned, `matched generation from model id "${options.modelId}"`)
  }

  // 2. An explicitly requested generation or name.
  const version = parseGeneration(requested)
  if (version !== undefined) {
    const exact = byVersion(version)
    if (exact !== undefined) return build(exact, `matched generation v${version}`)
  }
  const named = byName(requested)
  if (named !== undefined) return build(named, `matched name "${requested}"`)

  // 3. Whatever is best available, with the miss spelled out.
  const fallback = newest()
  return build(
    fallback,
    requested === 'auto'
      ? 'auto: newest generation on disk'
      : `requested "${options.requested}" is not installed; fell back to ${fallback.name}`,
  )
}
