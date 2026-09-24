/**
 * Hazard telegraph and gamble flavor text, ported verbatim from the
 * authoritative client prototype (see CLAUDE_CODE_PROMPT.md). Server-only:
 * the server resolves which pool entry was picked (deterministically, see
 * rng.ts) and sends the resolved text/names to the client directly — the
 * client never needs its own copy of these pools.
 *
 * Only 3 distinct pools exist (5 flavors each); Bands 3, 4, and 5 all reuse
 * Band 3's pool (index 2) — a real content limitation in the source
 * material, not something introduced here. Don't add more without being
 * asked (see CLAUDE_CODE_PROMPT.md's "known, deliberately accepted gaps").
 */
export type Telegraph = {text: string; safe: string; hazard: string}

export const TELEGRAPHS: readonly (readonly Telegraph[])[] = [
  [
    {
      text: 'You hear a light wind up ahead.',
      safe: 'an air vent',
      hazard: 'an arrow trap',
    },
    {
      text: 'You hear light skittering.',
      safe: 'harmless beetles',
      hazard: 'poisonous spiders',
    },
    {
      text: 'You feel a light draft.',
      safe: 'loose stone',
      hazard: 'falling rubble',
    },
    {
      text: 'You notice fresh markings on the wall.',
      safe: 'old graffiti',
      hazard: 'a poison dart trap',
    },
    {
      text: 'You spot a faint glimmer ahead.',
      safe: 'a reflective mineral vein',
      hazard: 'a tripwire snare',
    },
  ],
  [
    {
      text: 'You smell something musty.',
      safe: 'old cloth',
      hazard: 'a toxic spore cloud',
    },
    {
      text: 'You hear a low groan.',
      safe: 'settling stone',
      hazard: 'a collapsing floor',
    },
    {
      text: 'You see disturbed dust on the floor.',
      safe: 'a recent draft',
      hazard: 'a pressure-plate trap',
    },
    {
      text: 'You hear faint clinking metal.',
      safe: 'a loose chain',
      hazard: 'a swinging blade trap',
    },
    {
      text: 'You hear distant footsteps.',
      safe: 'an echo',
      hazard: 'a prowling jackal pack',
    },
  ],
  [
    {
      text: 'You hear scuffling on the ground.',
      safe: 'a mouse',
      hazard: 'a mummy',
    },
    {
      text: 'You hear a deep hiss.',
      safe: 'a steam vent',
      hazard: 'a venomous cobra nest',
    },
    {
      text: 'You catch a whiff of decay.',
      safe: 'old bones',
      hazard: 'a plague rat swarm',
    },
    {
      text: 'You hear whispering echoes.',
      safe: 'wind through cracks',
      hazard: 'a cursed spirit',
    },
    {
      text: 'You feel the ground shift.',
      safe: 'uneven footing',
      hazard: 'a collapsing pit',
    },
  ],
]

export type Gamble = {text: string; action: string}

export const GAMBLES: readonly Gamble[] = [
  {
    text: 'A narrow crevice glints with something inside. Reach in?',
    action: 'Reach Inside',
  },
  {
    text: 'A loose floor tile looks pryable. Force it open?',
    action: 'Pry It Open',
  },
  {text: 'An old urn sits just off the path. Search it?', action: 'Search It'},
]
