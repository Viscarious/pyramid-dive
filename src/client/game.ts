import {
  type AbandonRsp,
  type EncounterResult,
  Endpoint,
  type ExtractRsp,
  type GambleOutcome,
  type HazardOutcome,
  type HubRsp,
  type LeaderboardRsp,
  type RelicsRsp,
  type ReportData,
} from '../shared/api.ts'
import {installErrorReporting} from './errorReporting.ts'

installErrorReporting('game')

// ---- Fetch helpers ----
// Errors are logged and surfaced as `undefined`, matching the template's
// fetch.ts pattern — callers bail out rather than throw into a click handler.
async function fetchJson<T>(
  endpoint: string,
  method: 'GET' | 'POST',
): Promise<T | undefined> {
  let rsp: Response
  try {
    rsp = await fetch(endpoint, {method, headers: {Accept: 'application/json'}})
  } catch (err) {
    console.error(`HTTP error: ${err instanceof Error ? err.message : err}`)
    return undefined
  }
  if (!rsp.ok) {
    const text = await rsp.text().catch(() => '')
    console.error(`HTTP status ${rsp.status}: ${rsp.statusText}; ${text}`)
    return undefined
  }
  return (await rsp.json()) as T
}

// ---- Run state ----
// depth/hp/gold/wards/banked/best/bestDepth are now server-authoritative —
// this object is a render cache of the server's last response, not a source
// of truth. ownedRelicTiers/equippedRelicTier stay local-only until the real
// Reddit flair integration lands (see CLAUDE_CODE_PROMPT.md item 6).
const state = {
  depth: 0,
  hp: 5,
  gold: 0,
  wards: 3,
  maxHp: 5,
  banked: 0,
  best: 0,
  bestDepth: 0,
  ownedRelicTiers: [] as number[],
  equippedRelicTier: null as number | null,
}

// Presentation-only asset routing — safe to keep client-side (not RNG,
// not spoiler-sensitive). The server never sends image/sfx paths, only the
// identifying data (hazard name, gold amount, gambleId) these are keyed by.
const HAZARD_IMAGES: Record<string, string> = {
  'an arrow trap': 'assets/hazard-arrow-trap.jpg',
  'poisonous spiders': 'assets/hazard-poisonous-spiders.jpg',
  'falling rubble': 'assets/hazard-falling-rubble.jpg',
  'a poison dart trap': 'assets/hazard-poison-dart-trap.jpg',
  'a tripwire snare': 'assets/hazard-tripwire-snare.jpg',
  'a toxic spore cloud': 'assets/hazard-toxic-spore-cloud.jpg',
  'a collapsing floor': 'assets/hazard-collapsing-floor.jpg',
  'a pressure-plate trap': 'assets/hazard-pressure-plate-trap.jpg',
  'a swinging blade trap': 'assets/hazard-swinging-blade-trap.jpg',
  'a prowling jackal pack': 'assets/hazard-prowling-jackal-pack.jpg',
  'a mummy': 'assets/hazard-mummy.jpg',
  'a venomous cobra nest': 'assets/hazard-venomous-cobra-nest.jpg',
  'a plague rat swarm': 'assets/hazard-plague-rat-swarm.jpg',
  'a cursed spirit': 'assets/hazard-cursed-spirit.jpg',
  'a collapsing pit': 'assets/hazard-collapsing-pit.jpg',
}
type GambleAssets = {img: string; backfireImg: string; sfxKey: string}
// Indexed by the server's `gambleId` (0-2) — order must match content.ts's
// GAMBLES pool (crevice, tile, urn).
const GAMBLE_ASSETS: GambleAssets[] = [
  {
    img: 'assets/gamble-crevice.jpg',
    backfireImg: 'assets/gamble-crevice-backfire.jpg',
    sfxKey: 'gambleHandInHole',
  },
  {
    img: 'assets/gamble-tile.jpg',
    backfireImg: 'assets/gamble-tile-backfire.jpg',
    sfxKey: 'gambleLiftTile',
  },
  {
    img: 'assets/gamble-urn.jpg',
    backfireImg: 'assets/gamble-urn-backfire.jpg',
    sfxKey: 'gambleBreakPot',
  },
]
function goldTierImg(amount: number): string {
  return amount <= 8
    ? 'assets/gold-small.jpg'
    : amount <= 12
      ? 'assets/gold-medium.jpg'
      : 'assets/gold-large.jpg'
}
function goldTierSfx(amount: number): string {
  return amount <= 8 ? 'goldSmall' : amount <= 12 ? 'goldMedium' : 'goldLarge'
}
const HAZARD_ENCOUNTER_SFX: Record<string, string> = {
  'an arrow trap': 'encounterArrowTrap',
  'poisonous spiders': 'encounterPoisonSpiders',
  'falling rubble': 'encounterFallingRubble',
  'a poison dart trap': 'encounterPoisonDart',
  'a tripwire snare': 'encounterTripwire',
  'a toxic spore cloud': 'encounterSporeCloud',
  'a collapsing floor': 'encounterCollapsingFloor',
  'a pressure-plate trap': 'encounterPressurePlate',
  'a swinging blade trap': 'encounterSwingingBlade',
  'a prowling jackal pack': 'encounterJackalPack',
  'a mummy': 'encounterMummy',
  'a venomous cobra nest': 'encounterCobraNest',
  'a plague rat swarm': 'encounterRatSwarm',
  'a cursed spirit': 'encounterCursedSpirit',
  'a collapsing pit': 'encounterCollapsingPit',
}

let pendingGambleId: number | null = null
// Stashed when a hazard/gamble resolution comes back fatal — Continue reads
// it to jump straight to the Dive Report without another round trip, since
// the server already computed the report at the moment of death.
let pendingReport: ReportData | null = null

