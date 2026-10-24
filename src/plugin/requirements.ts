/**
 * Turning instructions and topic questions are different things.
 *
 * "以下所有回答限制在 100 字以内" is not a topic to remember; it is a constraint
 * that applies to everything that follows, and it stops applying when the learner
 * says so. Indexing those turns as tree nodes both pollutes the tree and loses the
 * one fact that matters (which constraints are active *now*).
 *
 * The classifier here is deterministic and offline. A model-based classifier would
 * judge better, but it costs a call per turn, and injecting its verdict into the
 * conversation prefix would invalidate the prompt cache — see `docs/ui-design.md`.
 *
 * @module dsh-token-tree/plugin/requirements
 */

/** What one learner turn is for. */
export type TurnKind = 'topic' | 'constraint'

/** One active or expired constraint. */
export interface Constraint {
  /** Stable id, so an edit can target one rule. */
  id: string
  /** Original turn text. */
  text: string
  /** Where it came from: the classifier, or the rule editor. */
  source: 'auto' | 'manual'
  /** When it arrived. */
  createdAt: number
  /** Whether it still applies. */
  active: boolean
  /** Which rule matched. */
  reason: string
  /** Text of the constraint that expired this one. */
  supersededBy?: string
}

/** Outcome of classifying one turn. */
export interface Classification {
  /** Topic turns become tree nodes; constraint turns do not. */
  kind: TurnKind
  /** Which rule decided, for the log and the UI badge. */
  reason: string
  /** This turn lifts earlier constraints rather than adding one. */
  cancels: boolean
}

/** Phrases that lift an earlier constraint. */
const CANCEL = [
  '不再受', '不再限制', '取消', '解除', '忽略之前', '忽略以上', '不用再', '不需要再', '不必再',
]

/** Phrases that introduce or tighten a constraint. */
const CONSTRAINT = [
  '以下所有', '以下都', '以后都', '之后都', '从现在起', '从今以后', '接下来所有',
  '限制在', '不要超过', '不超过', '以内', '字数', '越短越好', '简短', '精简', '详细回答', '只回答', '只输出',
  '必须', '一定要', '记住', '统一格式', '统一回答', '按以下格式', '用中文回答', '用英文回答',
]

/** Phrases that make a turn a topic question even when a constraint phrase appears. */
const TOPIC = ['什么是', '是什么', '介绍了', '解释', '怎么', '如何', '为什么', '区别', '原理', '示例', '例子']

/**
 * Openers that scope an instruction to everything after it.
 *
 * These win over a topic word inside the same sentence: "从现在起只输出结论，
 * 不要解释" is an instruction, even though it contains 解释.
 */
const DIRECTIVE_OPENERS = ['以下', '以后', '之后', '从现在起', '从今以后', '接下来所有', '接下来都']

/** Whether the text asks a question. */
function asksQuestion(text: string): boolean {
  return /[?？]/.test(text) || /吗[。！!]?$/.test(text.trim())
}

/**
 * Classify one learner turn.
 *
 * Order matters: an explicit "不再…" cancels first; an explicit topic marker wins
 * over a stray constraint word ("介绍…限制在…" is a topic, not an instruction);
 * otherwise a constraint phrase decides, unless the turn is a question.
 * @param text - the learner's message.
 * @returns The classification plus the rule that decided it.
 */
export function classifyTurn(text: string): Classification {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const hitCancel = CANCEL.find(phrase => normalized.includes(phrase))
  if (hitCancel !== undefined) {
    return { kind: 'constraint', reason: `cancel:${hitCancel}`, cancels: true }
  }
  const opener = DIRECTIVE_OPENERS.find(phrase => normalized.startsWith(phrase))
  if (opener !== undefined && !asksQuestion(normalized)) {
    return { kind: 'constraint', reason: `directive:${opener}`, cancels: false }
  }
  const hitTopic = TOPIC.find(phrase => normalized.includes(phrase))
  if (hitTopic !== undefined) {
    return { kind: 'topic', reason: `topic:${hitTopic}`, cancels: false }
  }
  const hitConstraint = CONSTRAINT.find(phrase => normalized.includes(phrase))
  if (hitConstraint !== undefined && !asksQuestion(normalized)) {
    return { kind: 'constraint', reason: `constraint:${hitConstraint}`, cancels: false }
  }
  return { kind: 'topic', reason: 'default', cancels: false }
}

/**
 * Apply one classified constraint to the list.
 *
 * A cancelling turn expires every active constraint; a new constraint simply
 * appends. The newest few are kept so the list stays a working set.
 * @param list - current constraints, oldest first.
 * @param text - constraint text.
 * @param createdAt - arrival time.
 * @param classification - result of {@link classifyTurn}.
 * @param keep - how many entries to retain; defaults to 8.
 * @returns The updated list.
 */
export function applyConstraint(
  list: readonly Constraint[],
  text: string,
  createdAt: number,
  classification: Classification,
  keep = 8,
): Constraint[] {
  const next: Constraint[] = classification.cancels
    ? list.map(entry => (entry.active ? { ...entry, active: false, supersededBy: text } : entry))
    : [...list]
  if (!classification.cancels) {
    next.push({
      id: `rule-${createdAt.toString(36)}-${next.length}`,
      text,
      createdAt,
      active: true,
      source: 'auto',
      reason: classification.reason,
    })
  }
  return next.slice(-keep)
}

/**
 * Active constraints, newest first.
 * @param list - constraints, oldest first.
 * @returns Active entries newest first.
 */
export function activeConstraints(list: readonly Constraint[]): Constraint[] {
  return list.filter(entry => entry.active).reverse()
}

/** One hand edit of a rule. */
export interface RuleEdit {
  /** Which mutation to apply. */
  op: 'add' | 'update' | 'remove' | 'toggle'
  /** Target rule; ignored by `add`. */
  id?: string
  /** New text, for `add` and `update`. */
  text?: string
  /** New active flag, for `toggle`. */
  active?: boolean
  /** Wall-clock time of the edit. */
  at: number
}

/**
 * Apply one hand edit to the rule list.
 *
 * Hand edits always produce `source: 'manual'`, so the chip can show where a rule came from and
 * a later classifier pass never overwrites one.
 * @param list - current rules, oldest first.
 * @param edit - the mutation.
 * @returns The updated list; unchanged when the edit targets a missing rule.
 */
export function applyRuleEdit(list: readonly Constraint[], edit: RuleEdit): Constraint[] {
  const next = [...list]
  if (edit.op === 'add') {
    const text = (edit.text ?? '').trim()
    if (text === '') return next
    next.push({
      id: `rule-${edit.at.toString(36)}-${next.length}`,
      text,
      createdAt: edit.at,
      active: edit.active !== false,
      source: 'manual',
      reason: 'manual',
    })
    return next
  }
  const index = next.findIndex(entry => entry.id === edit.id)
  if (index < 0) return next
  if (edit.op === 'remove') {
    next.splice(index, 1)
    return next
  }
  const current = next[index]
  if (edit.op === 'update') {
    const text = (edit.text ?? '').trim()
    if (text === '') return next
    next[index] = { ...current, text, source: 'manual' }
    return next
  }
  next[index] = { ...current, active: edit.active === true, source: 'manual' }
  return next
}
