/**
 * Optional BGE retrieval scorer.
 *
 * This is deliberately lazy: the plugin must start without `@huggingface/transformers` or a
 * model on disk. Any failure returns `undefined`, and the caller falls back to the hashed
 * embedding that ships with the plugin.
 *
 * Node scores use the measured winner from the experiments: split the text into chunks, embed
 * every chunk, and use the mean cosine over all chunks. A query is one vector.
 *
 * @module dsh-bonsai/plugin/bge
 */
import type { MemoryNode, NodeId } from '../core/types.ts'

/** Minimal logger contract used by the provider. */
export interface BgeLogger {
  warn: (message: string) => void
  info: (message: string) => void
}

/** One node's chunk vectors, cached because node content is immutable. */
type ChunkCache = Map<string, number[][]>

/** Score every node for one query; `undefined` means "not available, use hash". */
export interface BgeScorerLike {
  score: (query: string, nodes: readonly MemoryNode[], chunkChars: number) => Promise<Map<NodeId, number> | undefined>
}

/** BGE-backed chunk scorer. */
export class BgeScorer implements BgeScorerLike {
  private extractor: { (texts: string[], options: Record<string, unknown>): Promise<{ tolist: () => number[][] }> } | undefined
  private loading: Promise<boolean> | undefined
  private warned = false
  private readonly cache: ChunkCache = new Map()
  private readonly logger: BgeLogger
  private readonly model: string

  constructor(logger: BgeLogger, model = 'Xenova/bge-small-zh-v1.5') {
    this.logger = logger
    this.model = model
  }

  /** Load the model once; return false rather than throw when it cannot be loaded. */
  private async ensure(): Promise<boolean> {
    if (this.extractor !== undefined) return true
    if (this.loading === undefined) {
      this.loading = (async () => {
        try {
          const transformers = await import('@huggingface/transformers')
          const pipeline = transformers.pipeline as unknown as (
            task: string,
            model: string,
            options: Record<string, unknown>,
          ) => Promise<typeof this.extractor>
          this.extractor = await pipeline('feature-extraction', this.model, { dtype: 'q8' })
          this.logger.info('token-tree: BGE retrieval embeddings loaded')
          return true
        } catch (error) {
          if (!this.warned) {
            this.warned = true
            this.logger.warn(`token-tree: BGE unavailable, retrieval falls back to hash (${String(error)})`)
          }
          return false
        }
      })()
    }
    return this.loading
  }

  private chunks(text: string, chunkChars: number): string[] {
    const sentences = text.split(/(?<=[。！？；\n])/u).filter(sentence => sentence.trim().length > 0)
    if (sentences.length === 0) return [text.slice(0, 1_500)]
    const chunks: string[] = []
    let current = ''
    for (const sentence of sentences) {
      if (current.length + sentence.length > chunkChars && current.length > 0) {
        chunks.push(current)
        current = ''
      }
      current += sentence
    }
    if (current.trim().length > 0) chunks.push(current)
    return chunks.length === 0 ? [text.slice(0, 1_500)] : chunks
  }

  private async vectors(texts: readonly string[]): Promise<number[][]> {
    if (this.extractor === undefined || texts.length === 0) return []
    const result = await this.extractor([...texts], { pooling: 'mean', normalize: true })
    return result.tolist()
  }

  /**
   * Score nodes with BGE chunk meanAll.
   * @param query - retrieval query.
   * @param nodes - candidates.
   * @param chunkChars - target chunk size.
   * @returns Scores keyed by node id, or undefined when BGE is unavailable.
   */
  async score(query: string, nodes: readonly MemoryNode[], chunkChars: number): Promise<Map<NodeId, number> | undefined> {
    if (!(await this.ensure())) return undefined
    const usable = nodes.filter(node => node.content.trim() !== '')
    if (usable.length === 0) return new Map()
    try {
      const [queryVector] = await this.vectors([query])
      const pending: { node: MemoryNode; chunks: string[] }[] = []
      const allChunks: string[] = []
      for (const node of usable) {
        const key = `${node.id}:${node.content.length}:${chunkChars}`
        let vectors = this.cache.get(key)
        if (vectors === undefined) {
          const chunks = this.chunks(node.content, chunkChars)
          pending.push({ node, chunks })
          allChunks.push(...chunks)
        } else {
          pending.push({ node, chunks: [] })
        }
      }
      const fresh = allChunks.length === 0 ? [] : await this.vectors(allChunks)
      let cursor = 0
      for (const item of pending) {
        if (item.chunks.length === 0) continue
        const vectors = fresh.slice(cursor, cursor + item.chunks.length)
        cursor += item.chunks.length
        this.cache.set(`${item.node.id}:${item.node.content.length}:${chunkChars}`, vectors)
      }
      const scores = new Map<NodeId, number>()
      for (const node of usable) {
        const vectors = this.cache.get(`${node.id}:${node.content.length}:${chunkChars}`) ?? []
        if (vectors.length === 0) continue
        let sum = 0
        for (const vector of vectors) {
          let dot = 0
          let left = 0
          let right = 0
          for (let index = 0; index < vector.length; index++) {
            dot += queryVector[index] * vector[index]
            left += queryVector[index] ** 2
            right += vector[index] ** 2
          }
          sum += left === 0 || right === 0 ? 0 : dot / Math.sqrt(left * right)
        }
        scores.set(node.id, sum / vectors.length)
      }
      return scores
    } catch (error) {
      if (!this.warned) {
        this.warned = true
        this.logger.warn(`token-tree: BGE scoring failed, retrieval falls back to hash (${String(error)})`)
      }
      return undefined
    }
  }
}
