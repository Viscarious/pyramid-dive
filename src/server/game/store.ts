import {redis} from '@devvit/web/server'
import type {T2} from '@devvit/web/shared'
import type {Profile, RelicsState} from '../../shared/api.ts'

export type PendingType = 'treasure' | 'hazard' | 'gamble' | null

/** Server-authoritative state for the run currently in progress, if any. */
export type ActiveRun = {
  active: boolean
  depth: number
  hp: number
  gold: number
  wards: number
  hazardsFaced: number
  hazardsWarded: number
  minHp: number
  lastBand: number
  pendingType: PendingType
  /** Devvit Journeys id for this run, '' if telemetry hasn't started one yet. */
  journeyId: string
}

const NO_ACTIVE_RUN: ActiveRun = {
  active: false,
  depth: 0,
  hp: 0,
  gold: 0,
  wards: 0,
  hazardsFaced: 0,
  hazardsWarded: 0,
  minHp: 0,
  lastBand: 0,
  pendingType: null,
  journeyId: '',
}

const EMPTY_PROFILE: Profile = {
  banked: 0,
  best: 0,
  bestDepth: 0,
  personalBestDepth: 0,
}

function runKey(userId: T2): string {
  return `run:${userId}`
}

function profileKey(userId: T2): string {
  return `profile:${userId}`
}

export async function getActiveRun(userId: T2): Promise<ActiveRun> {
  const h = await redis.hGetAll(runKey(userId))
  if (h.active !== '1') return NO_ACTIVE_RUN
  return {
    active: true,
    depth: Number(h.depth),
    hp: Number(h.hp),
    gold: Number(h.gold),
    wards: Number(h.wards),
    hazardsFaced: Number(h.hazardsFaced),
    hazardsWarded: Number(h.hazardsWarded),
    minHp: Number(h.minHp),
    lastBand: Number(h.lastBand),
    pendingType: (h.pendingType as PendingType) || null,
    journeyId: h.journeyId ?? '',
  }
}

export async function setActiveRun(userId: T2, run: ActiveRun): Promise<void> {
  await redis.hSet(runKey(userId), {
    active: run.active ? '1' : '0',
    depth: String(run.depth),
    hp: String(run.hp),
    gold: String(run.gold),
    wards: String(run.wards),
    hazardsFaced: String(run.hazardsFaced),
    hazardsWarded: String(run.hazardsWarded),
    minHp: String(run.minHp),
    lastBand: String(run.lastBand),
    pendingType: run.pendingType ?? '',
    journeyId: run.journeyId,
  })
}

export async function clearActiveRun(userId: T2): Promise<void> {
  await setActiveRun(userId, NO_ACTIVE_RUN)
}

export async function getProfile(userId: T2): Promise<Profile> {
  const h = await redis.hGetAll(profileKey(userId))
  if (Object.keys(h).length === 0) return EMPTY_PROFILE
  return {
    banked: Number(h.banked ?? 0),
    best: Number(h.best ?? 0),
    bestDepth: Number(h.bestDepth ?? 0),
    personalBestDepth: Number(h.personalBestDepth ?? 0),
  }
}

export async function setProfile(userId: T2, profile: Profile): Promise<void> {
  await redis.hSet(profileKey(userId), {
    banked: String(profile.banked),
    best: String(profile.best),
    bestDepth: String(profile.bestDepth),
    personalBestDepth: String(profile.personalBestDepth),
  })
}

// ---- Leaderboard ----
// A single Redis sorted set ranked by best single-run gold, depth as
// tiebreaker, encoded into one score (Redis sorted sets only rank by a
// single numeric dimension). 1,000,000 comfortably separates the two —
// depth realistically never approaches six figures, so it can never bleed
// into the gold digits. Per-subreddit and per-installation automatically,
// same as the rest of Redis here — no global leaderboard.
const LEADERBOARD_KEY = 'leaderboard:best-gold'
const DEPTH_MULTIPLIER = 1_000_000

