/**
 * Wire between the DSH renderer and one guest of the desktop client's built-in
 * Browser.
 *
 * That Browser hosts each page in an Electron `<webview>` whose guest runs with
 * `sandbox: true`, `contextIsolation: true` and no preload, so the two sides
 * share no messaging primitive the plugin could use:
 *
 * - host → page: `executeJavaScript` calls the bridge's receiver global;
 * - page → host: no preload means no `ipc-message`, and the guest has no parent
 *   window to `postMessage` to, so the host installs a bounded queue and drains
 *   it from the same call. A queue keeps working when the page replaces
 *   `console` (the only event-based alternative) and needs no per-Electron-version
 *   event shape.
 *
 * The bridge keeps treating every page-reported value as untrusted evidence; the
 * queue only decides who wins the wire.
 */
import {
  PREVIEW_BRIDGE_PROTOCOL,
  PREVIEW_BRIDGE_VERSION,
  type PreviewChannel,
} from '../preview-contract.ts'
import { isPreviewableUrl } from '../proxy-url.ts'
import type { PreviewCarrier } from './preview-bridge.ts'

/** Guest selector the built-in Browser marks its frame with. */
export const BROWSER_GUEST_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]'
/** Host-installed queue the bridge pushes its outbound payloads into. */
export const WEBVIEW_SINK_GLOBAL = '__DSH_WEB_REVIEW_WEBVIEW_SINK__'
/** Drain function the host calls on every poll. */
export const WEBVIEW_DRAIN_GLOBAL = '__dshWebReviewDrain'
/** Poll cadence while an annotation session is attached. */
export const WEBVIEW_POLL_INTERVAL_MS = 120
/** A guest smaller than this is not worth addressing. */
const MIN_VISIBLE_EDGE = 8
/** Bounded hold: a page that never gets drained must not grow without limit. */
const MAX_QUEUED_MESSAGES = 128
/** Per-poll cap; a burst is drained over the next ticks instead. */
const MAX_DRAINED_MESSAGES = 64
const MAX_MESSAGE_LENGTH = 1_048_576
const CHANNEL_PATTERN = /^[a-f\d]{32}$/u

/**
 * The subset of Electron's `<webview>` this transport uses.
 *
 * Spelled structurally so the plugin never depends on the Electron typings (it
 * must also run in a plain browser, where no guest exists at all).
 */
export interface WebviewGuest {
  readonly isConnected: boolean
  executeJavaScript: (code: string) => Promise<unknown>
  getURL: () => string
  getTitle: () => string
  getBoundingClientRect: () => { width: number; height: number; top: number; left: number; right: number; bottom: number }
  /** Electron's guest capture. Only the no-argument form works in a sandbox. */
  capturePage?: () => Promise<{
    toDataURL: () => string
    getSize: () => { width: number; height: number }
  }>
}

/** One page observation made on a poll. */
export interface WebviewPageState {
  href: string
  title: string
  /** Queue channel of the live document, or null when the bridge is not installed. */
  channel: string | null
}

/** Drain result: one page observation plus the payloads the bridge queued. */
export interface WebviewDrainState extends WebviewPageState {
  messages: string[]
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Narrow one DOM node to a usable guest. */
export function webviewGuestOf(value: unknown): WebviewGuest | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  if (typeof record.executeJavaScript !== 'function' || typeof record.getURL !== 'function'
    || typeof record.getTitle !== 'function' || typeof record.getBoundingClientRect !== 'function'
    || record.isConnected === false) return undefined
  return value as unknown as WebviewGuest
}

/** Every built-in Browser guest currently in the document. */
export function browserGuests(root: ParentNode = document): WebviewGuest[] {
  return scanBrowserGuests(root).guests
}

/**
 * One document survey of the Browser's frames.
 *
 * The three counts exist so a dock that cannot find a page can say why: no guest
 * element at all, a guest with a different marker, or a cross-origin iframe
 * (which this plugin cannot inject into).
 */
export interface BrowserGuestScan {
  /** Usable guests: a `<webview>` carrying the Browser frame marker. */
  guests: WebviewGuest[]
  /** Every `<webview>` element in the document, marked or not. */
  webviews: number
  /** Every element carrying `data-sidebar-browser-frame`, whatever its tag. */
  framed: number
  /** Cross-origin Browser iframes (the Web platform's shape). */
  iframes: number
}

/** Survey the document for Browser frames. */
export function scanBrowserGuests(root: ParentNode = document): BrowserGuestScan {
  const guests: WebviewGuest[] = []
  for (const element of root.querySelectorAll(BROWSER_GUEST_SELECTOR)) {
    const guest = webviewGuestOf(element)
    if (guest !== undefined) guests.push(guest)
  }
  return {
    guests,
    webviews: root.querySelectorAll('webview').length,
    framed: root.querySelectorAll('[data-sidebar-browser-frame]').length,
    iframes: root.querySelectorAll('iframe[data-sidebar-browser-frame]').length,
  }
}