const $ = (id: string) => document.getElementById(id) as HTMLElement
const screens = document.querySelectorAll<HTMLElement>('[data-screen]')
let currentScreenName: string | null = null
function showScreen(name: string): void {
  const prev = currentScreenName
  currentScreenName = name
  screens.forEach(el => {
    el.classList.toggle('is-active', el.dataset.screen === name)
  })
  // Looping reveal sounds only run while their screen is actually shown.
  if (prev === 'hazard_reveal' && name !== 'hazard_reveal')
    stopLoop('hazardReveal')
  if (prev === 'gamble_reveal' && name !== 'gamble_reveal')
    stopLoop('gambleSuspense')
  if (prev !== name) {
    $('hud-normal').style.display =
      name === 'report' ||
      name === 'hub' ||
      name === 'leaderboard' ||
      name === 'relic_shop'
        ? 'none'
        : ''
    $('hud-hub').style.display = name === 'hub' ? '' : 'none'
  }
  if (prev !== name) syncHubAmbience(name === 'hub')
  if (name === 'hub') renderHubFlair()
}

// ---- Transitions ----
// Both timed to match the source exactly: cover (750ms) -> switch content
// while fully covered -> hold (500ms) -> reveal (750ms) -> instant reset.
let descendTimer: ReturnType<typeof setTimeout> | undefined
function runDescendTransition(
  switchFn: () => void,
  onComplete?: () => void,
): void {
  clearTimeout(descendTimer)
  const overlay = $('descend-overlay')
  overlay.style.transition = 'transform 750ms cubic-bezier(.4,0,.2,1)'
  overlay.style.transform = 'translateY(0%)' // cover
  descendTimer = setTimeout(() => {
    switchFn() // content switches while fully covered
    descendTimer = setTimeout(() => {
      overlay.style.transition = 'transform 750ms cubic-bezier(.4,0,.2,1)'
      overlay.style.transform = 'translateY(100%)' // reveal
      descendTimer = setTimeout(() => {
        overlay.style.transition = 'none'
        overlay.style.transform = 'translateY(-100%)' // reset, off-screen above
        if (onComplete) onComplete() // fires only once fully revealed
      }, 750)
    }, 500)
  }, 750)
}

let hazardFadeTimer: ReturnType<typeof setTimeout> | undefined
function runActionFade(resolveFn: () => void | Promise<void>): void {
  clearTimeout(hazardFadeTimer)
  const top = $('hazard-fade-top')
  const bottom = $('hazard-fade-bottom')
  const left = $('hazard-fade-left')
  const right = $('hazard-fade-right')
  const hBars = [top, bottom]
  const wBars = [left, right]
  hBars.forEach(el => {
    el.style.transition = 'height 750ms ease'
  })
  wBars.forEach(el => {
    el.style.transition = 'width 750ms ease'
  })
  hBars.forEach(el => {
    el.style.height = '51%'
  })
  wBars.forEach(el => {
    el.style.width = '51%'
  }) // cover
  hazardFadeTimer = setTimeout(() => {
    ;[...hBars, ...wBars].forEach(el => {
      el.style.transition = 'none'
    }) // hold, no animation
    hazardFadeTimer = setTimeout(() => {
      void resolveFn() // outcome resolved while fully covered
      hBars.forEach(el => {
        el.style.transition = 'height 750ms ease'
      })
      wBars.forEach(el => {
        el.style.transition = 'width 750ms ease'
      })
      hBars.forEach(el => {
        el.style.height = '0%'
      })
      wBars.forEach(el => {
        el.style.width = '0%'
      }) // reveal
      hazardFadeTimer = setTimeout(() => {
        ;[...hBars, ...wBars].forEach(el => {
          el.style.transition = 'none'
        }) // reset
      }, 750)
    }, 500)
  }, 750)
}

// ---- Audio ----
// Real SFX manifest ported directly from the source's SFX_FILES/
// HAZARD_ENCOUNTER_SFX — same architecture too: one persistent, preloaded
// Audio element per key (reused via currentTime=0 + play(), not a fresh
// Audio() object per call). Also ports the source's "unlock on first
// pointerdown" workaround for browser autoplay policies.
const SFX_FILES: Record<string, string> = {
  hubAmbience: 'sfx/hubAmbience.mp3',
  pushDeeper: 'sfx/pushDeeper.wav',
  hazardReveal: 'sfx/hazardReveal.mp3',
  wardChosen: 'sfx/wardChosen.mp3',
  pushUnwarded: 'sfx/pushUnwarded.mp3',
  gambleLiftTile: 'sfx/gambleLiftTile.mp3',
  gambleBreakPot: 'sfx/gambleBreakPot.mp3',
  gambleHandInHole: 'sfx/gambleHandInHole.mp3',
  damageGeneric: 'sfx/damageGeneric.mp3',
  wardBlocked: 'sfx/wardBlocked.mp3',
  encounterArrowTrap: 'sfx/encounterArrowTrap.mp3',
  encounterPoisonSpiders: 'sfx/encounterPoisonSpiders.mp3',
  encounterFallingRubble: 'sfx/encounterFallingRubble.mp3',
  encounterPoisonDart: 'sfx/encounterPoisonDart.mp3',
  encounterTripwire: 'sfx/encounterTripwire.mp3',
  encounterSporeCloud: 'sfx/encounterSporeCloud.mp3',
  encounterCollapsingFloor: 'sfx/encounterCollapsingFloor.mp3',
  encounterPressurePlate: 'sfx/encounterPressurePlate.mp3',
  encounterSwingingBlade: 'sfx/encounterSwingingBlade.mp3',
  encounterJackalPack: 'sfx/encounterJackalPack.mp3',
  encounterMummy: 'sfx/encounterMummy.mp3',
  encounterCobraNest: 'sfx/encounterCobraNest.mp3',
  encounterRatSwarm: 'sfx/encounterRatSwarm.mp3',
  encounterCursedSpirit: 'sfx/encounterCursedSpirit.mp3',
  encounterCollapsingPit: 'sfx/encounterCollapsingPit.mp3',
  goldSmall: 'sfx/goldSmall.mp3',
  goldMedium: 'sfx/goldMedium.mp3',
  goldLarge: 'sfx/goldLarge.mp3',
  safeNeutral: 'sfx/safeNeutral.mp3',
  bannerGoldRush: 'sfx/bannerGoldRush.mp3',
  bannerBandLevelUp: 'sfx/bannerBandLevelUp.mp3',
  death: 'sfx/death.mp3',
  extractSuccess: 'sfx/extractSuccess.mp3',
  gambleSuspense: 'sfx/gambleSuspense.mp3',
  gamblePaidOff: 'sfx/gamblePaidOff.mp3',
  gambleBackfired: 'sfx/gambleBackfired.mp3',
}

