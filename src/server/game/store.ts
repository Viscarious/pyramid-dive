import {redis} from '@devvit/web/server'
import type {T2} from '@devvit/web/shared'
import type {Profile} from '../../shared/api.ts'

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
