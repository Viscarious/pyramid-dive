import {type ClientErrorReq, Endpoint} from '../shared/api.ts'

// Webview console errors don't surface in `devvit logs` — this posts them
// to the server so they show up there instead of failing silently during
// development (see CLAUDE_CODE_PROMPT.md item 8).
//
// Plain fetch() only — confirmed via live testing that Devvit's webview
// transparently authenticates normal fetch() calls to the app's own
// endpoints (how every other endpoint call in this app works), but
// navigator.sendBeacon bypasses that and gets rejected 401 before it ever
// reaches our server code. keepalive:true covers the same "survives page
// teardown" case sendBeacon was meant for.
function report(message: string, stack: string, source: string): void {
  const req: ClientErrorReq = {message, stack, source}
  try {
    fetch(Endpoint.ClientError, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(req),
      keepalive: true,
    }).catch(() => {})
  } catch {}
}

/** Call once, as early as possible, on each client entrypoint. */
export function installErrorReporting(source: string): void {
  window.addEventListener('error', ev => {
    report(
      ev.message,
      ev.error instanceof Error ? (ev.error.stack ?? '') : '',
      source,
    )
  })
  window.addEventListener('unhandledrejection', ev => {
    const reason = ev.reason as unknown
    const message = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? (reason.stack ?? '') : ''
    report(`Unhandled rejection: ${message}`, stack, source)
  })
}