const audioEls: Record<string, HTMLAudioElement> = {}
for (const [key, src] of Object.entries(SFX_FILES)) {
  const a = new Audio(src)
  a.preload = 'auto'
  audioEls[key] = a
}
function loopingEl(key: string): HTMLAudioElement {
  // biome-ignore lint/style/noNonNullAssertion: key is always one of the hard-coded looping SFX keys below
  return audioEls[key]!
}
loopingEl('hubAmbience').loop = true
loopingEl('hubAmbience').volume = 0.32
loopingEl('hazardReveal').loop = true
loopingEl('hazardReveal').volume = 0.5
loopingEl('gambleSuspense').loop = true
loopingEl('gambleSuspense').volume = 0.5

// Volume is a per-viewer convenience remembered across sessions —
// localStorage read/write is wrapped defensively since it can throw or be
// unavailable (private browsing, blocked site data).
const VOLUME_STORAGE_KEY = 'pyramidDive.volume'
function loadStoredVolumePercent(): number {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY)
    const n = raw === null ? Number.NaN : Number(raw)
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n
  } catch {}
  return 50
}
function saveStoredVolumePercent(percent: number): void {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(percent))
  } catch {}
}

let audioVolume = loadStoredVolumePercent() / 100
let audioMuted = false
function playSfx(key: string): void {
  if (audioMuted) return
  const a = audioEls[key]
  if (!a) return
  a.volume =
    a === audioEls.hubAmbience
      ? 0.32 * (audioVolume / 0.7)
      : a === audioEls.hazardReveal || a === audioEls.gambleSuspense
        ? 0.5 * (audioVolume / 0.7)
        : audioVolume
  try {
    a.currentTime = 0
    a.play().catch(() => {})
  } catch {}
}
function stopLoop(key: string): void {
  const a = audioEls[key]
  if (a) {
    a.pause()
    a.currentTime = 0
  }
}
// Hazard-outcome sound sequence: play the hazard-specific encounter sound,
// THEN chain into death/damage/wardBlocked once it ends.
function playSequence(firstKey: string | undefined, secondKey: string): void {
  if (audioMuted) {
    playSfx(secondKey)
    return
  }
  const first = firstKey && audioEls[firstKey]
  if (!first) {
    playSfx(secondKey)
    return
  }
  const onEnded = () => {
    first.removeEventListener('ended', onEnded)
    playSfx(secondKey)
  }
  first.addEventListener('ended', onEnded)
  first.volume = audioVolume
  try {
    first.currentTime = 0
    first.play().catch(() => {
      first.removeEventListener('ended', onEnded)
      playSfx(secondKey)
    })
  } catch {
    first.removeEventListener('ended', onEnded)
    playSfx(secondKey)
  }
}
function syncHubAmbience(onHub: boolean): void {
  if (audioMuted || !onHub) {
    stopLoop('hubAmbience')
    return
  }
  loopingEl('hubAmbience').volume = 0.32
  loopingEl('hubAmbience')
    .play()
    .catch(() => {})
}
function isHubActive(): boolean {
  return (
    document
      .querySelector('[data-screen="hub"]')
      ?.classList.contains('is-active') ?? false
  )
}
// Autoplay unlock: browsers block programmatic audio until a genuine user
// gesture occurs.
function unlockAudio(): void {
  syncHubAmbience(isHubActive())
  window.removeEventListener('pointerdown', unlockAudio)
}
window.addEventListener('pointerdown', unlockAudio)

const volumeSlider = $('volume-slider') as HTMLInputElement
volumeSlider.value = String(Math.round(audioVolume * 100))
volumeSlider.addEventListener('input', () => {
  audioVolume = Number(volumeSlider.value) / 100
  saveStoredVolumePercent(Number(volumeSlider.value))
  if (audioVolume > 0 && audioMuted) {
    audioMuted = false
    onIconEl().style.display = ''
    offIconEl().style.display = 'none'
    syncHubAmbience(isHubActive())
  }
})
function onIconEl(): HTMLElement {
  return $('icon-sound-on')
}
function offIconEl(): HTMLElement {
  return $('icon-sound-off')
}
$('mute-btn').addEventListener('click', () => {
  audioMuted = !audioMuted
  onIconEl().style.display = audioMuted ? 'none' : ''
  offIconEl().style.display = audioMuted ? '' : 'none'
  if (audioMuted) {
    for (const k of Object.keys(audioEls)) {
      // biome-ignore lint/style/noNonNullAssertion: k comes from Object.keys(audioEls)
      if (audioEls[k]!.loop) stopLoop(k)
    }
  } else syncHubAmbience(isHubActive())
})

function renderHud(): void {
  $('stat-depth').textContent = String(state.depth)
  $('stat-hp').textContent = String(Math.max(0, state.hp))
  $('stat-gold').textContent = String(state.gold)
  $('stat-wards').textContent = String(state.wards)
  $('stat-wards').classList.toggle('is-zero', state.wards <= 0)
  $('decision-gold').textContent = String(state.gold)
  $('modal-gold').textContent = String(state.gold)
  $('extract-modal-gold').textContent = String(state.gold)
  $('wards-left-text').textContent =
    state.wards <= 0 ? 'None remaining' : `${state.wards} remaining`
  ;($('ward-btn') as HTMLButtonElement).disabled = state.wards <= 0
  $('hud-hub-banked').textContent = String(state.banked)
  $('hud-hub-best').textContent = String(state.best)
}

