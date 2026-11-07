/**
 * Named setting bundles.
 *
 * Cost is price-dependent: with a 50× cache-miss multiplier, the measured default was the cheapest
 * of the three arms, while the old "aggressive" preset only won when the miss/hit ratio was below
 * roughly 18×. The panel therefore exposes one measured default plus two explicit modes:
 *
 * - `treeOnly`: keep building the tree, but stop every model-facing behaviour;
 * - `off`: also hide the tree/retrieval tools, so the plugin is inert from the model's view while
 *   the panel can still show the recorded tree.
 *
 * @module dsh-token-tree/plugin/presets
 */

/** The preset ids the settings panel offers. */
export type PresetName = 'balanced' | 'treeOnly' | 'off'

/** One preset: a stable id and the settings bundle it writes. The panel owns the label/description. */
export interface Preset {
  /** Stable id used by the route and the UI. */
  name: PresetName
  /** Settings to merge; `null` clears a key. */
  settings: Record<string, unknown>
}

/** Tools this plugin owns; hiding all of them makes the plugin inert to the model. */
export const PLUGIN_TOOL_NAMES = [
  'retrieve_context',
  'tree_query',
  'tree_mark',
  'tree_focus',
  'tree_attach',
  'tree_backtrack',
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
  'autoFold',
  'foldTrigger',
  'foldScope',
  'foldPolicy',
  'toolDeny',
] as const

/** All presets, in the order the panel shows them. */
export const PRESETS: readonly Preset[] = [
  {
    name: 'balanced',
    settings: {
      // Measured default: keeping two turns preserves the working set while the larger block
      // ratio and 10-turn cadence amortise each prefix rewrite. No tools are hidden.
      foldAboveTokens: 30000,
      foldKeepTurns: 2,
      foldScope: 'turns',
      foldBlockRatio: 8,
      foldCadence: 10,
      toolDeny: [],
      retrievalHint: true,
      autoInject: false,
      autoFold: true,
    },
  },
  {
    name: 'treeOnly',
    settings: {
      // Record the tree, but do not change the model's prompt or loop.
      autoInject: false,
      autoFold: false,
      retrievalHint: false,
      attachChoices: 0,
      attachSummary: false,
      autoReflect: false,
      foldAboveTokens: 0,
      foldBlockRatio: 0,
      foldCadence: 0,
      mandatoryContext: false,
      fileRegion: 'off',
      toolDeny: [],
    },
  },
  {
    name: 'off',
    settings: {
      // Inert from the model's view: no injection, no hints, no folding, no plugin tools.
      // The panel can still show the tree that was recorded before/while off.
      autoInject: false,
      autoFold: false,
      retrievalHint: false,
      attachChoices: 0,
      attachSummary: false,
      autoReflect: false,
      foldAboveTokens: 0,
      foldBlockRatio: 0,
      foldCadence: 0,
      mandatoryContext: false,
      fileRegion: 'off',
      toolDeny: [...PLUGIN_TOOL_NAMES],
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