function usernameKey(userId: T2): string {
  return `username:${userId}`
}

function encodeScore(best: number, bestDepth: number): number {
  return best * DEPTH_MULTIPLIER + bestDepth
}

export type LeaderboardEntry = {
  userId: T2
  username: string
  gold: number
  depth: number
}

/** Only called when a run sets a new personal best — see engine.ts's extract(). */
export async function submitToLeaderboard(
  userId: T2,
  username: string,
  best: number,
  bestDepth: number,
): Promise<void> {
  await Promise.all([
    redis.zAdd(LEADERBOARD_KEY, {
      member: userId,
      score: encodeScore(best, bestDepth),
    }),
    redis.set(usernameKey(userId), username),
  ])
}

export async function getLeaderboardCount(): Promise<number> {
  return redis.zCard(LEADERBOARD_KEY)
}

/** 0-indexed page, descending by score (highest gold first). */
export async function getLeaderboardPage(
  offset: number,
  count: number,
): Promise<LeaderboardEntry[]> {
  const rows = await redis.zRange(LEADERBOARD_KEY, offset, offset + count - 1, {
    by: 'rank',
    reverse: true,
  })
  if (rows.length === 0) return []

  const usernames = await redis.mGet(rows.map(r => usernameKey(r.member as T2)))
  return rows.map((r, i) => ({
    userId: r.member as T2,
    username: usernames[i] ?? r.member,
    gold: Math.floor(r.score / DEPTH_MULTIPLIER),
    depth: r.score % DEPTH_MULTIPLIER,
  }))
}

/** 1-indexed rank, or null if this user has never set a best. */
export async function getLeaderboardRank(userId: T2): Promise<number | null> {
  const [ascendingRank, count] = await Promise.all([
    redis.zRank(LEADERBOARD_KEY, userId),
    getLeaderboardCount(),
  ])
  if (ascendingRank === undefined) return null
  return count - ascendingRank
}

// ---- Relic Shop ----
// Fully local/ephemeral until now (CLAUDE_CODE_PROMPT.md item 6) — owned
// tiers and the equipped tier persist per user here, and equipping maps to
// a real Reddit flair (see engine.ts's applyFlair/removeFlair).
const EMPTY_RELICS: RelicsState = {owned: [], equipped: null}

function relicsKey(userId: T2): string {
  return `relics:${userId}`
}

export async function getRelics(userId: T2): Promise<RelicsState> {
  const h = await redis.hGetAll(relicsKey(userId))
  if (Object.keys(h).length === 0) return EMPTY_RELICS
  return {
    owned: h.owned ? h.owned.split(',').map(Number) : [],
    equipped: h.equipped ? Number(h.equipped) : null,
  }
}

export async function setRelics(
  userId: T2,
  relics: RelicsState,
): Promise<void> {
  await redis.hSet(relicsKey(userId), {
    owned: relics.owned.join(','),
    equipped: relics.equipped === null ? '' : String(relics.equipped),
  })
}

// ---- Per-user mutex ----
// Every mutating action here does read-Redis -> check -> modify -> write,
// which is not atomic. Without this, a client firing concurrent requests
// (e.g. two simultaneous extracts) can win the same race twice — read the
// same starting balance before either write lands, and both compute a
// result as if they were the only one running. This lock serializes a
// single user's mutating actions so that can't happen. A short TTL is the
// safety net if a request dies between acquiring and releasing.
const LOCK_TTL_SECONDS = 10

function lockKey(userId: T2): string {
  return `lock:${userId}`
}

export async function acquireUserLock(userId: T2): Promise<boolean> {
  const acquired = await redis.hSetNX(lockKey(userId), 'locked', '1')
  if (acquired) await redis.expire(lockKey(userId), LOCK_TTL_SECONDS)
  return acquired === 1
}

export async function releaseUserLock(userId: T2): Promise<void> {
  await redis.del(lockKey(userId))
}