function hideAllBanners(): void {
  ;[
    'decision-band-banner',
    'decision-milestone-banner',
    'hazard-band-banner',
    'gamble-band-banner',
    'outcome-milestone-banner',
  ].forEach(id => {
    $(id).style.display = 'none'
  })
  $('decision-flash').style.display = 'none'
  $('decision-img').style.display = ''
}
function showBandBanner(screenPrefix: string): void {
  $(`${screenPrefix}-band-banner-text`).textContent = 'Threat level up'
  $(`${screenPrefix}-band-banner`).style.display = ''
}
function showMilestoneBanner(screenPrefix: string, goldText: number): void {
  $(`${screenPrefix}-milestone-banner-text`).textContent =
    `Milestone — ${goldText} gold collected!`
  $(`${screenPrefix}-milestone-banner`).style.display = ''
}

// ---- Hub -> Decision ----
// Renders whatever the server resolved for the current depth — the type
// branch here is presentation only, the RNG that picked the type already
// happened server-side (see engine.ts's rollEncounter).
let pendingRevealSound: (() => void) | null = null
function renderEncounter(result: EncounterResult): void {
  hideAllBanners()
  state.depth = result.hud.depth
  state.hp = result.hud.hp
  state.gold = result.hud.gold
  state.wards = result.hud.wards

  if (result.type === 'treasure') {
    ;($('decision-flash-img') as HTMLImageElement).src = goldTierImg(
      result.amount,
    )
    $('decision-flash-text').textContent = `You found ${result.amount} gold.`
    $('decision-flash').style.display = ''
    $('decision-img').style.display = 'none'
    if (result.bandJustChanged) showBandBanner('decision')
    if (result.milestoneHit) showMilestoneBanner('decision', state.gold)
    renderHud()
    showScreen('decision')
    pendingRevealSound = () => {
      playSfx(goldTierSfx(result.amount))
      if (result.bandJustChanged) playSfx('bannerBandLevelUp')
    }
  } else if (result.type === 'hazard') {
    $('telegraph-text').textContent = `“${result.telegraphText}”`
    if (result.bandJustChanged) showBandBanner('hazard')
    renderHud()
    showScreen('hazard_reveal')
    pendingRevealSound = () => {
      playSfx('hazardReveal') // loops; stopped when leaving this screen
      if (result.bandJustChanged) playSfx('bannerBandLevelUp')
    }
  } else {
    pendingGambleId = result.gambleId
    // biome-ignore lint/style/noNonNullAssertion: gambleId always indexes GAMBLE_ASSETS
    const assets = GAMBLE_ASSETS[result.gambleId]!
    ;($('gamble-img') as HTMLImageElement).src = assets.img
    $('gamble-prompt').textContent = result.promptText
    $('gamble-action-text').textContent = result.actionLabel
    if (result.bandJustChanged) showBandBanner('gamble')
    renderHud()
    showScreen('gamble_reveal')
    pendingRevealSound = () => {
      playSfx('gambleSuspense') // loops; stopped when leaving this screen
      if (result.bandJustChanged) playSfx('bannerBandLevelUp')
    }
  }
}
function playPendingRevealSound(): void {
  if (pendingRevealSound) {
    pendingRevealSound()
    pendingRevealSound = null
  }
}

$('enter-pyramid-btn').addEventListener('click', async () => {
  playSfx('pushDeeper')
  const result = await fetchJson<EncounterResult>(Endpoint.RunEnter, 'POST')
  if (!result) return
  runDescendTransition(() => renderEncounter(result), playPendingRevealSound)
})

$('push-deeper-btn').addEventListener('click', async () => {
  playSfx('pushDeeper')
  const result = await fetchJson<EncounterResult>(Endpoint.RunPush, 'POST')
  if (!result) return
  runDescendTransition(() => renderEncounter(result), playPendingRevealSound)
})

// ---- Extract (with confirmation, matching Abandon's pattern) ----
$('extract-btn').addEventListener('click', () => {
  $('extract-modal').style.display = 'flex'
})
$('extract-modal-keep-btn').addEventListener('click', () => {
  $('extract-modal').style.display = 'none'
})
$('extract-modal-confirm-btn').addEventListener('click', async () => {
  $('extract-modal').style.display = 'none'
  const result = await fetchJson<ExtractRsp>(Endpoint.RunExtract, 'POST')
  if (!result) return
  playSfx('extractSuccess')
  state.banked = result.profile.banked
  state.best = result.profile.best
  state.bestDepth = result.profile.bestDepth
  state.gold = result.hud.gold
  renderReport(result.report)
})

// ---- Hazard telegraph -> Outcome ----
// hazardPresent duality: the telegraph doesn't guarantee real danger —
// there's a real % chance (band-scaled) it's a false alarm, for both Ward
// and Push Unwarded. kind is 'neutral' for BOTH warded branches; hazardName
// is only set when the hazard is real, which is what the sound sequence
// keys off.
type Outcome = {
  img: string | null
  label: string
  text: string
  deltaText?: string
  kind: 'neutral' | 'damage' | 'gold'
  fatal?: boolean
  hazardName?: string
  amount?: number
  milestoneHit?: boolean
  milestoneGold?: number
}

