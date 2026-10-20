/**
 * Temporary self-check badge for the built-in Browser attachment.
 *
 * The desktop shell exposes no console the user can open, and a dock that never
 * mounts is indistinguishable from a dock that renders nothing, so this badge
 * lives outside React: it proves the client module is alive and prints the same
 * document survey the dock uses. Remove it (and its `installSelfCheck` call)
 * once the attachment is verified on the real client.
 */
import {
  PREVIEW_CLIENT_HEADER,
  PREVIEW_CLIENT_HEADER_VALUE,
  WEBVIEW_DIAGNOSTICS_PATH,
} from '../preview-contract.ts'
import { scanBrowserGuests } from './webview-guest.ts'

const BADGE_ID = 'dsh-web-review-selfcheck'
const INTERVAL_MS = 500

/**
 * Send one diagnostics snapshot to the node half's ring.
 *
 * The desktop shell has no console, so this is the only channel that survives a
 * dock that never mounts: the newest snapshots are readable over HTTP.
 * @param payload - bounded JSON-serializable state.
 */
export function reportDiagnostics(payload: Record<string, unknown>): void {
  try {
    void fetch(WEBVIEW_DIAGNOSTICS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE },
      body: JSON.stringify(payload).slice(0, 8 * 1024),
    }).catch(() => undefined)
  } catch {
    // Diagnostics never fail the caller.
  }
}

/** Text one survey renders as. */
export function selfCheckLine(
  scan: ReturnType<typeof scanBrowserGuests>,
  dock: { mounted: boolean; seen: boolean; state: string; height: number; width: number },
  ticks: number,
): string {
  const shape = dock.mounted
    ? `${String(Math.round(dock.width))}x${String(Math.round(dock.height))} ${dock.state}`
    : 'no'
  return `批注自检 ${String(ticks)} · 容器 ${String(scan.guests.length)}/${String(scan.webviews)}`
    + `/${String(scan.framed)}/${String(scan.iframes)}`
    + ` · dock ${shape}${dock.seen ? ' · was:yes' : ''}`
}

/**
 * Install the badge and its heartbeat.
 * @returns the disposer removing both.
 */
export function installSelfCheck(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const badge = document.createElement('div')
  badge.id = BADGE_ID
  badge.dataset.webviewSelfcheck = ''
  badge.setAttribute('aria-hidden', 'true')
  badge.style.cssText = [
    'position:fixed',
    'left:8px',
    'bottom:8px',
    'z-index:2147483000',
    'padding:2px 6px',
    'border-radius:6px',
    'background:rgb(0 0 0 / 72%)',
    'color:#fff',
    'font:10px/14px ui-monospace, monospace',
    'pointer-events:none',
    'white-space:nowrap',
  ].join(';')
  // The client module queue runs from `<head>`, before `<body>` exists, and a
  // throw here would take the whole plugin fiber with it.
  const host = document.body ?? document.documentElement
  if (host === null) return () => undefined
  host.append(badge)
  let ticks = 0
  let seen = false
  const tick = (): void => {
    ticks += 1
    reportDiagnostics({ kind: 'tick', tick: ticks })
    const dock = document.querySelector('[data-webview-browser-dock]')
    const rect = dock?.getBoundingClientRect()
    if (dock !== null) seen = true
    const scan = scanBrowserGuests()
    const shape = {
      mounted: dock !== null,
      seen,
      state: dock?.getAttribute('data-webview-dock-state') ?? '-',
      height: rect?.height ?? 0,
      width: rect?.width ?? 0,
    }
    badge.textContent = selfCheckLine(scan, shape, ticks)
    reportDiagnostics({
      kind: 'tick',
      tick: ticks,
      dock: shape,
      scan: {
        guests: scan.guests.length,
        webviews: scan.webviews,
        framed: scan.framed,
        iframes: scan.iframes,
      },
    })
  }
  tick()
  const timer = setInterval(tick, INTERVAL_MS)
  return () => {
    clearInterval(timer)
    badge.remove()
  }
}
