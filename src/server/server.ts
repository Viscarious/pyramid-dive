import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {EntrypointHeight} from '@devvit/reddit'
import {context, reddit} from '@devvit/web/server'
import type {
  PartialJsonValue,
  T2,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import {
  type AbandonRsp,
  type ClientErrorReq,
  type DebugGoldRsp,
  Endpoint,
  EndpointMethod,
  type ErrorRsp,
  type ExtractRsp,
  type GambleRiskRsp,
  type HubRsp,
  type LeaderboardRsp,
  type PushRsp,
  type PushUnwardedRsp,
  type RelicsRsp,
  type WardRsp,
} from '../shared/api.ts'
import {
  abandon,
  buyRelic,
  debugGrantGold,
  enterPyramid,
  equipRelic,
  extract,
  GameError,
  getHub,
  getLeaderboard,
  pushDeeper,
  resolveGambleRisk,
  resolvePushUnwarded,
  resolveWard,
  unequipRelic,
} from './game/engine.ts'

type OkRsp = {ok: true}

type AnyRsp =
  | UiResponse
  | TriggerResponse
  | ErrorRsp
  | HubRsp
  | LeaderboardRsp
  | PushRsp
  | WardRsp
  | PushUnwardedRsp
  | GambleRiskRsp
  | ExtractRsp
  | AbandonRsp
  | RelicsRsp
  | DebugGoldRsp
  | OkRsp

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    if (err instanceof AuthError) {
      writeJson<ErrorRsp>(401, {error: err.message, status: 401}, rspMsg)
      return
    }
    if (err instanceof GameError) {
      writeJson<ErrorRsp>(409, {error: err.message, status: 409}, rspMsg)
      return
    }
    // Full detail (stack trace, internals) stays server-side in the log —
    // sending it back in the response body would leak implementation
    // details to the client.
    console.error(`server error; ${err instanceof Error ? err.stack : err}`)
    writeJson<ErrorRsp>(
      500,
      {error: 'internal server error', status: 500},
      rspMsg,
    )
  }
}

class AuthError extends Error {}

function requireUserId(): T2 {
  if (!context.userId) throw new AuthError('must be logged in')
  return context.userId
}

function requireUsername(): string {
  return context.username ?? 'anonymous'
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  // reqMsg.url may carry a query string (e.g. leaderboard pagination) —
  // split it off before matching against the Endpoint enum.
  const [path, query] = (reqMsg.url ?? '').slice(1).split('?')
  const endpoint = path as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.Hub:
        rsp = await getHub(requireUserId(), context.subredditName)
        break
      case Endpoint.Leaderboard: {
        const page = Number(new URLSearchParams(query).get('page') ?? '0')
        rsp = await getLeaderboard(
          requireUserId(),
          Number.isFinite(page) ? page : 0,
        )
        break
      }
      case Endpoint.RunEnter:
        rsp = await enterPyramid(requireUserId())
        break
      case Endpoint.RunPush:
        rsp = await pushDeeper(requireUserId())
        break
      case Endpoint.RunWard:
        rsp = await resolveWard(requireUserId())
        break
      case Endpoint.RunPushUnwarded:
        rsp = await resolvePushUnwarded(requireUserId())
        break
      case Endpoint.RunGambleRisk:
        rsp = await resolveGambleRisk(requireUserId())
        break
      case Endpoint.RunExtract:
        rsp = await extract(requireUserId(), requireUsername())
        break
      case Endpoint.RunAbandon:
        rsp = await abandon(requireUserId())
        break
      case Endpoint.RelicsBuy: {
        const tier = Number(new URLSearchParams(query).get('tier'))
        rsp = await buyRelic(
          requireUserId(),
          requireUsername(),
          context.subredditName,
          tier,
        )
        break
      }
      case Endpoint.RelicsEquip: {
        const tier = Number(new URLSearchParams(query).get('tier'))
        rsp = await equipRelic(
          requireUserId(),
          requireUsername(),
          context.subredditName,
          tier,
        )
        break
      }
      case Endpoint.RelicsUnequip:
        rsp = await unequipRelic(
          requireUserId(),
          requireUsername(),
          context.subredditName,
        )
        break
      case Endpoint.DebugGold: {
        const amount = Number(new URLSearchParams(query).get('amount'))
        rsp = await debugGrantGold(
          requireUserId(),
          context.subredditName,
          Number.isFinite(amount) ? amount : 0,
        )
        break
      }
      case Endpoint.ClientError:
        rsp = await routeClientError(reqMsg)
        break
      case Endpoint.OnMenuNewPost:
        rsp = await routeMenuNewPost()
        break
      case Endpoint.OnAppInstall:
        rsp = await routeAppInstall()
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

// Webview console.error/uncaught errors are invisible to `devvit logs` by
// default — they're scoped to the iframe's own browser console, not the
// app's server-side log stream (see CLAUDE_CODE_PROMPT.md item 8). The
// client's window.onerror/unhandledrejection handlers (game.ts, splash.ts)
// post here so client bugs actually surface during development instead of
// failing silently.
const CLIENT_ERROR_FIELD_MAX = 4000

// The request body is arbitrary client-supplied JSON with no schema
// enforcement before this point — coerce every field to a string so a
// malformed payload (wrong types, missing fields) can't throw here and
// surface as an unrelated-looking 500.
function truncate(value: unknown): string {
  const s = typeof value === 'string' ? value : String(value)
  return s.length > CLIENT_ERROR_FIELD_MAX
    ? `${s.slice(0, CLIENT_ERROR_FIELD_MAX)}… (truncated)`
    : s
}

async function routeClientError(reqMsg: IncomingMessage): Promise<OkRsp> {
  const req = await readJson<ClientErrorReq>(reqMsg)
  // Truncated defensively — this endpoint takes arbitrary client-supplied
  // text with no other validation, so nothing stops a spammy/malicious
  // client from posting oversized garbage repeatedly.
  console.error(
    `client error [${truncate(req.source)}]: ${truncate(req.message)}\n${truncate(req.stack)}`,
  )
  return {ok: true}
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  reqMsg.on('data', chunk => chunks.push(chunk))
  await once(reqMsg, 'end')
  return JSON.parse(`${Buffer.concat(chunks)}`)
}

// Splash (compact) is the default inline entrypoint; the full interactive
// experience only loads once the player taps in and requests 'game'.
// REGULAR (320px) matches the splash surface's intentionally compact layout.
async function routeMenuNewPost(): Promise<UiResponse> {
  const post = await reddit.submitCustomPost({
    title: context.appSlug,
    entry: 'default',
    styles: {height: EntrypointHeight.REGULAR},
  })
  return {
    showToast: {text: `Post ${post.id} created.`, appearance: 'success'},
    navigateTo: post.url,
  }
}

async function routeAppInstall(): Promise<TriggerResponse> {
  await reddit.submitCustomPost({
    title: context.appSlug,
    entry: 'default',
    styles: {height: EntrypointHeight.REGULAR},
  })
  return {}
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
