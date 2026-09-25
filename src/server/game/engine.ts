import {reddit} from '@devvit/web/server'
import type {T2} from '@devvit/web/shared'
import type {
  DebugGoldRsp,
  EncounterResult,
  ExtractResult,
  GambleOutcome,
  HazardOutcome,
  HubRsp,
  HudState,
  LeaderboardRsp,
  Profile,
  RelicsRsp,
  ReportData,
} from '../../shared/api.ts'
import {GAMBLES, TELEGRAPHS} from './content.ts'
import {
  BAND_LABELS,
  bandFor,
  PARAMS,
  STARTING_HP,
  STARTING_WARDS,
} from './params.ts'
import {relicTier} from './relics.ts'
import {
  dailySeed,
  rollIndex,
  rollInt,
  rollPercent,
  runNonce,
  todayUtc,
} from './rng.ts'
import {
  type ActiveRun,
  acquireUserLock,
  checkRateLimit,
  clearActiveRun,
  getActiveRun,
  getLeaderboardCount,
  getLeaderboardPage,
  getLeaderboardRank,
  getProfile,
  getRelics,
  releaseUserLock,
  setActiveRun,
  setProfile,
  setRelics,
  submitToLeaderboard,
} from './store.ts'
import {
  reportAppReady,
  reportBandProgress,
  reportInteraction,
  reportJourneyEnd,
  startJourney,
} from './telemetry.ts'

export class GameError extends Error {}

// Every mutating action below does read-Redis -> check -> modify -> write,
// which isn't atomic on its own — see store.ts's acquireUserLock for what
// that opens up (concurrent requests double-crediting the same gold, etc.)
// and why this wrapper exists. It also enforces a minimum interval between
// a single user's mutating actions (checkRateLimit) — the lock alone stops
// concurrent duplication but does nothing to stop a scripted client
// hammering an endpoint sequentially as fast as the network allows. Every
// exported mutating function is wrapped with this before it's used anywhere.
//
// Run actions (descend/extract/wards/gambles) go through client-side
// animation transitions of ~2s between clicks, so the rate limit is
// invisible to real play there. The relic shop has no such throttle — buy
// then immediately equip a different owned tier is a normal, expected
// click sequence well under 1s — so those pass rateLimit: false and rely
// on the lock alone for atomicity.
function withUserLock<A extends unknown[], R>(
  fn: (userId: T2, ...args: A) => Promise<R>,
  opts: {rateLimit: boolean} = {rateLimit: true},
): (userId: T2, ...args: A) => Promise<R> {
  return async (userId, ...args) => {
    if (opts.rateLimit) {
      const withinRateLimit = await checkRateLimit(userId)
      if (!withinRateLimit) {
        throw new GameError('slow down — try again in a moment')
      }
    }
    const acquired = await acquireUserLock(userId)
    if (!acquired) {
      throw new GameError('another action is already in progress — try again')
    }
    try {
      return await fn(userId, ...args)
    } finally {
      await releaseUserLock(userId)
    }
  }
}

function hud(run: ActiveRun): HudState {
  return {
    depth: run.depth,
    hp: Math.max(0, run.hp),
    gold: run.gold,
    wards: run.wards,
  }
}

function freshRun(): ActiveRun {
  return {
    active: true,
    depth: 0,
    hp: STARTING_HP,
    gold: 0,
    wards: STARTING_WARDS,
    hazardsFaced: 0,
    hazardsWarded: 0,
    minHp: STARTING_HP,
    lastBand: 0,
    pendingType: null,
    journeyId: '',
    runSeed: runNonce(),
  }
}