async function resolveHazard(useWard: boolean): Promise<void> {
  const result = await fetchJson<HazardOutcome>(
    useWard ? Endpoint.RunWard : Endpoint.RunPushUnwarded,
    'POST',
  )
  if (!result) return
  state.depth = result.hud.depth
  state.hp = result.hud.hp
  state.gold = result.hud.gold
  state.wards = result.hud.wards
  if (result.fatal && result.report) pendingReport = result.report

  let outcome: Outcome
  if (useWard) {
    outcome = result.hazardPresent
      ? {
          // biome-ignore lint/style/noNonNullAssertion: hazardPresent implies hazardName is set
          img: HAZARD_IMAGES[result.hazardName!] ?? null,
          label: 'Warded',
          text: `${result.hazardName}. Your ward held.`,
          deltaText: 'Ward spent — no damage',
          kind: 'neutral',
          hazardName: result.hazardName,
        }
      : {
          img: null,
          label: 'Warded',
          text: `It was nothing — just ${result.safeName}.`,
          deltaText: 'Ward spent',
          kind: 'neutral',
        }
  } else if (result.hazardPresent) {
    outcome = {
      // biome-ignore lint/style/noNonNullAssertion: hazardPresent implies hazardName is set
      img: HAZARD_IMAGES[result.hazardName!] ?? null,
      label: 'Unwarded',
      text: `${result.hazardName}!`,
      deltaText: `-${result.damage} HP`,
      kind: 'damage',
      fatal: result.fatal,
      hazardName: result.hazardName,
    }
  } else {
    outcome = {
      img: null,
      label: 'Unwarded',
      text: `It was nothing — just ${result.safeName}.`,
      deltaText: 'No harm done',
      kind: 'neutral',
    }
  }
  showOutcome(outcome)
}
$('ward-btn').addEventListener('click', () => {
  playSfx('wardChosen')
  runActionFade(() => void resolveHazard(true))
})
$('push-unwarded-btn').addEventListener('click', () => {
  playSfx('pushUnwarded')
  runActionFade(() => void resolveHazard(false))
})

// ---- Gamble -> Outcome ----
// Leave It skips Outcome entirely (straight back to Decision, no sound,
// no fade, no server call needed — nothing was resolved).
$('gamble-risk-btn').addEventListener('click', () => {
  if (pendingGambleId === null) return
  // biome-ignore lint/style/noNonNullAssertion: pendingGambleId always indexes GAMBLE_ASSETS
  const assets = GAMBLE_ASSETS[pendingGambleId]!
  playSfx(assets.sfxKey) // the specific action sound, immediate on click
  runActionFade(async () => {
    const result = await fetchJson<GambleOutcome>(
      Endpoint.RunGambleRisk,
      'POST',
    )
    if (!result) return
    state.depth = result.hud.depth
    state.hp = result.hud.hp
    state.gold = result.hud.gold
    state.wards = result.hud.wards
    if (result.fatal && result.report) pendingReport = result.report

    if (result.success) {
      showOutcome({
        img: goldTierImg(result.amount ?? 0),
        label: 'Paid off',
        text: 'Your gamble pays off handsomely.',
        deltaText: `+${result.amount} gold`,
        kind: 'gold',
        amount: result.amount,
        milestoneHit: result.milestoneHit,
        milestoneGold: state.gold,
      })
    } else {
      showOutcome({
        img: assets.backfireImg,
        label: 'Backfired',
        text: 'It was a trap in disguise.',
        deltaText: `-${result.damage} HP`,
        kind: 'damage',
        fatal: result.fatal,
      })
    }
  })
})
$('gamble-leave-btn').addEventListener('click', () => {
  hideAllBanners()
  renderHud()
  showScreen('decision')
})

// ---- Outcome rendering ----
// outcomeKindDamage and outcomeFatal are independent: a fatal hit still
// shows the hazard image, plus the YOU DIED mark on top of it — never hide
// the scene image on death. A null img (false-alarm hazard) falls back to
// the safe-passage art.
function showOutcome(o: Outcome): void {
  const card = $('outcome-card')
  card.classList.toggle('game-card--fatal', !!o.fatal)
  ;($('outcome-img') as HTMLImageElement).src =
    o.img || 'assets/safe-passage.jpg'
  $('outcome-death').style.display = o.fatal ? 'flex' : 'none'
  $('outcome-abandon-link').style.display = o.fatal ? 'none' : ''
  $('outcome-label').textContent = o.fatal ? '' : o.label
  $('outcome-label').style.color = o.fatal
    ? 'var(--color-red)'
    : 'var(--color-ink)'
  $('outcome-text').textContent = o.text
  $('outcome-text').style.color = o.fatal
    ? 'var(--color-bg-parchment-hi)'
    : 'var(--color-ink)'

  const deltaEl = $('outcome-delta')
  if (o.deltaText) {
    deltaEl.style.display = ''
    deltaEl.textContent = o.deltaText
    deltaEl.style.color =
      o.kind === 'gold'
        ? 'var(--color-gold-shadow)'
        : o.kind === 'damage'
          ? 'var(--color-red)'
          : '#5c4a30'
  } else {
    deltaEl.style.display = 'none'
  }
  if (o.milestoneHit && o.milestoneGold !== undefined)
    showMilestoneBanner('outcome', o.milestoneGold)
  else $('outcome-milestone-banner').style.display = 'none'

  if (o.label === 'Paid off') playSfx('gamblePaidOff')
  else if (o.label === 'Backfired') playSfx(o.fatal ? 'death' : 'damageGeneric')
  else if (o.hazardName)
    playSequence(
      HAZARD_ENCOUNTER_SFX[o.hazardName],
      o.fatal ? 'death' : o.kind === 'damage' ? 'damageGeneric' : 'wardBlocked',
    )
  else if (o.kind === 'gold') playSfx(goldTierSfx(o.amount ?? 0))
  else if (o.kind === 'damage') playSfx(o.fatal ? 'death' : 'damageGeneric')
  else if (o.kind === 'neutral') playSfx('safeNeutral')

  renderHud()
  showScreen('outcome')
}

$('continue-btn').addEventListener('click', () => {
  if (pendingReport) {
    // Fatal — routes to the Dive Report (status 'died'), not straight back
    // to Hub. The server already computed this report at the moment of
    // death, so no extra round trip is needed here.
    renderReport(pendingReport)
    pendingReport = null
    return
  }
  hideAllBanners()
  renderHud()
  showScreen('decision')
})

