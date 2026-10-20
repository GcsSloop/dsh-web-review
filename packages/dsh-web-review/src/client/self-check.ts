/**
 * Temporary self-check badge for the built-in Browser attachment.
 *
 * The desktop shell exposes no console the user can open, and a dock that never
 * mounts is indistinguishable from a dock that renders nothing, so this badge
 * lives outside React: it proves the client module is alive and prints the same
 * document survey the dock uses. Remove it (and its `installSelfCheck` call)
 * once the attachment is verified on the real client.
 */
import { scanBrowserGuests } from './webview-guest.ts'

const BADGE_ID = 'dsh-web-review-selfcheck'
const INTERVAL_MS = 500

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
  document.body.append(badge)
  let ticks = 0
  let seen = false
  const tick = (): void => {
    ticks += 1
    const dock = document.querySelector('[data-webview-browser-dock]')
    const rect = dock?.getBoundingClientRect()
    if (dock !== null) seen = true
    badge.textContent = selfCheckLine(scanBrowserGuests(), {
      mounted: dock !== null,
      seen,
      state: dock?.getAttribute('data-webview-dock-state') ?? '-',
      height: rect?.height ?? 0,
      width: rect?.width ?? 0,
    }, ticks)
  }
  tick()
  const timer = setInterval(tick, INTERVAL_MS)
  return () => {
    clearInterval(timer)
    badge.remove()
  }
}
