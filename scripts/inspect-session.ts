/**
 * Rebuild and print the conversation tree of one stored session.
 *
 * The plugin keeps trees in memory and rebuilds them from the durable session
 * log, so this script is the offline equivalent of what the running agent holds:
 * it reads `session.vN.jsonl[.zstd]`, replays every event through the same
 * `TokenTreeService.handleEvent()` the plugin uses, then prints the tree.
 *
 * The JSONL provider appends one zstd frame per flush, so a log is a concatenation
 * of frames and Node's `zstdDecompressSync` only returns the first one; this
 * script decodes frame by frame.
 *
 * Usage:
 *   node scripts/inspect-session.ts                  # this session (DSH_SESSION_ID) or the newest one
 *   node scripts/inspect-session.ts <dir|file>       # a specific session directory or log file
 *   node scripts/inspect-session.ts --depth 5        # deeper tree preview
 *   node scripts/inspect-session.ts --all            # every node, no depth cap
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { Config } from '../src/plugin/config.ts'
import type { ResolvedConfig } from '../src/plugin/config.ts'
import { renderTree } from '../src/plugin/render.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import type { SessionEventLike } from '../src/plugin/dsh.ts'

/** zstd frame magic, little endian. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const

/** Resolve the configuration used for the replay. */
function config(): ResolvedConfig {
  const result = Config['~standard'].validate({
    logEdgeUpdates: false,
    maxNodesPerSession: 100_000,
  })
  if (result.value === undefined) throw new Error('invalid default config')
  return result.value
}

/** Session directory name the harness derives from a working directory. */
function sessionSlug(directory: string): string {
  return `--${directory.replace(/:/g, '').replace(/[\\/]/g, '-')}--`
}

/** Newest session log for this working directory, preferring `DSH_SESSION_ID`. */
function newestSessionLog(home: string): string {
  const root = join(home, 'sessions', sessionSlug(process.cwd()))
  if (!existsSync(root)) throw new Error(`no sessions directory at ${root}`)
  const candidates: string[] = []
  for (const directory of readdirSync(root)) {
    const full = join(root, directory)
    if (!statSync(full).isDirectory()) continue
    for (const name of readdirSync(full)) {
      if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(name)) candidates.push(join(full, name))
    }
  }
  if (candidates.length === 0) throw new Error(`no session log under ${root}`)
  const newestFirst = candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  const current = process.env.DSH_SESSION_ID
  if (current !== undefined) {
    const match = newestFirst.find(path => path.includes(current))
    if (match !== undefined) return match
  }
  return newestFirst[0]
}

/** Decode every concatenated zstd frame of one log file. */
function decodeZstd(raw: Buffer): string {
  const offsets: number[] = []
  for (let index = 0; index + 3 < raw.length; index++) {
    if (raw[index] === ZSTD_MAGIC[0] && raw[index + 1] === ZSTD_MAGIC[1]
      && raw[index + 2] === ZSTD_MAGIC[2] && raw[index + 3] === ZSTD_MAGIC[3]) {
      offsets.push(index)
    }
  }
  const parts: string[] = []
  for (const offset of offsets) {
    try {
      parts.push(zstdDecompressSync(raw.subarray(offset)).toString('utf8'))
    } catch {
      // A magic-like byte sequence inside compressed payload; not a frame.
    }
  }
  return parts.join('')
}

/** Read a log file of any generation. */
function readLog(file: string): string {
  const raw = readFileSync(file)
  return file.endsWith('.zstd') ? decodeZstd(raw) : raw.toString('utf8')
}

/** Parse JSONL into event envelopes. */
function parseEvents(text: string): SessionEventLike[] {
  const events: SessionEventLike[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
    try {
      parsed = JSON.parse(trimmed) as typeof parsed
    } catch {
      continue
    }
    if (typeof parsed.type !== 'string' || typeof parsed.data !== 'object' || parsed.data === null) continue
    events.push({
      type: parsed.type,
      seq: typeof parsed.seq === 'number' ? parsed.seq : events.length,
      time: typeof parsed.time === 'number' ? parsed.time : Date.now(),
      data: parsed.data as Record<string, unknown>,
    })
  }
  return events
}

