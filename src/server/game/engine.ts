import {reddit} from '@devvit/web/server'
import type {T2} from '@devvit/web/shared'
import type {
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
import {dailySeed, rollIndex, rollInt, rollPercent, todayUtc} from './rng.ts'
import {
  type ActiveRun,
  clearActiveRun,
  getActiveRun,
  getLeaderboardCount,
  getLeaderboardPage,
  getLeaderboardRank,
  getProfile,
  getRelics,
  setActiveRun,
  setProfile,
  setRelics,
  submitToLeaderboard,
} from './store.ts'

export class GameError extends Error {}

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

function seedFor(userId: T2): string {
  return dailySeed(userId, todayUtc())
}

export async function getHub(userId: T2): Promise<HubRsp> {
  const [profile, relics] = await Promise.all([
    getProfile(userId),
    getRelics(userId),
  ])
  return {profile, relics}
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

export async function buyRelic(
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

export async function equipRelic(
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

export async function unequipRelic(
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

export async function enterPyramid(userId: T2): Promise<EncounterResult> {
  const seed = seedFor(userId)
  const run = freshRun()
  const result = rollEncounter(seed, run)
  await setActiveRun(userId, run)
  return result
}

export async function pushDeeper(userId: T2): Promise<EncounterResult> {
  const run = await getActiveRun(userId)
  if (!run.active) throw new GameError('no active run')
  const seed = seedFor(userId)
  const result = rollEncounter(seed, run)
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
  const seed = seedFor(userId)
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

export function resolveWard(userId: T2): Promise<HazardOutcome> {
  return resolveHazard(userId, true)
}

export function resolvePushUnwarded(userId: T2): Promise<HazardOutcome> {
  return resolveHazard(userId, false)
}

export async function resolveGambleRisk(userId: T2): Promise<GambleOutcome> {
  const run = await getActiveRun(userId)
  if (!run.active || run.pendingType !== 'gamble') {
    throw new GameError('no pending gamble')
  }
  const seed = seedFor(userId)
  const depth = run.depth
  const band = bandFor(depth)
  run.pendingType = null

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

export async function extract(
  userId: T2,
  username: string,
): Promise<ExtractResult> {
  const run = await getActiveRun(userId)
  if (!run.active) throw new GameError('no active run')

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
  await clearActiveRun(userId)

  return {
    goldThisRun,
    report,
    hud: {depth: run.depth, hp: run.hp, gold: 0, wards: run.wards},
    profile,
  }
}

export async function abandon(userId: T2): Promise<{hud: HudState}> {
  const run = await getActiveRun(userId)
  if (!run.active) throw new GameError('no active run')
  await clearActiveRun(userId)
  return {hud: {depth: 0, hp: run.hp, gold: 0, wards: run.wards}}
}
