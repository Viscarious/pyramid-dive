import {createHash, randomBytes} from 'node:crypto'

/**
 * Deterministic per-run seeded RNG.
 *
 * Design intent (design doc v0.11 Section 6): a per-user seed keeps the
 * difficulty curve fair across all players while giving each player their
 * own distinct encounter sequence — a fully shared seed was explicitly
 * rejected because Reddit's comment culture makes spoiler leakage ("hazard
 * at depth 5") near-certain within the first hour. The per-run nonce below
 * is layered on top of that: without it, a per-user-per-day seed alone
 * makes every replay on the same day identical, so a player who's already
 * died or extracted once can memorize the rest of the day's run instead of
 * facing real risk on wards/gambles.
 *
 * Every roll is a pure function of (seed, depth, channel) — not a stateful
 * stream. This means a run's outcome at a given depth is fully reproducible
 * for the lifetime of that run, and the server never needs to persist "what
 * was rolled" for a pending encounter — ward/push-unwarded/gamble-risk just
 * recompute the same deterministic values for the current depth when the
 * player commits to an action. The per-run nonce (see runNonce below) is
 * what makes that reproducibility scoped to a single run instead of a
 * whole day.
 */
export function dailySeed(userId: string, dateUtc: string): string {
  return `${userId}:${dateUtc}`
}

/** YYYY-MM-DD in UTC, so the daily boundary is the same for every player. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Fresh per-run randomness, folded into the seed so each run this user
 * starts gets its own encounter sequence instead of replaying the day's. */
export function runNonce(): string {
  return randomBytes(16).toString('hex')
}

/** Deterministic float in [0, 1) for (seed, depth, channel). */
function roll(seed: string, depth: number, channel: string): number {
  const digest = createHash('sha256')
    .update(`${seed}:${depth}:${channel}`)
    .digest()
  // First 4 bytes as an unsigned 32-bit int, normalized to [0, 1).
  return digest.readUInt32BE(0) / 0x1_0000_0000
}

/** Deterministic integer in [lo, hi] inclusive for (seed, depth, channel). */
export function rollInt(
  seed: string,
  depth: number,
  channel: string,
  lo: number,
  hi: number,
): number {
  return lo + Math.floor(roll(seed, depth, channel) * (hi - lo + 1))
}

/** Deterministic percent roll in [0, 100) for (seed, depth, channel). */
export function rollPercent(
  seed: string,
  depth: number,
  channel: string,
): number {
  return roll(seed, depth, channel) * 100
}

/** Deterministic index into an array of the given length. */
export function rollIndex(
  seed: string,
  depth: number,
  channel: string,
  length: number,
): number {
  return Math.floor(roll(seed, depth, channel) * length)
}
