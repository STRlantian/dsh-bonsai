/**
 * Deterministic local embeddings.
 *
 * Retrieval needs a similarity signal, and a plugin that must load on an
 * offline machine cannot call a hosted embedding endpoint. This module hashes
 * word and CJK character n-grams into a fixed-width vector and L2-normalizes it,
 * which is deterministic across processes and good enough to separate "this node
 * is about the term I just asked about" from "this node is about something else".
 *
 * A deployment that wants real embeddings supplies them through the plugin's
 * `embedding` hook and never calls this module; see the README.
 *
 * @module dsh-bonsai/core/embedding
 */

/** Default embedding width. */
export const DEFAULT_EMBEDDING_DIMENSION = 256

/** FNV-1a 32-bit hash; stable across runs and platforms. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Split text into embedding features: latin words, CJK characters, and CJK bigrams.
 * @param text - source text.
 * @returns Feature strings, possibly empty.
 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const words = normalized.match(/[a-z0-9_]+/gu) ?? []
  const wide = normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu) ?? []
  const bigrams: string[] = []
  for (let index = 0; index + 1 < wide.length; index++) {
    bigrams.push(`${wide[index]}${wide[index + 1]}`)
  }
  return [...words, ...wide, ...bigrams]
}

/**
 * L2-normalize a vector in place.
 * @param vector - vector to normalize.
 * @returns The same array; unchanged when it is already zero-length.
 */
export function normalize(vector: number[]): number[] {
  let sum = 0
  for (const value of vector) sum += value * value
  if (sum === 0) return vector
  const scale = 1 / Math.sqrt(sum)
  for (let index = 0; index < vector.length; index++) vector[index] *= scale
  return vector
}

/** Function words that carry no topic, excluded from lexical overlap. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'it', 'its', 'this', 'that',
  'these', 'those', 'what', 'which', 'who', 'how', 'why', 'when', 'where', 'with', 'as', 'from',
  'you', 'your', 'we', 'our', 'i', 'me', 'my', 'he', 'she', 'they', 'them', 'not', 'no', 'yes',
  '的', '了', '是', '吗', '呢', '吧', '我', '你', '他', '她', '它', '们',
])

/**
 * Topic-bearing features of a text.
 *
 * Lexical overlap drives question attachment, and raw tokens are dominated by
 * function words: "What is a token?" and "What is attention?" share most of their
 * tokens without sharing a topic. Keeping only multi-character words, CJK bigrams,
 * and non-stopwords removes that noise.
 * @param text - source text.
 * @returns Distinct content features, possibly empty.
 */
export function contentFeatures(text: string): Set<string> {
  const features = new Set<string>()
  for (const feature of tokenize(text)) {
    if (feature.length < 2) continue
    if (STOPWORDS.has(feature)) continue
    features.add(feature)
  }
  return features
}

/**
 * Embed one text into a unit-length hashed vector.
 * @param text - source text.
 * @param dimension - vector width; defaults to {@link DEFAULT_EMBEDDING_DIMENSION}.
 * @returns Unit-length vector, or a zero vector for empty input.
 */
export function embedText(text: string, dimension: number = DEFAULT_EMBEDDING_DIMENSION): number[] {
  const vector = new Array<number>(dimension).fill(0)
  const features = tokenize(text)
  if (features.length === 0) return vector
  const counts = new Map<string, number>()
  for (const feature of features) counts.set(feature, (counts.get(feature) ?? 0) + 1)
  for (const [feature, count] of counts) {
    const hash = fnv1a(feature)
    const index = hash % dimension
    const sign = (hash & 0x8000_0000) === 0 ? 1 : -1
    vector[index] += sign * (1 + Math.log(count))
  }
  return normalize(vector)
}

/**
 * Cosine similarity between two vectors of equal width.
 * @param left - first vector.
 * @param right - second vector.
 * @returns Similarity in `[-1, 1]`; `0` for a zero vector or a width mismatch.
 */
export function cosine(left: readonly number[], right: readonly number[]): number {
  const width = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < width; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}