/** Shorten one node's text for the tree drawing. */
function preview(text: string, width = 58): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`
}

// --- arguments ------------------------------------------------------------
const argv = process.argv.slice(2)
const all = argv.includes('--all')
/** Print exactly what the `/tree` command returns instead of the debug view. */
const asCommand = argv.includes('--command')
const depthIndex = argv.indexOf('--depth')
const depthValue = depthIndex >= 0 ? argv[depthIndex + 1] : undefined
const maxDepth = all ? Number.POSITIVE_INFINITY : depthIndex >= 0 ? Number(depthValue) : 3
const target = argv.find(argument => !argument.startsWith('--') && argument !== depthValue)

const file = target === undefined
  ? newestSessionLog(process.env.DSH_HOME ?? 'C:\\Users\\ASUS\\.dsh')
  : resolve(target)
const sessionId = file.split(/[\\/]/).filter(part => part.length > 0).at(-2) ?? 'session'
const events = parseEvents(readLog(file))

const service = new TokenTreeService({
  config: config(),
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
})
for (const event of events) service.handleEvent({ id: sessionId }, event)

const state = service.stateOf(sessionId)
const tree = state.tree
const stats = tree.stats()

if (asCommand) {
  // The exact text `/tree` hands to the chat surface.
  console.log(renderTree(tree, { maxLines: all ? 10_000 : 40, depth: Number.isFinite(maxDepth) ? maxDepth : 10 }))
  process.exit(0)
}

const kindCounts = new Map<string, number>()
for (const node of tree.nodes.values()) kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1)

console.log(`log       ${file}`)
console.log(`session   ${sessionId}`)
console.log(`events    ${events.length} replayed`)
console.log(`tree      ${stats.nodes} nodes, ${stats.edges} edges, depth ${stats.maxDepth}, ${stats.totalTokens} tokens`)
console.log(`kinds     ${[...kindCounts.entries()].sort((left, right) => right[1] - left[1]).map(([kind, count]) => `${kind}=${count}`).join('  ')}`)
console.log(`current   ${stats.currentId}  (root path cost ${stats.rootPathCost.toFixed(3)}, mean edge cost ${stats.averageCost.toFixed(3)})`)
console.log('')

/** Print one node and, within the depth cap, its children. */
const printBranch = (id: string, depth: number): void => {
  const node = tree.node(id)
  const edge = node.parentId === null ? undefined : tree.edge(node.parentId, id)
  const marker = node.id === tree.currentId ? '▶' : ' '
  const cost = edge === undefined ? '' : ` cost=${edge.cost.toFixed(2)}${edge.updates > 0 ? `(${edge.lastReason ?? 'updated'})` : ''}`
  const flags = [
    node.metadata.ok === false ? 'FAILED' : '',
    node.metadata.pinned === true ? 'pinned' : '',
    node.metadata.ignored === true ? 'ignored' : '',
  ].filter(flag => flag.length > 0)
  console.log(
    `${marker} ${'  '.repeat(depth)}${node.id} [${node.kind}]${cost}`
    + `${flags.length > 0 ? ` {${flags.join(',')}}` : ''} ${preview(node.content)}`,
  )
  if (depth >= maxDepth) {
    if (node.children.length > 0) console.log(`   ${'  '.repeat(depth)}… ${tree.subtree(id).length - 1} node(s) below`)
    return
  }
  for (const child of node.children) printBranch(child, depth + 1)
}

printBranch(tree.rootId, 0)

console.log('')
const spine = tree.pathCost(tree.currentId, tree.rootId)
console.log(`current → root  cost ${spine.cost.toFixed(3)}, ${spine.path.length - 1} hop(s)`)
for (const id of [...spine.path].reverse()) {
  const node = tree.node(id)
  const edge = node.parentId === null ? undefined : tree.edge(node.parentId, id)
  console.log(`  ${node.id} [${node.kind}]${edge === undefined ? '' : ` cost=${edge.cost.toFixed(2)}`} ${preview(node.content, 52)}`)
}

const branches = tree.node(tree.rootId).children
  .map(child => ({ child, size: tree.subtree(child).length }))
  .sort((left, right) => right.size - left.size)
console.log(`top branches    ${branches.slice(0, 6).map(entry => `${entry.child}:${entry.size}`).join('  ')}`)
