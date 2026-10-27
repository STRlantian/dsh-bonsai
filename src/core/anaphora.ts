/**
 * How much a question is pointing at something already said.
 *
 * "它怎么调" has no content of its own: every word either refers back (它, 这个, 上面) or asks
 * (怎么, 吗, 呢). Such a turn can never be matched to an old answer by shared terms, and the
 * new-topic rule used to send it to the root - which loses the thread it was continuing. The score
 * below is what lets attachment keep such a turn where the dialogue actually stands.
 */

/** Pronouns and back-references: the words that say "the thing we were just talking about". */
const BACK_REFERENCES = [
  '它', '他', '她', '它们', '这个', '那个', '这些', '那些', '该', '此', '其', '上面', '刚才',
  '前者', '后者', '这样', '那样', '这里', '那里', '这种', '那种', '后者', '上述', '前面',
]

/** Words that ask rather than name. */
const ASKING = ['怎么', '为什么', '为何', '如何', '什么', '多少', '哪个', '哪些', '是否', '能不能', '可不可以', '吗', '呢', '吧', '还有', '别的', '其他']

/**
 * Score how anaphoric a question is, in [0, 1].
 *
 * Three cheap signals, all local: a back-reference present, a high share of asking words, and a
 * low share of "content" characters (anything not a function word or a pronoun).
 * @param text - the question as the user typed it.
 * @returns 0 for a self-contained question, 1 for pure reference.
 */
export function anaphoraScore(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  const hasReference = BACK_REFERENCES.some(word => trimmed.includes(word))
  const asks = ASKING.filter(word => trimmed.includes(word)).length
  // Content characters: what is left once the reference and asking words are removed.
  let rest = trimmed
  for (const word of [...BACK_REFERENCES, ...ASKING]) rest = rest.split(word).join('')
  const contentChars = rest.replace(/[\s，。？！、,.?!:：;；"'“”()（）\[\]【】]/g, '').length
  const contentShare = contentChars / Math.max(1, trimmed.length)
  if (!hasReference) {
    return asks > 0 && contentChars <= 4 ? 0.5 : 0
  }
  // A reference plus almost no content of its own: "它还有别的限制吗".
  const referenceScore = contentShare <= 0.25 ? 1 : contentShare <= 0.5 ? 0.75 : 0.5
  return Math.min(1, referenceScore + (asks > 0 ? 0.1 : 0))
}
