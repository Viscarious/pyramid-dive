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
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson<ErrorRsp>(500, {error: msg, status: 500}, rspMsg)
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
        rsp = await getHub(requireUserId())
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
