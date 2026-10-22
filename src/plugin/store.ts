/**
 * Durable log of manual tree edits.
 *
 * The tree itself is derived: it is replayed from the session event log, which is
 * the harness's own durable record. Anything the user changes by hand — moving a
 * branch, deleting one, pinning a node — has no event of its own, so it is kept
 * here as an append-only JSONL file and re-applied right after the replay.
 *
 * The file lives under the DSH home so it survives restarts but stays out of the
 * session logs (which the harness owns and rewrites).
 *
 * @module dsh-token-tree/plugin/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { NodeId } from '../core/types.ts'

/** One recorded edit. */
export interface EditOp {
  /** Session the edit belongs to. */
  session: string
  /** What was done. */
  action: 'reparent' | 'remove' | 'mark'
  /** Node acted on. */
  nodeId: NodeId
  /** New parent, for `reparent`. */
  parentId?: NodeId
  /** Pin flag, for `mark`. */
  pinned?: boolean
  /** Ignore flag, for `mark`. */
  ignored?: boolean
  /** Soft-delete flag, for `mark`: hidden branches stay restorable. */
  deleted?: boolean
  /** Wall-clock time recorded at write. */
  at: number
}

/** The subset of the filesystem this module needs, injectable for tests. */
export interface StoreIo {
  readFile(path: string): string
  appendFile(path: string, line: string): void
  ensureDir(path: string): void
  exists(path: string): boolean
}

/** Real filesystem, all fail-soft at the call sites. */
const realIo: StoreIo = {
  readFile: path => readFileSync(path, 'utf8'),
  appendFile: (path, line) => appendFileSync(path, line, 'utf8'),
  ensureDir: path => mkdirSync(path, { recursive: true }),
  exists: path => existsSync(path),
}

/** Where the edit log lives when nothing overrides it. */
export function defaultStorePath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'token-tree', 'edits.jsonl')
}

/**
 * Append-only edit log, cached in memory per session.
 *
 * Reads tolerate a missing file and skip malformed lines: a corrupt log must cost
 * the manual overrides, never the plugin.
 */
export class EditStore {
  private readonly path: string
  private readonly io: StoreIo
  private loaded = false
  private readonly bySession = new Map<string, EditOp[]>()
  private readonly onError: (message: string) => void

  constructor(options: { path?: string; io?: StoreIo; onError?: (message: string) => void } = {}) {
    this.path = options.path ?? defaultStorePath()
    this.io = options.io ?? realIo
    this.onError = options.onError ?? (() => {})
  }

  /** File this store appends to. */
  get file(): string {
    return this.path
  }

  /**
   * Replayable edits for one session, oldest first.
   * @param sessionId - session identity.
   * @returns The recorded operations.
   */
  opsFor(sessionId: string): readonly EditOp[] {
    this.load()
    return this.bySession.get(sessionId) ?? []
  }

  /**
   * Record one edit and keep it for this process.
   * @param op - operation to persist.
   */
  record(op: EditOp): void {
    this.load()
    const list = this.bySession.get(op.session) ?? []
    list.push(op)
    this.bySession.set(op.session, list)
    try {
      this.io.ensureDir(dirname(this.path))
      this.io.appendFile(this.path, `${JSON.stringify(op)}\n`)
    } catch (error) {
      // Losing the write only means the edit is forgotten on restart.
      this.onError(`token-tree: could not persist ${op.action} on ${op.nodeId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Read the file once and index it by session. */
  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!this.io.exists(this.path)) return
    let text: string
    try {
      text = this.io.readFile(this.path)
    } catch (error) {
      this.onError(`token-tree: could not read ${this.path}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (typeof parsed !== 'object' || parsed === null) continue
      const candidate = parsed as Partial<EditOp>
      if (typeof candidate.session !== 'string' || typeof candidate.nodeId !== 'string') continue
      if (candidate.action !== 'reparent' && candidate.action !== 'remove' && candidate.action !== 'mark') continue
      const list = this.bySession.get(candidate.session) ?? []
      list.push({
        session: candidate.session,
        action: candidate.action,
        nodeId: candidate.nodeId,
        ...(typeof candidate.parentId === 'string' ? { parentId: candidate.parentId } : {}),
        ...(typeof candidate.pinned === 'boolean' ? { pinned: candidate.pinned } : {}),
        ...(typeof candidate.ignored === 'boolean' ? { ignored: candidate.ignored } : {}),
        ...(typeof candidate.deleted === 'boolean' ? { deleted: candidate.deleted } : {}),
        at: typeof candidate.at === 'number' ? candidate.at : 0,
      })
      this.bySession.set(candidate.session, list)
    }
  }
}
