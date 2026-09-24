/**
 * Real balancing parameters — 5-band system per design doc v0.11 Section 4.
 * Ported verbatim from the authoritative client prototype's `PARAMS` object
 * (see CLAUDE_CODE_PROMPT.md). All fields have been run through the JS
 * balancing simulator (40,000-trial Monte Carlo) and confirmed to match its
 * own built-in reference values exactly, with no discontinuity at any band
 * boundary (20/21, 30/31, 40/41). Don't re-derive these — they're ported
 * as-is.
 *
 * Server-only: this is exactly the data that was "trivially inspectable/
 * riggable in devtools" when it lived in the client — moving it here (and
 * never sending it to the client) is the point of the RNG migration.
 */
export type Band = 0 | 1 | 2 | 3 | 4

export const PARAMS = {
  mix: [
    {treasure: 60, hazard: 25, gamble: 15}, // Band 1 (1-10)
    {treasure: 60, hazard: 25, gamble: 15}, // Band 2 (11-20)
    {treasure: 55, hazard: 30, gamble: 15}, // Band 3 (21-30)
    {treasure: 50, hazard: 35, gamble: 15}, // Band 4 (31-40)
    {treasure: 45, hazard: 40, gamble: 15}, // Band 5 (41+)
  ],
  hazardPresent: [40, 40, 45, 50, 58], // % chance a telegraphed hazard is real
  gambleSuccess: 50,
  bandEnds: [10, 20, 30, 40], // depth <= bandEnds[i] -> band i; beyond last -> band 4
  dmg: [
    [1, 3],
    [2, 4],
    [3, 4],
    [4, 4],
    [4, 4],
  ], // capped at 4 from Band 4 on — never a one-shot at 5 starting HP
  treasure: [
    [3, 5],
    [5, 8],
    [8, 12],
    [10, 15],
    [12, 18],
  ],
  gambleBonus: [
    [5, 8],
    [8, 12],
    [12, 18],
    [15, 22],
    [18, 26],
  ],
} as const

// First 3 labels are verbatim from source's BAND_LABELS; Bands 4-5 don't
// exist in source (3-band model) so are extended in the same style, not
// pulled from anywhere authoritative (accepted as-is per CLAUDE_CODE_PROMPT.md).
export const BAND_LABELS = [
  'Upper Chamber',
  'Middle Passage',
  'Deep Shaft',
  'Forsaken Depths',
  'Abyssal Core',
] as const

export function bandFor(depth: number): Band {
  for (const [i, end] of PARAMS.bandEnds.entries()) {
    if (depth <= end) return i as Band
  }
  return PARAMS.bandEnds.length as Band // Band 5
}

export const STARTING_HP = 5
export const STARTING_WARDS = 3
export const MAX_WARDS_LABEL = STARTING_WARDS