// ---- Dive Report ----
// Highlight rules: each condition is independent, first two matches shown,
// with a generic fallback line if none apply. All the underlying numbers
// (isNewBest, minHp, hazardsFaced, hazardsWarded) come from the server now.
function renderReport(report: ReportData): void {
  const highlights: {text: string; color: string}[] = []
  if (report.isNewBest)
    highlights.push({
      text: 'New personal best depth!',
      color: 'var(--color-teal)',
    })
  if (report.status === 'extracted' && report.minHp <= 2)
    highlights.push({
      text: `Narrow escape — dropped to ${report.minHp} HP`,
      color: 'var(--color-red)',
    })
  if (report.hazardsWarded === report.wardsMax && report.hazardsFaced > 0)
    highlights.push({
      text: 'Used every ward this run',
      color: 'var(--color-ink)',
    })
  if (highlights.length === 0)
    highlights.push({
      text: `${report.hazardsFaced} hazard${report.hazardsFaced === 1 ? '' : 's'} faced along the way.`,
      color: 'var(--color-ink)',
    })

  $('report-headline').textContent =
    report.status === 'extracted'
      ? `Extracted at depth ${report.depth} with ${report.goldAmount} gold.`
      : `Fell at depth ${report.depth}. Lost ${report.goldAmount} gold.`

  const highlightsEl = $('report-highlights')
  highlightsEl.innerHTML = ''
  highlights.slice(0, 2).forEach(hl => {
    const div = document.createElement('div')
    div.className = 'report-highlight'
    div.style.color = hl.color
    div.textContent = hl.text
    highlightsEl.appendChild(div)
  })

  $('report-depth').textContent = String(report.depth)
  $('report-hazards-faced').textContent = String(report.hazardsFaced)
  $('report-wards-used').textContent =
    `${report.hazardsWarded} / ${report.wardsMax}`
  $('report-banked').textContent = String(report.banked)
  $('report-best-haul').textContent =
    report.best > 0 ? `${report.best} @ depth ${report.bestDepth}` : '0'

  state.banked = report.banked
  state.best = report.best
  state.bestDepth = report.bestDepth
  state.gold = 0
  renderHud()
  showScreen('report')
}

$('report-share-btn').addEventListener('click', () => {
  const note = $('share-note')
  note.style.display = ''
  clearTimeout(
    (window as unknown as {__shareTimer?: ReturnType<typeof setTimeout>})
      .__shareTimer,
  )
  ;(
    window as unknown as {__shareTimer?: ReturnType<typeof setTimeout>}
  ).__shareTimer = setTimeout(() => {
    note.style.display = 'none'
  }, 2400)
})
$('report-hub-btn').addEventListener('click', () => showScreen('hub'))
$('report-new-run-btn').addEventListener('click', () => {
  $('enter-pyramid-btn').dispatchEvent(new MouseEvent('click'))
})

// ---- Leaderboard ----
// Real per-subreddit Redis-backed ranking (CLAUDE_CODE_PROMPT.md item 5) —
// best single-run gold, depth as tiebreaker. See engine.ts's getLeaderboard().
let leaderboardPageIdx = 0
let leaderboardTotalPages = 1

async function goLeaderboard(): Promise<void> {
  leaderboardPageIdx = 0
  showScreen('leaderboard')
  await loadLeaderboardPage()
}

async function loadLeaderboardPage(): Promise<void> {
  const rsp = await fetchJson<LeaderboardRsp>(
    `${Endpoint.Leaderboard}?page=${leaderboardPageIdx}`,
    'GET',
  )
  if (!rsp) return
  leaderboardTotalPages = rsp.totalPages

  const rowsEl = $('lb-rows')
  rowsEl.innerHTML = ''
  rsp.rows.forEach(row => {
    const div = document.createElement('div')
    div.className = 'lb-row'
    div.innerHTML = `
      <div class="lb-row-left">
        <span class="lb-rank">#${row.rank}</span>
        <span class="lb-name">${row.username}</span>
      </div>
      <div class="lb-row-right">
        <span class="lb-depth-badge">depth ${row.depth}</span>
        <span class="lb-gold">${row.gold}g</span>
      </div>`
    rowsEl.appendChild(div)
  })

  $('lb-page-label').textContent =
    `Page ${leaderboardPageIdx + 1} of ${leaderboardTotalPages}`
  ;($('lb-prev-btn') as HTMLButtonElement).disabled = leaderboardPageIdx <= 0
  $('lb-prev-btn').style.opacity = leaderboardPageIdx > 0 ? '1' : '0.4'
  ;($('lb-next-btn') as HTMLButtonElement).disabled =
    leaderboardPageIdx >= leaderboardTotalPages - 1
  $('lb-next-btn').style.opacity =
    leaderboardPageIdx < leaderboardTotalPages - 1 ? '1' : '0.4'

  $('lb-you-card').style.display = rsp.you ? '' : 'none'
  if (rsp.you) {
    $('lb-you-rank').textContent = `Rank #${rsp.you.rank}`
    $('lb-you-depth').textContent = `depth ${rsp.you.depth}`
    $('lb-you-gold').textContent = `${rsp.you.gold}g`
  }
}

$('lb-prev-btn').addEventListener('click', () => {
  if (leaderboardPageIdx > 0) {
    leaderboardPageIdx -= 1
    void loadLeaderboardPage()
  }
})
$('lb-next-btn').addEventListener('click', () => {
  if (leaderboardPageIdx < leaderboardTotalPages - 1) {
    leaderboardPageIdx += 1
    void loadLeaderboardPage()
  }
})
$('lb-back-btn').addEventListener('click', () => showScreen('hub'))

