/**
 * Shared client/server API contract. Kept free of any server-only imports
 * (Redis, crypto, game content/balance data) since this file is bundled
 * into the browser client too — see src/server/game/engine.ts for the
 * implementations that produce these shapes.
 */

/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

export type HudState = {depth: number; hp: number; gold: number; wards: number}

export type Profile = {
  banked: number
  best: number
  bestDepth: number
  personalBestDepth: number
}

export type ReportData = {
  status: 'extracted' | 'died'
  depth: number
  goldAmount: number
  hazardsFaced: number
  hazardsWarded: number
  isNewBest: boolean
  minHp: number
  wardsMax: number
  banked: number
  best: number
  bestDepth: number
}

export type EncounterResult =
  | {
      type: 'treasure'
      amount: number
      milestoneHit: boolean
      bandJustChanged: boolean
      bandLabel: string
      hud: HudState
    }
  | {
      type: 'hazard'
      telegraphText: string
      bandJustChanged: boolean
      bandLabel: string
      hud: HudState
    }
  | {
      type: 'gamble'
      gambleId: number
      promptText: string
      actionLabel: string
      bandJustChanged: boolean
      bandLabel: string
      hud: HudState
    }

export type HazardOutcome = {
  useWard: boolean
  hazardPresent: boolean
  hazardName?: string
  safeName?: string
  damage?: number
  fatal: boolean
  hud: HudState
  report?: ReportData
}

export type GambleOutcome = {
  success: boolean
  amount?: number
  milestoneHit?: boolean
  damage?: number
  fatal: boolean
  hud: HudState
  report?: ReportData
}

export type ExtractResult = {
  goldThisRun: number
  report: ReportData
  hud: HudState
  profile: Profile
}

export type LeaderboardRow = {
  rank: number
  username: string
  gold: number
  depth: number
}
export type LeaderboardRsp = {
  rows: LeaderboardRow[]
  page: number
  totalPages: number
  you: {rank: number; gold: number; depth: number} | null
}

export type HubRsp = {profile: Profile}
export type EnterRsp = EncounterResult
export type PushRsp = EncounterResult
export type WardRsp = HazardOutcome
export type PushUnwardedRsp = HazardOutcome
export type GambleRiskRsp = GambleOutcome
export type ExtractRsp = ExtractResult
export type AbandonRsp = {hud: HudState}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  Hub: 'api/hub',
  Leaderboard: 'api/leaderboard',
  RunEnter: 'api/run/enter',
  RunPush: 'api/run/push',
  RunWard: 'api/run/ward',
  RunPushUnwarded: 'api/run/push-unwarded',
  RunGambleRisk: 'api/run/gamble-risk',
  RunExtract: 'api/run/extract',
  RunAbandon: 'api/run/abandon',
  OnAppInstall: 'internal/on/app/install',
  OnMenuNewPost: 'internal/on/menu/new-post',
} as const

export const EndpointMethod = {
  [Endpoint.Hub]: 'GET',
  [Endpoint.Leaderboard]: 'GET',
  [Endpoint.RunEnter]: 'POST',
  [Endpoint.RunPush]: 'POST',
  [Endpoint.RunWard]: 'POST',
  [Endpoint.RunPushUnwarded]: 'POST',
  [Endpoint.RunGambleRisk]: 'POST',
  [Endpoint.RunExtract]: 'POST',
  [Endpoint.RunAbandon]: 'POST',
  [Endpoint.OnAppInstall]: 'POST',
  [Endpoint.OnMenuNewPost]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
