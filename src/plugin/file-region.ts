/**
 * A second corpus: the files this session has actually read.
 *
 * The conversation tree is immutable (a node is its seq), while a file is addressed by path and its
 * content can change at any moment. Keeping them apart means retrieval can promise "this is what the
 * file says now" instead of silently serving a snapshot that has moved on - 86% of the read calls in
 * a long session are re-reads of the same file, so the snapshot is usually the thing being asked
 * about.
 *
 * Only files that were read through the host's file tools are indexed: this is a cache with
 * invalidation, not a second search engine for the workspace.
 */

/** What a hit can return: the whole current text, or just enough to decide to read it. */
export type FileRegionMode = 'off' | 'digest' | 'content' | 'auto'

/** One indexed file. */
export interface IndexedFile {
  /** Absolute path as the tool reported it. */
  path: string
  /** Current text of the file. */
  text: string
  /** Size of the text in tokens. */
  tokens: number
  /** When the text entered the index. */
  at: number
  /** Write time of the file when it was indexed. */
  mtimeMs: number
}

/** A retrieval hit from the file region. */
export interface FileHit {
  path: string
  /** Full text when the budget allowed it, otherwise the digest. */
  text: string
  /** Whether `text` is the whole file. */
  complete: boolean
  tokens: number
  at: number
}

/** Lexical overlap of a query with one file, in [0, 1]; enough to rank a small corpus. */
function overlap(queryTerms: Set<string>, text: string): number {
  if (queryTerms.size === 0) return 0
  const seen = new Set<string>()
  for (const term of text.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
    if (term.length >= 2) seen.add(term)
  }
  let shared = 0
  for (const term of queryTerms) if (seen.has(term)) shared++
  return shared / queryTerms.size
}

/** Terms worth matching: long enough to mean something, and not every-file filler. */
function queryTermsOf(query: string): Set<string> {
  const terms = new Set<string>()
  for (const term of query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
    if (term.length >= 2) terms.add(term)
  }
  return terms
}

/** A stable label: the last two segments, so a hit line stays readable. */
export function shortLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter(part => part.length > 0)
  return parts.slice(-2).join('/')
}

/**
 * The first lines of a file, cut to a token budget.
 * @param text - file text.
 * @param budget - tokens the digest may use.
 * @param countTokens - token counter (the session's real tokenizer when loaded).
 * @returns The digest, with a marker when it was cut.
 */
export function digestOf(text: string, budget: number, countTokens: (text: string) => number): string {
  if (countTokens(text) <= budget) return text
  const lines = text.split('\n')
  let kept: string[] = []
  for (const line of lines) {
    const next = [...kept, line]
    if (countTokens(next.join('\n')) > budget) break
    kept = next
  }
  if (kept.length === 0) return `${lines[0]?.slice(0, 200) ?? ''}\n… (${lines.length} lines total)`
  return `${kept.join('\n')}\n… (${lines.length} lines total)`
}

/**
 * The files a session has read, keyed by path.
 *
 * Deliberately in memory: the text is always re-derivable from disk, so nothing here needs to
 * survive the process. A changed file is detected by mtime before any hit is returned.
 */
export class FileRegion {
  private readonly files = new Map<string, IndexedFile>()

  /**
   * Index a file whose content just entered the context.
   * @param path - absolute path.
   * @param text - the text the model was given.
   * @param at - event time.
   * @param mtimeMs - the file's write time at that moment.
   * @param countTokens - token counter.
   */
  record(path: string, text: string, at: number, mtimeMs: number, countTokens: (text: string) => number): void {
    this.files.set(path, { path, text, tokens: countTokens(text), at, mtimeMs })
  }

  /** Drop a file's text, because the session wrote it and this copy is definitely old. */
  forget(path: string): void {
    this.files.delete(path)
  }

  /** One file by path, when the session has read it. */
  get(path: string): IndexedFile | undefined {
    return this.files.get(path)
  }

  /** Every indexed path, for revalidation. */
  keys(): string[] {
    return [...this.files.keys()]
  }

  /** How many files are indexed. */
  get size(): number {
    return this.files.size
  }

  /**
   * Pick files for a query, newest content first.
   *
   * Files are ranked by lexical overlap only: the corpus is a handful of files a session already
   * read, and a wrong hit is expensive (it invites an answer about the wrong file), so the floor is
   * half the query's terms rather than a similarity number.
   * @param query - the model's question.
   * @param budget - tokens available for file hits.
   * @param mode - how much text a hit may carry.
   * @param countTokens - token counter.
   * @returns Hits, best first, total tokens within the budget.
   */
  lookup(query: string, budget: number, mode: FileRegionMode, countTokens: (text: string) => number): FileHit[] {
    if (mode === 'off' || budget <= 0 || this.files.size === 0) return []
    const terms = queryTermsOf(query)
    const ranked: { file: IndexedFile; score: number }[] = []
    for (const file of this.files.values()) {
      const score = overlap(terms, `${file.path}\n${file.text.slice(0, 4000)}`)
      if (score >= 0.5) ranked.push({ file, score })
    }
    ranked.sort((left, right) => right.score - left.score || right.file.at - left.file.at)
    const hits: FileHit[] = []
    let left = budget
    for (const { file } of ranked) {
      if (left <= 0) break
      const wantsWhole = mode === 'content' || (mode === 'auto' && file.tokens <= left)
      if (wantsWhole) {
        hits.push({ path: file.path, text: file.text, complete: true, tokens: file.tokens, at: file.at })
        left -= file.tokens
      } else {
        const digestBudget = Math.min(left, mode === 'digest' ? Math.max(60, Math.floor(budget / 2)) : Math.max(40, Math.floor(left / 2)))
        if (digestBudget < 20) break
        let digest = digestOf(file.text, digestBudget, countTokens)
        let tokens = countTokens(digest)
        // The "… (N lines total)" marker can push the digest past what is left; trim once to fit.
        if (tokens > left) {
          digest = digestOf(file.text, Math.max(16, left - 8), countTokens)
          tokens = countTokens(digest)
        }
        if (tokens > left) break
        hits.push({ path: file.path, text: digest, complete: digest === file.text, tokens, at: file.at })
        left -= tokens
      }
    }
    return hits
  }
}