/** Whether the guest is on screen, which also tells hidden Browser tabs apart. */
export function guestOnScreen(
  guest: WebviewGuest,
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): boolean {
  let rect: { width: number; height: number; top: number; left: number; right: number; bottom: number }
  try {
    rect = guest.getBoundingClientRect()
  } catch {
    return false
  }
  return rect.width >= MIN_VISIBLE_EDGE && rect.height >= MIN_VISIBLE_EDGE
    && rect.bottom > 0 && rect.right > 0
    && rect.top < viewport.height && rect.left < viewport.width
}

/**
 * The one guest the user is looking at.
 *
 * A Browser tab body stays mounted while another tab is active, so hidden tabs
 * keep their guest; only the visible rectangle identifies the page that can be
 * annotated.
 */
export function visibleBrowserGuest(root: ParentNode = document): WebviewGuest | undefined {
  return browserGuests(root).find(guest => guestOnScreen(guest))
}

/** The guest's committed address, when it is an annotatable HTTP(S) page. */
export function guestPageUrl(guest: WebviewGuest): string | undefined {
  try {
    const url = guest.getURL()
    return isPreviewableUrl(url) ? url : undefined
  } catch {
    // `getURL` throws until the guest reaches dom-ready.
    return undefined
  }
}

/** Longest edge of one capture; a full page is scaled down to keep the payload sane. */
const MAX_CAPTURE_EDGE = 1_200
/** Beyond this many characters of base64 a PNG is re-encoded as JPEG (maps). */
const MAX_PNG_CHARS = 900_000
/** JPEG quality for the fallback; plenty for a page shot. */
const JPEG_QUALITY = 0.82
/** Dimming outside the annotated region, so the target reads at a glance. */
const SPOTLIGHT_DIM = 'rgba(0, 0, 0, 0.45)'
/** Outline of the annotated region. */
const SPOTLIGHT_EDGE = '#4176e6'

/** Re-measure one element in the live page, in viewport coordinates. */
async function measure(
  guest: WebviewGuest,
): Promise<{ rect: { x: number; y: number; width: number; height: number }; viewport: { width: number; height: number } } | undefined> {
  try {
    const value = await guest.executeJavaScript(
      'window.__dshWebReviewMeasure === undefined ? null : window.__dshWebReviewMeasure()',
    )
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as { rect?: unknown; viewport?: unknown }
    const rect = record.rect as { x?: unknown; y?: unknown; width?: unknown; height?: number } | undefined
    const viewport = record.viewport as { width?: unknown; height?: unknown } | undefined
    if (rect === undefined || viewport === undefined) return undefined
    const numbers = [rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height]
    if (numbers.some(number => typeof number !== 'number' || !Number.isFinite(number))) return undefined
    return {
      rect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number },
      viewport: { width: viewport.width as number, height: viewport.height as number },
    }
  } catch {
    return undefined
  }
}

/** One capture attempt: base64 PNG when it worked, refusal text when it did not. */
export interface CaptureResult {
  data?: string
  error?: string
}

/**
 * Capture the whole page with the annotated element highlighted.
 *
 * A full page shows where the element sits (its surrounding layout is often the
 * point of the comment), while the rectangle itself stays at full brightness and
 * gains an outline; everything else is dimmed. The `capturePage(rect)` overload
 * cannot be used from this renderer: Electron's webview implementation needs
 * Node's `Buffer` there, and the desktop shell runs the page sandboxed
 * (`sandbox: true`, no Node), so that call rejects with "Buffer is not available
 * for the current Context". The no-argument form works, so the guest is captured
 * whole and the highlight is painted onto a canvas.
 * @param guest - the Browser guest owning the page.
 * @param rect - element rectangle in page CSS pixels.
 * @param viewport - the page viewport the rectangle is measured against.
 * @returns the marked page image, or the reason it could not be taken.
 */