// ---- Relic Shop ----
// Still fully local/ephemeral — real Reddit flair integration is a later
// phase (CLAUDE_CODE_PROMPT.md item 6). Roster/prices ported verbatim from
// the source's FLAIR_TIERS, matching the design doc's locked roster.
type RelicTier = {tier: number; price: number; name: string; icon: string}
const RELIC_TIERS: RelicTier[] = [
  {
    tier: 1,
    price: 150,
    name: 'Bronze Scarab',
    icon: 'assets/relics/01_bronze_scarab_charm.png',
  },
  {
    tier: 2,
    price: 400,
    name: 'Silver Scarab',
    icon: 'assets/relics/02_silver_scarab_charm.png',
  },
  {
    tier: 3,
    price: 650,
    name: 'Gold Scarab',
    icon: 'assets/relics/03_gold_scarab_charm.png',
  },
  {
    tier: 4,
    price: 950,
    name: 'Lapis Scarab',
    icon: 'assets/relics/04_lapis_scarab_charm.png',
  },
  {
    tier: 5,
    price: 1300,
    name: 'Clay Ankh',
    icon: 'assets/relics/05_clay_ankh_ward.png',
  },
  {
    tier: 6,
    price: 1700,
    name: 'Copper Ankh',
    icon: 'assets/relics/06_copper_ankh_ward.png',
  },
  {
    tier: 7,
    price: 2100,
    name: 'Gold Ankh',
    icon: 'assets/relics/07_gold_ankh_ward.png',
  },
  {
    tier: 8,
    price: 2600,
    name: 'Radiant Ankh',
    icon: 'assets/relics/08_radiant_ankh_ward.png',
  },
  {
    tier: 9,
    price: 3100,
    name: 'Stone Eye of Horus',
    icon: 'assets/relics/09_stone_eye_of_horus_sigil.png',
  },
  {
    tier: 10,
    price: 3650,
    name: 'Silver Eye of Horus',
    icon: 'assets/relics/10_silver_eye_of_horus_sigil.png',
  },
  {
    tier: 11,
    price: 4300,
    name: 'Gold Eye of Horus',
    icon: 'assets/relics/11_gold_eye_of_horus_sigil.png',
  },
  {
    tier: 12,
    price: 4900,
    name: 'Sacred Eye of Horus',
    icon: 'assets/relics/12_sacred_eye_of_horus_sigil.png',
  },
  {
    tier: 13,
    price: 5600,
    name: 'Uraeus Diadem',
    icon: 'assets/relics/13_uraeus_diadem.png',
  },
  {
    tier: 14,
    price: 6350,
    name: 'Nemes Headpiece',
    icon: 'assets/relics/14_nemes_headpiece.png',
  },
  {
    tier: 15,
    price: 7100,
    name: 'Royal Collar',
    icon: 'assets/relics/15_royal_collar.png',
  },
  {
    tier: 16,
    price: 7900,
    name: 'Golden Crook',
    icon: 'assets/relics/16_golden_crook.png',
  },
  {
    tier: 17,
    price: 8750,
    name: 'Sundisk Pendant',
    icon: 'assets/relics/17_sundisk_pendant.png',
  },
  {
    tier: 18,
    price: 9650,
    name: 'Obsidian Sphinx',
    icon: 'assets/relics/18_obsidian_sphinx.png',
  },
  {
    tier: 19,
    price: 10600,
    name: 'Bennu Feather',
    icon: 'assets/relics/19_bennu_feather.png',
  },
  {
    tier: 20,
    price: 11600,
    name: 'Eternal Flame Crown',
    icon: 'assets/relics/20_eternal_flame_crown.png',
  },
]

function renderHubFlair(): void {
  const t = RELIC_TIERS.find(x => x.tier === state.equippedRelicTier)
  $('hub-flair-row').style.display = t ? '' : 'none'
  if (t) {
    ;($('hub-flair-icon') as HTMLImageElement).src = t.icon
    ;($('hub-flair-icon') as HTMLImageElement).alt = t.name
    $('hub-flair-label').textContent = t.name
  }
}

function goRelicShop(): void {
  renderRelicShop()
  showScreen('relic_shop')
}

// Reddit's flair API is text/color only (no custom icon upload), so the
// real flair badge shows the relic's name — our own art stays in-app only.
// See engine.ts's applyFlair/removeFlair.
async function applyRelicsRsp(rsp: RelicsRsp | undefined): Promise<void> {
  if (!rsp) return
  state.ownedRelicTiers = rsp.relics.owned
  state.equippedRelicTier = rsp.relics.equipped
  state.banked = rsp.banked
  renderHud()
  renderRelicShop()
  renderHubFlair()
}

function renderRelicShop(): void {
  $('rs-banked').textContent = `banked: ${state.banked}g`
  const rowsEl = $('rs-rows')
  rowsEl.innerHTML = ''
  RELIC_TIERS.forEach(t => {
    const owned = state.ownedRelicTiers.includes(t.tier)
    const equipped = state.equippedRelicTier === t.tier
    const affordable = state.banked >= t.price

    const row = document.createElement('div')
    row.className = `rs-row${equipped ? ' rs-row--equipped' : ''}`

    const left = document.createElement('div')
    left.className = 'rs-row-left'
    left.innerHTML = `
      <img class="rs-icon" src="${t.icon}" alt="${t.name}">
      <div class="rs-name-block">${t.name}<span class="rs-tier-label">Relic Tier ${t.tier}</span></div>`
    row.appendChild(left)

    const btn = document.createElement('button')
    btn.className = 'rs-action-btn'
    if (equipped) {
      btn.className += ' rs-btn-unequip'
      btn.textContent = 'Unequip'
      btn.addEventListener('click', () => {
        void fetchJson<RelicsRsp>(Endpoint.RelicsUnequip, 'POST').then(
          applyRelicsRsp,
        )
      })
    } else if (owned) {
      btn.className += ' rs-btn-equip'
      btn.textContent = 'Equip'
      btn.addEventListener('click', () => {
        void fetchJson<RelicsRsp>(
          `${Endpoint.RelicsEquip}?tier=${t.tier}`,
          'POST',
        ).then(applyRelicsRsp)
      })
    } else {
      btn.className += ' rs-btn-buy'
      btn.textContent = `${t.price}g`
      ;(btn as HTMLButtonElement).disabled = !affordable
      btn.addEventListener('click', () => {
        void fetchJson<RelicsRsp>(
          `${Endpoint.RelicsBuy}?tier=${t.tier}`,
          'POST',
        ).then(applyRelicsRsp)
      })
    }
    row.appendChild(btn)
    rowsEl.appendChild(row)
  })
}

$('relic-shop-btn').addEventListener('click', goRelicShop)
$('rs-back-btn').addEventListener('click', () => showScreen('hub'))

$('leaderboard-btn').addEventListener('click', goLeaderboard)
$('report-leaderboard-btn').addEventListener('click', goLeaderboard)