// Ported directly from the client prototype's advanceEncounter(): depth
// increments here (once per push), then rolls the real treasure/hazard/
// gamble mix with band-scaled ranges — now against the deterministic
// per-user-per-day seed instead of Math.random().
function rollEncounter(seed: string, run: ActiveRun): EncounterResult {
  run.depth += 1
  const depth = run.depth
  const band = bandFor(depth)
  const bandJustChanged = band > run.lastBand
  if (bandJustChanged) run.lastBand = band
  const bandLabel = BAND_LABELS[band]

  const mix = PARAMS.mix[band]
  const roll = rollPercent(seed, depth, 'type')

  if (roll < mix.treasure) {
    const prevGold = run.gold
    const [lo, hi] = PARAMS.treasure[band]
    const amount = rollInt(seed, depth, 'amount', lo, hi)
    run.gold += amount
    const milestoneHit = Math.floor(run.gold / 100) > Math.floor(prevGold / 100)
    run.pendingType = 'treasure'
    return {
      type: 'treasure',
      amount,
      milestoneHit,
      bandJustChanged,
      bandLabel,
      hud: hud(run),
    }
  }

  if (roll < mix.treasure + mix.hazard) {
    // biome-ignore lint/style/noNonNullAssertion: Math.min(band,2) is always a valid TELEGRAPHS index
    const pool = TELEGRAPHS[Math.min(band, 2)]!
    const idx = rollIndex(seed, depth, 'telegraph', pool.length)
    run.pendingType = 'hazard'
    return {
      type: 'hazard',
      // biome-ignore lint/style/noNonNullAssertion: idx is always < pool.length
      telegraphText: pool[idx]!.text,
      bandJustChanged,
      bandLabel,
      hud: hud(run),
    }
  }

  const gambleId = rollIndex(seed, depth, 'gamblePick', GAMBLES.length)
  // biome-ignore lint/style/noNonNullAssertion: gambleId is always < GAMBLES.length
  const gamble = GAMBLES[gambleId]!
  run.pendingType = 'gamble'
  return {
    type: 'gamble',
    gambleId,
    promptText: gamble.text,
    actionLabel: gamble.action,
    bandJustChanged,
    bandLabel,
    hud: hud(run),
  }
}

function buildReport(
  status: 'extracted' | 'died',
  run: ActiveRun,
  goldAmount: number,
  profile: Profile,
): ReportData {
  const isNewBest = run.depth > profile.personalBestDepth
  if (isNewBest) profile.personalBestDepth = run.depth
  return {
    status,
    depth: run.depth,
    goldAmount,
    hazardsFaced: run.hazardsFaced,
    hazardsWarded: run.hazardsWarded,
    isNewBest,
    minHp: Math.max(0, run.minHp),
    wardsMax: STARTING_WARDS,
    banked: profile.banked,
    best: profile.best,
    bestDepth: profile.bestDepth,
  }
}

// The date component keeps the seed fresh across day boundaries even for a
// run that spans midnight; the run nonce is what actually keeps each run
// distinct from the last — see rng.ts's runNonce.
function seedFor(userId: T2, run: ActiveRun): string {
  return `${dailySeed(userId, todayUtc())}:${run.runSeed}`
}

// Debug panel gate: subreddit moderators only. This is a reachability gate
// for a dev/QA tool (screen jumps, SFX tests, ephemeral gold grants), not a
// security boundary — good enough to keep real players from stumbling into
// it, per CLAUDE_CODE_PROMPT.md item 9.
async function isSubredditModerator(subredditName: string): Promise<boolean> {
  try {
    const user = await reddit.getCurrentUser()
    if (!user) return false
    const perms = await user.getModPermissionsForSubreddit(subredditName)
    return perms.length > 0
  } catch (err) {
    console.error(
      `moderator check failed: ${err instanceof Error ? err.message : err}`,
    )
    return false
  }
}

export async function getHub(
  userId: T2,
  subredditName: string,
): Promise<HubRsp> {
  // Best-effort proxy for "the game has loaded and is interactive" — the
  // Hub screen is the first thing rendered, and this is the first request
  // it makes. Not deduplicated per browser session (no clean server-side
  // signal for that here); an occasional extra App.Ready per visit is
  // harmless, per the Journeys docs.
  await reportAppReady()
  const [profile, relics, debugEnabled] = await Promise.all([
    getProfile(userId),
    getRelics(userId),
    isSubredditModerator(subredditName),
  ])
  return {profile, relics, debugEnabled}
}