export async function captureGuestRect(
  guest: WebviewGuest,
  fallback: { x: number; y: number; width: number; height: number },
  fallbackViewport: { width: number; height: number },
): Promise<CaptureResult> {
  const capture = guest.capturePage
  if (typeof capture !== 'function') return { error: 'capturePage unavailable' }
  try {
    // The rectangle was measured when the element was picked; a scroll between
    // picking and confirming moves it, and a stale rectangle paints the highlight
    // below the element (a second, misplaced box). Re-measure against the page
    // that is on screen right now.
    const measured = await measure(guest)
    const rect = measured?.rect ?? fallback
    const viewport = measured?.viewport ?? fallbackViewport
    const image = await capture.call(guest)
    const dataUrl = image.toDataURL()
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
    const outScale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * outScale))
    canvas.height = Math.max(1, Math.round(bitmap.height * outScale))
    const context = canvas.getContext('2d')
    if (context === null) return { error: 'canvas unavailable' }

    // The page as it is.
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    // Map the element rectangle from page CSS pixels onto image pixels.
    const scaleX = canvas.width / Math.max(1, viewport.width)
    const scaleY = canvas.height / Math.max(1, viewport.height)
    const sx = Math.min(canvas.width - 1, Math.max(0, Math.floor(rect.x * scaleX)))
    const sy = Math.min(canvas.height - 1, Math.max(0, Math.floor(rect.y * scaleY)))
    const sw = Math.min(canvas.width - sx, Math.max(1, Math.ceil(rect.width * scaleX)))
    const sh = Math.min(canvas.height - sy, Math.max(1, Math.ceil(rect.height * scaleY)))

    // Dim everything, then restore the target region's own pixels: a spotlight.
    context.fillStyle = SPOTLIGHT_DIM
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.save()
    context.beginPath()
    context.rect(sx, sy, sw, sh)
    context.clip()
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    context.restore()

    // Outline the region so it stays visible on a bright page.
    context.strokeStyle = SPOTLIGHT_EDGE
    context.lineWidth = Math.max(2, Math.round(2 * outScale))
    context.strokeRect(sx + 1, sy + 1, Math.max(1, sw - 2), Math.max(1, sh - 2))

    bitmap.close()
    // A dense page (a map canvas) compresses poorly as PNG and the sync body then
    // exceeds the protocol limit, which used to fail the whole annotation. JPEG
    // keeps the shot while staying an order of magnitude smaller.
    let encoded = canvas.toDataURL('image/png')
    if (encoded.length > MAX_PNG_CHARS) encoded = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
    if (!encoded.startsWith('data:image/')) return { error: 'empty capture' }
    return { data: encoded }
  } catch (error) {
    return { error: error instanceof Error ? error.message.slice(0, 200) : 'capture failed' }
  }
}

/** The guest's document title, best effort. */
export function guestPageTitle(guest: WebviewGuest): string {
  try {
    return guest.getTitle().slice(0, 500)
  } catch {
    return ''
  }
}

/** Page-side probe: current address, title, and queue channel. */
export const WEBVIEW_PROBE_SOURCE = `(() => {
  try {
    const sink = window.${WEBVIEW_SINK_GLOBAL}
    return {
      href: String(location.href),
      title: typeof document.title === 'string' ? document.title.slice(0, 500) : '',
      channel: typeof sink === 'object' && sink !== null && typeof sink.channel === 'string'
        ? sink.channel
        : null,
    }
  } catch (error) {
    return null
  }
})()`

/** Page-side drain: one page observation plus every queued payload. */
export const WEBVIEW_DRAIN_SOURCE = `(() => {
  try {
    const drain = window.${WEBVIEW_DRAIN_GLOBAL}
    const sink = window.${WEBVIEW_SINK_GLOBAL}
    const messages = typeof drain === 'function' ? drain() : []
    return {
      href: String(location.href),
      title: typeof document.title === 'string' ? document.title.slice(0, 500) : '',
      channel: typeof sink === 'object' && sink !== null && typeof sink.channel === 'string'
        ? sink.channel
        : null,
      messages: Array.isArray(messages)
        ? messages.filter(item => typeof item === 'string').slice(0, ${String(MAX_DRAINED_MESSAGES)})
        : [],
    }
  } catch (error) {
    return null
  }
})()`

function pageStateOf(record: Record<string, unknown>): WebviewPageState | undefined {
  if (typeof record.href !== 'string' || record.href.length > 32_768) return undefined
  if (typeof record.title !== 'string' || record.title.length > 500) return undefined
  const channel = record.channel
  if (channel !== null && (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel))) return undefined
  return { href: record.href, title: record.title, channel }
}

/** Parse one probe result. */
export function webviewPageStateOf(value: unknown): WebviewPageState | undefined {
  const record = recordOf(value)
  return record === undefined ? undefined : pageStateOf(record)
}

/** Parse one drain result. */
export function webviewDrainStateOf(value: unknown): WebviewDrainState | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const page = pageStateOf(record)
  if (page === undefined || !Array.isArray(record.messages)) return undefined
  const messages = record.messages.filter((item): item is string => (
    typeof item === 'string' && item.length <= MAX_MESSAGE_LENGTH
  ))
  return { ...page, messages }
}

