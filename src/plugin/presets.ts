/**
 * Named setting bundles.
 *
 * The UI offers these instead of making people tune four numbers to get one behaviour. The list is
 * deliberately short and named by intent: only-tree, daily default, coding, keep-context, and save.
 * Each bundle states what it buys; the panel also shows a one-line explanation under each button.
 *
 * @module dsh-token-tree/plugin/presets
 */

/** The presets the settings panel offers. */
export type PresetName = 'treeOnly' | 'conservative' | 'balanced' | 'coding' | 'aggressive'

/** One preset: a stable id and the settings bundle it writes. The panel owns the label/description. */
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

/** Every key a preset owns. Applying a preset clears the others in this set first. */
export const PRESET_KEYS = [
  'autoInject',
  'retrievalHint',
  'autoReflect',
  'attachChoices',
  'attachSummary',
  'attachGate',
  'fileRegion',
  'mandatoryContext',
  'foldAboveTokens',
  'foldKeepTurns',
  'foldCadence',
  'foldBlockRatio',
  'foldTrigger',
  'foldScope',
  'foldPolicy',
  'toolDeny',
] as const

/** All presets, in the order the panel shows them. */
export const PRESETS: readonly Preset[] = [
  {
    name: 'treeOnly',
    settings: {
      // Only the tree: no injection, no hint, no candidate block, no folding, no reflection.
      autoInject: false,
      retrievalHint: false,
      attachChoices: 0,
      attachSummary: false,
      autoReflect: false,
      foldAboveTokens: 0,
      foldBlockRatio: 0,
      foldCadence: 0,
      mandatoryContext: false,
      toolDeny: [],
    },
  },
  {
    name: 'conservative',
    settings: {
      foldAboveTokens: 60000,
      foldKeepTurns: 4,
      foldScope: 'turns',
      foldBlockRatio: 5,
      foldCadence: 3,
      toolDeny: [],
      retrievalHint: true,
      autoInject: false,
    },
  },
  {
    name: 'balanced',
    settings: {
      // Measured sweet spot: keeping two turns preserves the working set while the larger
      // block ratio and 10-turn cadence amortise each prefix rewrite.
      foldAboveTokens: 30000,
      foldKeepTurns: 2,
      foldScope: 'turns',
      foldBlockRatio: 8,
      foldCadence: 10,
      toolDeny: [],
      retrievalHint: true,
      autoInject: false,
    },
  },
  {
    name: 'coding',
    settings: {
      // Editing files: tool output dominates the history, and turn boundaries matter less.
      foldAboveTokens: 20000,
      foldKeepTurns: 3,
      foldScope: 'tools',
      foldBlockRatio: 5,
      foldCadence: 3,
      fileRegion: 'auto',
      mandatoryContext: true,
      toolDeny: [],
      retrievalHint: true,
      autoInject: false,
    },
  },
  {
    name: 'aggressive',
    settings: {
      // The cheapest bundle: fold early, keep one turn, and hide the heavy rarely-used tools.
      foldAboveTokens: 10000,
      foldKeepTurns: 1,
      foldScope: 'turns',
      foldBlockRatio: 5,
      foldCadence: 3,
      fileRegion: 'digest',
      mandatoryContext: true,
      toolDeny: [...AGGRESSIVE_HIDDEN_TOOLS],
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
