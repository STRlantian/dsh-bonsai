/**
 * Named setting bundles.
 *
 * The UI offers these instead of making people tune four numbers to get one behaviour. Each
 * one states what it buys: the conservative bundle is the previous default (nothing hidden,
 * fold only very late), the aggressive one follows the measurements — tool schemas are 83% of
 * the prompt and hiding them saved 3,377 tokens per turn, so it hides the heavy, rarely needed
 * ones and folds earlier.
 *
 * @module dsh-token-tree/plugin/presets
 */

/** The presets the settings panel offers. */
export type PresetName = 'conservative' | 'balanced' | 'aggressive'

/** One preset: a label, a one-line reason, and the overrides it writes. */
export interface Preset {
  /** Stable id used by the route and the UI. */
  name: PresetName
  /** Settings to merge; `null` clears a key. */
  settings: Record<string, unknown>
}

/**
 * Tools that are heavy and rarely needed in an ordinary coding chat.
 *
 * Names matter: `tools.restrict()` validates them, and one unknown name rejects the whole
 * filter. This list was checked against the host's own "known global tools" output.
 */
export const AGGRESSIVE_HIDDEN_TOOLS = [
  'workflow',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'schedule_list',
  'subagent_fork',
  'ask_user_question',
  'update_goal',
  'get_goal',
] as const

/** All presets, in the order the panel shows them. */
export const PRESETS: readonly Preset[] = [
  {
    name: 'conservative',
    settings: {
      foldAboveTokens: 60000,
      foldKeepTurns: 4,
      foldScope: 'turns',
      toolDeny: null,
      autoCompactAboveTokens: 0,
      retrievalHint: true,
      autoInject: false,
    },
  },
  {
    name: 'balanced',
    settings: {
      foldAboveTokens: 40000,
      foldKeepTurns: 3,
      foldScope: 'turns',
      toolDeny: null,
      autoCompactAboveTokens: 0,
      retrievalHint: true,
      autoInject: false,
    },
  },
  {
    name: 'aggressive',
    settings: {
      foldAboveTokens: 20000,
      foldKeepTurns: 2,
      foldScope: 'turns',
      toolDeny: [...AGGRESSIVE_HIDDEN_TOOLS],
      autoCompactAboveTokens: 0,
      retrievalHint: true,
      autoInject: false,
    },
  },
]

/**
 * Look a preset up by name.
 * @param name - candidate id from the request body.
 * @returns The preset, or `undefined` when the name is unknown.
 */
export function presetOf(name: unknown): Preset | undefined {
  return PRESETS.find(preset => preset.name === name)
}