// Reddit's flair API is text/color only — no custom per-tier icon upload,
// so the flair badge shows the relic's name, not its art. Wrapped
// defensively: a flair-API hiccup (rate limit, transient error) shouldn't
// roll back gold already spent or ownership already granted — the Redis
// state here is the source of truth for what the player owns, the Reddit
// flair is just its visible reflection.
async function applyFlair(
  subredditName: string,
  username: string,
  tier: number,
): Promise<void> {
  const def = relicTier(tier)
  if (!def) return
  try {
    await reddit.setUserFlair({subredditName, username, text: def.name})
  } catch (err) {
    console.error(
      `flair set failed for ${username}: ${err instanceof Error ? err.message : err}`,
    )
  }
}

async function removeFlair(
  subredditName: string,
  username: string,
): Promise<void> {
  try {
    await reddit.removeUserFlair(subredditName, username)
  } catch (err) {
    console.error(
      `flair remove failed for ${username}: ${err instanceof Error ? err.message : err}`,
    )
  }
}

async function buyRelicImpl(
  userId: T2,
  username: string,
  subredditName: string,
  tier: number,
): Promise<RelicsRsp> {
  const def = relicTier(tier)
  if (!def) throw new GameError('invalid relic tier')

  const [relics, profile] = await Promise.all([
    getRelics(userId),
    getProfile(userId),
  ])
  if (relics.owned.includes(tier)) throw new GameError('already owned')
  if (profile.banked < def.price)
    throw new GameError('insufficient banked gold')

  profile.banked -= def.price
  relics.owned.push(tier)
  relics.equipped = tier // buying auto-equips, matching the client prototype

  await Promise.all([setProfile(userId, profile), setRelics(userId, relics)])
  await applyFlair(subredditName, username, tier)

  return {relics, banked: profile.banked}
}

async function equipRelicImpl(
  userId: T2,
  username: string,
  subredditName: string,
  tier: number,
): Promise<RelicsRsp> {
  const [relics, profile] = await Promise.all([
    getRelics(userId),
    getProfile(userId),
  ])
  if (!relics.owned.includes(tier)) throw new GameError('relic not owned')

  relics.equipped = tier
  await setRelics(userId, relics)
  await applyFlair(subredditName, username, tier)

  return {relics, banked: profile.banked}
}

async function unequipRelicImpl(
  userId: T2,
  username: string,
  subredditName: string,
): Promise<RelicsRsp> {
  const [relics, profile] = await Promise.all([
    getRelics(userId),
    getProfile(userId),
  ])
  relics.equipped = null
  await setRelics(userId, relics)
  await removeFlair(subredditName, username)

  return {relics, banked: profile.banked}
}

export const buyRelic = withUserLock(buyRelicImpl, {rateLimit: false})
export const equipRelic = withUserLock(equipRelicImpl, {rateLimit: false})
export const unequipRelic = withUserLock(unequipRelicImpl, {rateLimit: false})

// Debug panel gold grant/clear. Mutates real, persisted banked gold (not a
// display-only stub) so moderators can actually QA the relic shop —
// gated the same way as the debug panel's own reachability (see
// isSubredditModerator above), enforced server-side since debugEnabled on
// the client is informational only.
async function debugGrantGoldImpl(
  userId: T2,
  subredditName: string,
  amount: number,
): Promise<DebugGoldRsp> {
  if (!(await isSubredditModerator(subredditName))) {
    throw new GameError('debug tools are moderator-only')
  }
  const profile = await getProfile(userId)
  profile.banked = Math.max(0, profile.banked + amount)
  await setProfile(userId, profile)
  return {banked: profile.banked}
}
export const debugGrantGold = withUserLock(debugGrantGoldImpl, {
  rateLimit: false,
})

const LEADERBOARD_PAGE_SIZE = 10

export async function getLeaderboard(
  userId: T2,
  page: number,
): Promise<LeaderboardRsp> {
  const offset = Math.max(0, page) * LEADERBOARD_PAGE_SIZE
  const [entries, count, rank] = await Promise.all([
    getLeaderboardPage(offset, LEADERBOARD_PAGE_SIZE),
    getLeaderboardCount(),
    getLeaderboardRank(userId),
  ])

  const rows = entries.map((e, i) => ({
    rank: offset + i + 1,
    username: e.username,
    gold: e.gold,
    depth: e.depth,
  }))

  let you: LeaderboardRsp['you'] = null
  if (rank !== null) {
    const profile = await getProfile(userId)
    you = {rank, gold: profile.best, depth: profile.bestDepth}
  }

  return {
    rows,
    page: Math.max(0, page),
    totalPages: Math.max(1, Math.ceil(count / LEADERBOARD_PAGE_SIZE)),
    you,
  }
}