/** The page-side queue the host drains, installed before the bridge runs. */
export function webviewBootstrapSource(channel: PreviewChannel): string {
  return `(() => {
  const queue = []
  window.${WEBVIEW_SINK_GLOBAL} = {
    channel: ${JSON.stringify(channel)},
    push(payload) {
      if (typeof payload !== 'string' || payload === '' || payload.length > ${String(MAX_MESSAGE_LENGTH)}) return
      if (queue.length >= ${String(MAX_QUEUED_MESSAGES)}) queue.shift()
      queue.push(payload)
    },
  }
  window.${WEBVIEW_DRAIN_GLOBAL} = () => queue.splice(0, queue.length)
})()`
}

/** The frozen configuration one guest bridge runs with. */
export interface WebviewBridgeConfig {
  protocol: typeof PREVIEW_BRIDGE_PROTOCOL
  version: typeof PREVIEW_BRIDGE_VERSION
  channel: PreviewChannel
  parentOrigin: string
  pageUrl: string
  targetOrigin: string
}

/** One shot of `executeJavaScript` that installs the queue, config, and bridge. */
export async function injectWebviewBridge(
  guest: WebviewGuest,
  config: WebviewBridgeConfig,
  bridgeSource: string,
): Promise<void> {
  const source = [
    webviewBootstrapSource(config.channel),
    `window.__DSH_WEB_REVIEW_BRIDGE_CONFIG__=${JSON.stringify(config)};`,
    // The map comment would resolve against the guest's own Origin and 404.
    bridgeSource.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/u, '\n'),
  ].join('\n')
  await guest.executeJavaScript(source)
}

/** Escape one JSON string for embedding in a script literal. */
function scriptLiteral(value: unknown): string {
  return JSON.stringify(JSON.stringify(value))
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

/** Read the guest's page state without draining the queue. */
export async function probeWebviewPage(guest: WebviewGuest): Promise<WebviewPageState | undefined> {
  try {
    return webviewPageStateOf(await guest.executeJavaScript(WEBVIEW_PROBE_SOURCE))
  } catch {
    return undefined
  }
}

export interface WebviewCarrierOptions {
  /** Channel this carrier's bridge was configured with. */
  channel: string
  /** Origin every delivered page message is reported under. */
  frameOrigin: string
  /** One observation per poll; `channel` is null on an un-injected document. */
  onPage?: (page: WebviewPageState) => void
  /**
   * The document no longer carries this carrier's queue: it navigated, and the
   * caller must inject again and rebuild its bridge.
   */
  onStale?: (page: WebviewPageState) => void
  intervalMs?: number
}

/** A carrier that outlives nothing: dispose stops its poll. */
export type WebviewCarrier = PreviewCarrier & { dispose: () => void }

/**
 * Carrier over one guest document.
 *
 * Messages arrive only through the drained queue, so `subscribe` starts the poll
 * and its disposer stops it once the bridge client goes away.
 */
export function webviewCarrier(guest: WebviewGuest, options: WebviewCarrierOptions): WebviewCarrier {
  const handlers = new Set<(message: unknown, origin: string) => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let draining = false
  let disposed = false

  const stopPoll = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  const drain = async (): Promise<void> => {
    if (disposed || draining) return
    draining = true
    let value: unknown
    try {
      value = await guest.executeJavaScript(WEBVIEW_DRAIN_SOURCE)
    } catch {
      value = undefined
    }
    draining = false
    if (disposed) return
    const state = webviewDrainStateOf(value)
    if (state === undefined) {
      if (!guest.isConnected) dispose()
      return
    }
    options.onPage?.(state)
    if (state.channel !== options.channel) {
      options.onStale?.(state)
      return
    }
    for (const payload of state.messages) {
      let message: unknown
      try {
        message = JSON.parse(payload) as unknown
      } catch {
        continue
      }
      for (const handler of handlers) handler(message, options.frameOrigin)
    }
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stopPoll()
    handlers.clear()
  }

  return {
    post(message) {
      if (disposed) return false
      const receiver = `window.__dshWebReviewReceive`
      void guest
        .executeJavaScript(`if (typeof ${receiver} === 'function') ${receiver}(${scriptLiteral(message)})`)
        .catch(() => undefined)
      return true
    },
    subscribe(handler) {
      handlers.add(handler)
      if (timer === undefined && !disposed) {
        void drain()
        timer = setInterval(() => { void drain() }, options.intervalMs ?? WEBVIEW_POLL_INTERVAL_MS)
      }
      return () => {
        handlers.delete(handler)
        if (handlers.size === 0) stopPoll()
      }
    },
    dispose,
  }
}
