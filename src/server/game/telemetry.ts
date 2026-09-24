import {telemetry} from '@devvit/analytics/server/reddit'

/**
 * Devvit Journeys — one journey per dive run, matching the design doc's
 * intent (Section 14): Journey.Start on "Enter the Pyramid",
 * Journey.Progress at band transitions, Journey.Interaction on
 * ward/push-unwarded/gamble-risk, Journey.End on extract/death/abandon.
 *
 * Telemetry is a server-only add-on (Devvit Web required, already the
 * case here) and requires the app + this journey map to be allowlist-
 * approved by Reddit before events are accepted — see
 * CLAUDE_CODE_PROMPT.md item 7. Every call here is wrapped defensively,
 * same reasoning as engine.ts's applyFlair/removeFlair: a telemetry
 * failure (not yet allowlisted, rate limited, transient error) must never
 * break the actual run — gameplay state in Redis is authoritative
 * regardless of whether the event was recorded.
 */
function logTelemetryError(what: string, err: unknown): void {
  console.error(
    `telemetry ${what} failed: ${err instanceof Error ? err.message : err}`,
  )
}

export async function reportAppReady(): Promise<void> {
  try {
    await telemetry.appReady()
  } catch (err) {
    logTelemetryError('appReady', err)
  }
}

/** Returns '' on failure — callers treat that the same as "no journey". */
export async function startJourney(): Promise<string> {
  try {
    const {journeyId} = await telemetry.startJourney()
    return journeyId
  } catch (err) {
    logTelemetryError('startJourney', err)
    return ''
  }
}

// Progress is approximated as band-reached / total bands (5) — the pyramid
// has no hard "end," so this tracks depth-tier progress, not completion.
export async function reportBandProgress(
  journeyId: string,
  band: number,
  bandLabel: string,
): Promise<void> {
  if (!journeyId) return
  try {
    await telemetry.journeyProgress({
      journeyId,
      progress: Math.min(1, (band + 1) / 5),
      action: 'band_reached',
      actionDetails: bandLabel,
    })
  } catch (err) {
    logTelemetryError('journeyProgress', err)
  }
}

export async function reportInteraction(
  journeyId: string,
  action: string,
  actionDetails = '',
): Promise<void> {
  if (!journeyId) return
  try {
    await telemetry.journeyInteraction({journeyId, action, actionDetails})
  } catch (err) {
    logTelemetryError('journeyInteraction', err)
  }
}

export async function reportJourneyEnd(
  journeyId: string,
  complete: boolean,
  score: number,
): Promise<void> {
  if (!journeyId) return
  try {
    await telemetry.endJourney({
      journeyId,
      complete,
      game: {win: complete, score},
    })
  } catch (err) {
    logTelemetryError('endJourney', err)
  }
}