// ---- Abandon ----
document.querySelectorAll('[data-abandon]').forEach(btn => {
  btn.addEventListener('click', () => {
    $('abandon-modal').style.display = 'flex'
  })
})
$('modal-keep-btn').addEventListener('click', () => {
  $('abandon-modal').style.display = 'none'
})
$('modal-abandon-btn').addEventListener('click', async () => {
  const result = await fetchJson<AbandonRsp>(Endpoint.RunAbandon, 'POST')
  $('abandon-modal').style.display = 'none'
  if (result) {
    state.gold = result.hud.gold
    state.depth = result.hud.depth
  }
  renderHud()
  showScreen('hub')
})

// ---- Debug: jump to screen ----
$('debug-open-btn').addEventListener('click', () =>
  $('debug-panel').classList.add('is-open'),
)
$('debug-close-btn').addEventListener('click', () =>
  $('debug-panel').classList.remove('is-open'),
)

document.querySelectorAll<HTMLButtonElement>('.debug-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.debug-tab-btn').forEach(b => {
      b.classList.toggle('is-active', b === btn)
    })
    document.querySelectorAll<HTMLElement>('.debug-tab-panel').forEach(p => {
      p.classList.toggle('is-active', p.dataset.tabPanel === btn.dataset.tab)
    })
  })
})

// Populate the SFX test grid from the real manifest — every key is playable directly.
const sfxGrid = $('debug-sfx-grid')
// Display label strips the redundant category prefix (encounter/banner/
// gamble) so long names fit one line in a 2-column layout.
function shortSfxLabel(key: string): string {
  return (
    key
      .replace(/^(encounter|banner|gamble)/, () => '')
      .replace(/^./, c => c.toUpperCase()) || key
  )
}
Object.keys(SFX_FILES).forEach(key => {
  const btn = document.createElement('button')
  btn.className = 'debug-jump-btn'
  btn.textContent = shortSfxLabel(key)
  btn.title = key
  btn.addEventListener('click', () => playSfx(key))
  sfxGrid.appendChild(btn)
})

// Gold debug buttons mutate local state only — banked is server-authoritative
// now, so these are for quick visual QA and won't survive a Hub reload.
document.querySelectorAll<HTMLButtonElement>('[data-gold]').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.gold
    if (v === 'clear') state.gold = 0
    else if (v === 'banked-clear') state.banked = 0
    else if (v === 'full-hp') state.hp = state.maxHp
    else state.banked += Number(v)
    renderHud()
    if (currentScreenName === 'relic_shop') renderRelicShop()
  })
})

document.querySelectorAll<HTMLButtonElement>('[data-jump]').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.jump
    $('debug-panel').classList.remove('is-open')
    if (target === 'outcome_safe') {
      showOutcome({
        img: 'assets/safe-passage.jpg',
        label: 'Warded',
        text: 'It was nothing — just an air vent.',
        kind: 'neutral',
      })
    } else if (target === 'outcome_damage') {
      showOutcome({
        img: 'assets/hazard-arrow-trap.jpg',
        label: 'Unwarded',
        text: 'an arrow trap!',
        deltaText: '-3 HP',
        kind: 'damage',
        fatal: false,
        hazardName: 'an arrow trap',
      })
    } else if (target === 'outcome_gold') {
      showOutcome({
        img: 'assets/gold-large.jpg',
        label: 'Paid off',
        text: 'Your gamble pays off handsomely.',
        deltaText: '+14 gold',
        kind: 'gold',
        amount: 14,
      })
    } else if (target === 'outcome_fatal') {
      showOutcome({
        img: 'assets/hazard-poisonous-spiders.jpg',
        label: 'Unwarded',
        text: 'poisonous spiders!',
        deltaText: '-5 HP',
        kind: 'damage',
        fatal: true,
        hazardName: 'poisonous spiders',
      })
    } else if (target === 'report_extracted') {
      renderReport({
        status: 'extracted',
        depth: 3,
        goldAmount: 14,
        hazardsFaced: 2,
        hazardsWarded: 1,
        isNewBest: false,
        minHp: 3,
        wardsMax: 3,
        banked: state.banked + 14,
        best: Math.max(state.best, 14),
        bestDepth: state.best >= 14 ? state.bestDepth : 3,
      })
    } else if (target === 'report_died') {
      renderReport({
        status: 'died',
        depth: 4,
        goldAmount: 9,
        hazardsFaced: 3,
        hazardsWarded: 2,
        isNewBest: false,
        minHp: 0,
        wardsMax: 3,
        banked: state.banked,
        best: state.best,
        bestDepth: state.bestDepth,
      })
    } else if (target === 'leaderboard') {
      void goLeaderboard()
    } else if (target === 'relic_shop') {
      goRelicShop()
    } else if (target === 'hazard_reveal') {
      $('telegraph-text').textContent = '“You hear a light wind up ahead.”'
      showScreen('hazard_reveal')
    } else if (target === 'gamble_reveal') {
      pendingGambleId = 0
      // biome-ignore lint/style/noNonNullAssertion: GAMBLE_ASSETS always has index 0
      ;($('gamble-img') as HTMLImageElement).src = GAMBLE_ASSETS[0]!.img
      $('gamble-prompt').textContent =
        'A narrow crevice glints with something inside. Reach in?'
      $('gamble-action-text').textContent = 'Reach Inside'
      showScreen('gamble_reveal')
    } else if (target) {
      showScreen(target)
    }
  })
})

// ---- Init ----
async function init(): Promise<void> {
  renderHud()
  showScreen('hub')
  const hub = await fetchJson<HubRsp>(Endpoint.Hub, 'GET')
  if (hub) {
    state.banked = hub.profile.banked
    state.best = hub.profile.best
    state.bestDepth = hub.profile.bestDepth
    state.ownedRelicTiers = hub.relics.owned
    state.equippedRelicTier = hub.relics.equipped
    if (hub.debugEnabled) $('debug-open-btn').style.display = 'block'
    renderHud()
    renderHubFlair()
  }
}
void init()
