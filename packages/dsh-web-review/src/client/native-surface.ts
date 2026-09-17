/**
 * Native panel surface: the desktop shell renders this preview in its own
 * WKWebView, so the page draws a placeholder where the panel belongs.
 *
 * The surface owns no pixels. It reports the placeholder's rectangle to the
 * host (which places the shell's panel over it), hides the panel when the
 * placeholder leaves the viewport, and keeps the bridge carrier working exactly
 * like the canvas surface does — the panel page talks over the same stream.
 */
import {
  PREVIEW_BROWSER_INPUT_PATH,
  PREVIEW_BROWSER_STREAM_PATH,
  PREVIEW_CLIENT_HEADER,
  PREVIEW_CLIENT_HEADER_VALUE,
  type PreviewBrowserCommand,
  type PreviewSessionDescriptor,
} from '../preview-contract.ts'
import type { PreviewCarrier } from './preview-bridge.ts'

/** Stream callback fan-out owned by the view. */
export interface NativeSurfaceEvents {
  onState: (state: { url: string; title: string; loading: boolean }) => void
  onError: (message: string) => void
}

/** Panels smaller than this are treated as "not on screen yet". */
const MIN_VISIBLE_EDGE = 8
/** A layout that moves without resizing (a toolbar growing) still has to be seen. */
const RECHECK_INTERVAL_MS = 800
/** First report waits for the host to finish laying its chrome out. */
const FIRST_REPORT_DELAY_MS = 120

/** One real shell panel standing in for a placeholder element. */
export class NativeBrowserSurface {
  private readonly descriptor: PreviewSessionDescriptor
  private readonly events: NativeSurfaceEvents
  private readonly bridgeHandlers = new Set<(message: unknown, origin: string) => void>()
  private stream: EventSource | null = null
  private element: HTMLElement | null = null
  private observer: ResizeObserver | null = null
  private scrollListener: (() => void) | null = null
  private reportTimer: ReturnType<typeof setTimeout> | undefined
  private firstReportTimer: ReturnType<typeof setTimeout> | undefined
  private recheckTimer: ReturnType<typeof setInterval> | undefined
  private lastBounds = ''
  private visible = true
  /** False while the tab holding this surface is not the visible one. */
  private shown = true
  private disposed = false

  constructor(descriptor: PreviewSessionDescriptor, events: NativeSurfaceEvents) {
    this.descriptor = descriptor
    this.events = events
  }

