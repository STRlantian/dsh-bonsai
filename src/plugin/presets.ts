/**
 * The single shipped preset.
 *
 * Cost is price-dependent: with a 50× cache-miss multiplier, the measured default was the cheapest
 * of the three arms, while the old "aggressive" preset only won when the miss/hit ratio was below
 * roughly 18×. Rather than ship bundles that claim to be cheaper under every price, the plugin
 * ships one measured default; the advanced settings remain available for tuning.
 *
 * @module dsh-token-tree/plugin/presets
 */

/** The preset ids the settings panel offers. */
export type PresetName = 'balanced'

/** One preset: a stable id and the settings bundle it writes. The panel owns the label/description. */
export interface Preset {
  /** Stable id used by the route and the UI. */
  name: PresetName
  /** Settings to merge; `null` clears a key. */
  settings: Record<string, unknown>
}

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