async function enterPyramidImpl(userId: T2): Promise<EncounterResult> {
  const run = freshRun()
  const seed = seedFor(userId, run)
  const result = rollEncounter(seed, run)
  // "Enter the Pyramid" is the explicit user action that begins a session —
  // Journey.Start must never fire on app load (see telemetry.ts).
  run.journeyId = await startJourney()
  await setActiveRun(userId, run)
  return result
}

async function pushDeeperImpl(userId: T2): Promise<EncounterResult> {
  const run = await getActiveRun(userId)
  if (!run.active) throw new GameError('no active run')
  // Hazards are the one encounter type with no legitimate free skip (a
  // gamble can be walked away from via "Leave It", client-side, at no
  // cost — a hazard can't). Without this check a client could call push
  // directly instead of resolving the pending hazard and take zero
  // damage, spend zero wards, for every hazard in the run.
  if (run.pendingType === 'hazard') {
    throw new GameError('resolve the pending hazard first')
  }
  const seed = seedFor(userId, run)
  const result = rollEncounter(seed, run)
  if (result.bandJustChanged) {
    await reportBandProgress(
      run.journeyId,
      bandFor(run.depth),
      result.bandLabel,
    )
  }
  await setActiveRun(userId, run)
  return result
}

async function resolveHazard(
  userId: T2,
  useWard: boolean,
): Promise<HazardOutcome> {
  const run = await getActiveRun(userId)
  if (!run.active || run.pendingType !== 'hazard') {
    throw new GameError('no pending hazard')
  }
  // The client disables the Ward button at 0 wards, but that's UI only —
  // without this, a client could call this endpoint directly with 0
  // wards left for unlimited free hazard immunity.
  if (useWard && run.wards <= 0) {
    throw new GameError('no wards remaining')
  }
  const seed = seedFor(userId, run)
  const depth = run.depth
  const band = bandFor(depth)
  // biome-ignore lint/style/noNonNullAssertion: Math.min(band,2) is always a valid TELEGRAPHS index
  const pool = TELEGRAPHS[Math.min(band, 2)]!
  const idx = rollIndex(seed, depth, 'telegraph', pool.length)
  // biome-ignore lint/style/noNonNullAssertion: idx is always < pool.length
  const telegraph = pool[idx]!
  const hazardPresent =
    rollPercent(seed, depth, 'present') < PARAMS.hazardPresent[band]

  run.hazardsFaced += 1
  run.pendingType = null
  await reportInteraction(
    run.journeyId,
    useWard ? 'ward_used' : 'push_unwarded',
  )

  if (useWard) {
    run.wards -= 1
    run.hazardsWarded += 1
    await setActiveRun(userId, run)
    return hazardPresent
      ? {
          useWard: true,
          hazardPresent: true,
          hazardName: telegraph.hazard,
          fatal: false,
          hud: hud(run),
        }
      : {
          useWard: true,
          hazardPresent: false,
          safeName: telegraph.safe,
          fatal: false,
          hud: hud(run),
        }
  }

  if (!hazardPresent) {
    await setActiveRun(userId, run)
    return {
      useWard: false,
      hazardPresent: false,
      safeName: telegraph.safe,
      fatal: false,
      hud: hud(run),
    }
  }

  const [lo, hi] = PARAMS.dmg[band]
  const damage = rollInt(seed, depth, 'dmg', lo, hi)
  run.hp -= damage
  run.minHp = Math.min(run.minHp, run.hp)
  const fatal = run.hp <= 0

  if (fatal) {
    const profile = await getProfile(userId)
    const report = buildReport('died', run, run.gold, profile)
    await setProfile(userId, profile)
    await reportJourneyEnd(run.journeyId, false, run.gold)
    await clearActiveRun(userId)
    return {
      useWard: false,
      hazardPresent: true,
      hazardName: telegraph.hazard,
      damage,
      fatal: true,
      hud: {depth: run.depth, hp: 0, gold: run.gold, wards: run.wards},
      report,
    }
  }

  await setActiveRun(userId, run)
  return {
    useWard: false,
    hazardPresent: true,
    hazardName: telegraph.hazard,
    damage,
    fatal: false,
    hud: hud(run),
  }
}