  /**
   * Attach the surface to the placeholder element the panel covers.
   * @param element - the element the native panel is placed over.
   * @returns the detach function.
   */
  attach(element: HTMLElement): () => void {
    this.element = element
    this.openStream()
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => { this.scheduleReport() })
      this.observer.observe(element)
      // A neighbouring row can change height without resizing this element, and a
      // ResizeObserver would never hear about it: the panel would sit at a stale
      // offset (the classic "it covers the address bar" case).
      const parent = element.parentElement
      if (parent !== null) this.observer.observe(parent)
    }
    const onScroll = (): void => { this.scheduleReport() }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    this.scrollListener = () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
    // Report once the host chrome has settled, then keep re-checking: a rect that
    // is wrong for any reason repairs itself instead of staying wrong.
    const settle = (attempt: number): void => {
      if (this.disposed) return
      this.reportBounds(true)
      if (attempt < 3) this.firstReportTimer = setTimeout(() => { settle(attempt + 1) }, FIRST_REPORT_DELAY_MS * (attempt + 1))
    }
    const start = (): void => { settle(0) }
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { requestAnimationFrame(start) })
    } else {
      start()
    }
    // Forced, not deduplicated: a pane can move without resizing when a
    // neighbouring column opens or closes, and a ResizeObserver never hears
    // about that. The panel would keep the old offset and cover what moved.
    this.recheckTimer = setInterval(() => { this.reportBounds(true) }, RECHECK_INTERVAL_MS)
    return () => {
      this.observer?.disconnect()
      this.observer = null
      this.scrollListener?.()
      this.scrollListener = null
      if (this.reportTimer !== undefined) clearTimeout(this.reportTimer)
      this.reportTimer = undefined
      if (this.firstReportTimer !== undefined) clearTimeout(this.firstReportTimer)
      this.firstReportTimer = undefined
      if (this.recheckTimer !== undefined) clearInterval(this.recheckTimer)
      this.recheckTimer = undefined
      if (this.visible) {
        this.visible = false
        void this.send({ kind: 'bounds', x: 0, y: 0, width: 0, height: 0, visible: false }).catch(() => undefined)
      }
      this.element = null
    }
  }

  /**
   * Show or hide the panel without touching the page.
   *
   * A tab body stays mounted while another tab is active, so the panel must
   * follow its own tab's visibility or it would float over the new tab.
   * @param shown - whether this surface's tab is the visible one.
   */
  setVisible(shown: boolean): void {
    if (this.shown === shown) return
    this.shown = shown
    this.reportBounds(true)
  }

  /** Host side of the bridge: commands go out, page messages come in. */
  carrier(): PreviewCarrier {
    return {
      post: (message) => {
        if (this.disposed) return false
        void this.command({ name: 'bridge', payload: JSON.stringify(message) }).catch(() => undefined)
        return true
      },
      subscribe: (handler) => {
        this.bridgeHandlers.add(handler)
        return () => { this.bridgeHandlers.delete(handler) }
      },
    }
  }

  private openStream(): void {
    const query = `?sessionId=${encodeURIComponent(this.descriptor.sessionId)}&channel=${encodeURIComponent(this.descriptor.channel)}`
    const stream = new EventSource(`${PREVIEW_BROWSER_STREAM_PATH}${query}`)
    stream.onmessage = (event: MessageEvent<string>) => { this.handleEvent(event.data) }
    stream.onerror = () => {
      if (!this.disposed && stream.readyState === EventSource.CLOSED) this.events.onError('preview stream closed')
    }
    this.stream = stream
  }

  private handleEvent(raw: string): void {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (payload.type === 'state') {
      // The panel reports its own address and title from inside the page.
      this.events.onState({
        url: typeof payload.url === 'string' ? payload.url : '',
        title: typeof payload.title === 'string' ? payload.title : '',
        loading: payload.loading === true,
      })
      return
    }
    if (payload.type === 'bridge') {
      let message: unknown
      try {
        message = JSON.parse(String(payload.payload)) as unknown
      } catch {
        return
      }
      for (const handler of this.bridgeHandlers) handler(message, this.descriptor.frameOrigin)
      return
    }
    if (payload.type === 'error') this.events.onError(String(payload.message))
  }

  /** Coalesce geometry churn into one report per frame. */
  private scheduleReport(): void {
    if (this.disposed) return
    if (this.reportTimer !== undefined) return
    this.reportTimer = setTimeout(() => {
      this.reportTimer = undefined
      this.reportBounds(false)
    }, 60)
  }

  private reportBounds(force: boolean): void {
    const element = this.element
    if (element === null || this.disposed) return
    const rect = element.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    const onScreen = this.shown
      && width >= MIN_VISIBLE_EDGE && height >= MIN_VISIBLE_EDGE
      && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth
    const bounds = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: onScreen ? width : 0,
      height: onScreen ? height : 0,
      visible: onScreen,
    }
    const key = `${String(bounds.x)},${String(bounds.y)},${String(bounds.width)},${String(bounds.height)},${String(bounds.visible)}`
    if (!force && key === this.lastBounds) return
    this.lastBounds = key
    this.visible = bounds.visible
    void this.send({ kind: 'bounds', ...bounds }).catch(() => undefined)
  }

  private send(input: Record<string, unknown>): Promise<{ screenshot?: string }> {
    return this.request({ input })
  }

  /** Issue one panel command (reload/screenshot/navigation/bridge). */
  command(command: PreviewBrowserCommand): Promise<{ screenshot?: string }> {
    return this.request({ command })
  }

  private async request(body: Record<string, unknown>): Promise<{ screenshot?: string }> {
    const response = await fetch(PREVIEW_BROWSER_INPUT_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
      },
      body: JSON.stringify({
        sessionId: this.descriptor.sessionId,
        channel: this.descriptor.channel,
        ...body,
      }),
    })
    if (!response.ok) throw new Error(`preview input rejected (${String(response.status)})`)
    return await response.json() as { screenshot?: string }
  }

  /** Hide the panel and drop every listener. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.reportTimer !== undefined) clearTimeout(this.reportTimer)
    this.reportTimer = undefined
    if (this.firstReportTimer !== undefined) clearTimeout(this.firstReportTimer)
    this.firstReportTimer = undefined
    if (this.recheckTimer !== undefined) clearInterval(this.recheckTimer)
    this.recheckTimer = undefined
    this.stream?.close()
    this.stream = null
    this.observer?.disconnect()
    this.observer = null
    this.scrollListener?.()
    this.scrollListener = null
    this.bridgeHandlers.clear()
    // The session release closes the panel; hiding first avoids a flash of the
    // panel over whatever the user just switched to.
    if (this.element !== null) {
      void this.send({ kind: 'bounds', x: 0, y: 0, width: 0, height: 0, visible: false }).catch(() => undefined)
    }
    this.element = null
  }
}
