/**
 * Relic Shop roster — ported verbatim from the client prototype's
 * FLAIR_TIERS (see CLAUDE_CODE_PROMPT.md), matching the design doc's locked
 * roster. Server-only: price is authoritative here for purchase validation.
 * Name is duplicated in the client for display — it's static content, not
 * RNG or spoiler-sensitive, so duplication is fine (unlike TELEGRAPHS/
 * GAMBLES, which the client never gets a copy of).
 */
export type RelicTier = {tier: number; price: number; name: string}

export const RELIC_TIERS: readonly RelicTier[] = [
  {tier: 1, price: 150, name: 'Bronze Scarab'},
  {tier: 2, price: 400, name: 'Silver Scarab'},
  {tier: 3, price: 650, name: 'Gold Scarab'},
  {tier: 4, price: 950, name: 'Lapis Scarab'},
  {tier: 5, price: 1300, name: 'Clay Ankh'},
  {tier: 6, price: 1700, name: 'Copper Ankh'},
  {tier: 7, price: 2100, name: 'Gold Ankh'},
  {tier: 8, price: 2600, name: 'Radiant Ankh'},
  {tier: 9, price: 3100, name: 'Stone Eye of Horus'},
  {tier: 10, price: 3650, name: 'Silver Eye of Horus'},
  {tier: 11, price: 4300, name: 'Gold Eye of Horus'},
  {tier: 12, price: 4900, name: 'Sacred Eye of Horus'},
  {tier: 13, price: 5600, name: 'Uraeus Diadem'},
  {tier: 14, price: 6350, name: 'Nemes Headpiece'},
  {tier: 15, price: 7100, name: 'Royal Collar'},
  {tier: 16, price: 7900, name: 'Golden Crook'},
  {tier: 17, price: 8750, name: 'Sundisk Pendant'},
  {tier: 18, price: 9650, name: 'Obsidian Sphinx'},
  {tier: 19, price: 10600, name: 'Bennu Feather'},
  {tier: 20, price: 11600, name: 'Eternal Flame Crown'},
]

export function relicTier(tier: number): RelicTier | undefined {
  return RELIC_TIERS.find(t => t.tier === tier)
}