export const resolveWard = withUserLock((userId: T2) =>
  resolveHazard(userId, true),
)

export const resolvePushUnwarded = withUserLock((userId: T2) =>
  resolveHazard(userId, false),
)

async function resolveGambleRiskImpl(userId: T2): Promise<GambleOutcome> {
  const run = await getActiveRun(userId)
  if (!run.active || run.pendingType !== 'gamble') {
    throw new GameError('no pending gamble')
  }
  const seed = seedFor(userId, run)
  const depth = run.depth
  const band = bandFor(depth)
  run.pendingType = null
  await reportInteraction(run.journeyId, 'gamble_risked')

  const success =
    rollPercent(seed, depth, 'gambleSuccess') < PARAMS.gambleSuccess
  if (success) {
    const prevGold = run.gold
    const [lo, hi] = PARAMS.gambleBonus[band]
    const amount = rollInt(seed, depth, 'gambleAmount', lo, hi)
    run.gold += amount
    const milestoneHit = Math.floor(run.gold / 100) > Math.floor(prevGold / 100)
    await setActiveRun(userId, run)
    return {success: true, amount, milestoneHit, fatal: false, hud: hud(run)}
  }

  const [lo, hi] = PARAMS.dmg[band]
  const damage = rollInt(seed, depth, 'gambleDmg', lo, hi)
  run.hp -= damage
  run.minHp = Math.min(run.minHp, run.hp)
  const fatal = run.hp <= 0

  if (fatal) {
    const profile = await getProfile(userId)
    const report = buildReport('died', run, run.gold, profile)
    await setProfile(userId, profile)
    await reportJourneyEnd(run.journeyId, false, run.gold)
    await clearActiveRun(userId)
    return {
      success: false,
      damage,
      fatal: true,
      hud: {depth: run.depth, hp: 0, gold: run.gold, wards: run.wards},
      report,
    }
  }

  await setActiveRun(userId, run)
  return {success: false, damage, fatal: false, hud: hud(run)}
}

export const resolveGambleRisk = withUserLock(resolveGambleRiskImpl)

async function extractImpl(
  userId: T2,
  username: string,
): Promise<ExtractResult> {
  const run = await getActiveRun(userId)
  if (!run.active) throw new GameError('no active run')
  // Same reasoning as pushDeeper's guard — Extract has no button on the
  // hazard/gamble screens in the real UI, but nothing stopped a direct
  // call here from banking gold while skipping a pending hazard's damage
  // entirely. Pending gambles are fine to extract past — "Leave It" is
  // already a legitimate free skip, so this adds no new exploit there.
  if (run.pendingType === 'hazard') {
    throw new GameError('resolve the pending hazard first')
  }

  const profile = await getProfile(userId)
  const goldThisRun = run.gold
  profile.banked += goldThisRun
  let isNewBest = false
  if (goldThisRun > profile.best) {
    profile.best = goldThisRun
    profile.bestDepth = run.depth
    isNewBest = true
  }
  const report = buildReport('extracted', run, goldThisRun, profile)
  await setProfile(userId, profile)
  if (isNewBest)
    await submitToLeaderboard(userId, username, profile.best, profile.bestDepth)
  await reportJourneyEnd(run.journeyId, true, goldThisRun)
  await clearActiveRun(userId)

  return {
    goldThisRun,
    report,
    hud: {depth: run.depth, hp: run.hp, gold: 0, wards: run.wards},
    profile,
  }
}

async function abandonImpl(userId: T2): Promise<{hud: HudState}> {
  const run = await getActiveRun(userId)
  if (!run.active) throw new GameError('no active run')
  await reportJourneyEnd(run.journeyId, false, run.gold)
  await clearActiveRun(userId)
  return {hud: {depth: 0, hp: run.hp, gold: 0, wards: run.wards}}
}

export const enterPyramid = withUserLock(enterPyramidImpl)
export const pushDeeper = withUserLock(pushDeeperImpl)
export const extract = withUserLock(extractImpl)
export const abandon = withUserLock(abandonImpl)
