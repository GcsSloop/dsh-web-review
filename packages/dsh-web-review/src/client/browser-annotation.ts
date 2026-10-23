/**
 * Host-side annotation session for the desktop client's built-in Browser.
 *
 * The plugin no longer owns a preview surface: the user browses in the host's
 * Browser tab, and this controller attaches the picker to that guest on demand
 * (the dock's annotate action), then drives the same `PreviewBridgeClient` the
 * isolated transports use. Nothing here creates a page session on the node half:
 * the guest loads its own URL, and the plugin only injects the picker.
 *
 * Lifecycle:
 * 1. a low-frequency scan announces the visible Browser page (or its absence);
 * 2. `activate()` attaches: probe the guest, inject queue + bridge when the
 *    document has none, build a synthetic descriptor for that document;
 * 3. the carrier polls the queue; a document change is reported as a handoff and
 *    the controller re-attaches against the new document;
 * 4. `detach()` drops the bridge client, its carrier, and the poll.
 */
import type { AnnotationStyleChange, AnnotationTextChange } from '../annotation-contract.ts'
import type { EditableStyleProperty } from '../annotation-properties.ts'
import {
  PREVIEW_BRIDGE_PROTOCOL,
  PREVIEW_BRIDGE_SOURCE_PATH,
  PREVIEW_BRIDGE_VERSION,
  PREVIEW_CLIENT_HEADER,
  PREVIEW_CLIENT_HEADER_VALUE,
  type PreviewChannel,
  type PreviewElementHandle,
  type PreviewElementNavigationAction,
  type PreviewElementTarget,
  type PreviewSessionDescriptor,
  type PreviewSessionId,
  type PreviewTreeNode,
} from '../preview-contract.ts'
import { isPreviewableUrl } from '../proxy-url.ts'
import type { PickItem } from './contract.ts'
import { PreviewBridgeClient, type PreviewReadyState } from './preview-bridge.ts'
import {
  captureGuestRect,
  reportChromeProbe,
  guestOnScreen,
  guestPageTitle,
  guestPageUrl,
  injectWebviewBridge,
  probeWebviewPage,
  scanBrowserGuests,
  webviewCarrier,
  type WebviewBridgeConfig,
  type BrowserGuestScan,
  type WebviewCarrier,
  type WebviewGuest,
  type WebviewPageState,
} from './webview-guest.ts'

/** How often an idle dock re-checks for a visible Browser page. */
const BROWSER_SCAN_INTERVAL_MS = 600

/** One Browser page the plugin can annotate. */
export interface BrowserPage {
  url: string
  title: string
}

/** Why there is no page to annotate, when there is none. */
export type BrowserIdleReason =
  /** No built-in Browser guest exists in the document. */
  | 'no-guest'
  /** A guest exists but its tab/pane is not on screen. */
  | 'not-visible'
  /** The visible guest is not on a credential-free HTTP(S) page yet. */
  | 'not-http'

/** Why attaching failed, localized by the dock. */
export type BrowserAnnotationFailure = 'no-page' | 'bridge-unavailable'

/** Host callbacks; the dock mirrors each one into store state or a transaction. */
export interface BrowserAnnotationEvents {
  /** The visible Browser page changed; null when there is none to annotate. */
  onPage: (page: BrowserPage | null) => void
  /** Why there is no page, for the dock's hint (only meaningful while onPage is null). */
  onIdle: (reason: BrowserIdleReason) => void
  /** Document survey for the hint's diagnostics. */
  onScan: (scan: BrowserGuestScan) => void
  onReady: (ready: PreviewReadyState) => void
  onPick: (target: PreviewElementTarget) => void
  onCancelPick: () => void
  onMarkClick: (pickId: string) => void
  onTargetGeometry: (
    handle: PreviewElementHandle,
    rect: PreviewElementTarget['rect'],
    viewport: PreviewElementTarget['viewport'],
  ) => void
  onShortcut: (action: PreviewElementNavigationAction) => void
  /**
   * The guest document changed; page-side element handles no longer resolve.
   * The argument is the page the bridge is being rebuilt against.
   */
  onHandoff: (next: BrowserPage | null) => void
  onUnavailable: () => void
  onFailure: (failure: BrowserAnnotationFailure) => void
}

function randomCapability(): string {
  const values = crypto.getRandomValues(new Uint8Array(16))
  return [...values].map(value => value.toString(16).padStart(2, '0')).join('')
}

/** The bridge source is one immutable artifact per page load: fetch it once. */
let bridgeSourceCache: Promise<string> | undefined

function loadBridgeSource(): Promise<string> {
  bridgeSourceCache ??= fetch(PREVIEW_BRIDGE_SOURCE_PATH, {
    cache: 'no-store',
    headers: { [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE },
  }).then(async (response) => {
    if (!response.ok) throw new Error(`bridge source unavailable (${String(response.status)})`)
    const source = await response.text()
    if (source === '') throw new Error('bridge source is empty')
    return source
  }).catch((error: unknown) => {
    // A fresh attempt may succeed after a transient failure.
    bridgeSourceCache = undefined
    throw error instanceof Error ? error : new Error('bridge source unavailable')
  })
  return bridgeSourceCache
}

/** One annotation session over whichever Browser guest is on screen. */
export class BrowserAnnotationSession {
  private started = false
  private disposed = false
  private scanTimer: ReturnType<typeof setInterval> | undefined
  private guest: WebviewGuest | null = null
  private carrier: WebviewCarrier | null = null
  private bridge: PreviewBridgeClient | null = null
  private attachTask: Promise<void> | null = null
  private recovering = false
  private pickMode = false
  private picks: readonly PickItem[] = []
  private page: BrowserPage | null = null

  constructor(private readonly events: BrowserAnnotationEvents) {}

  /** Whether a picker is currently attached to a guest document. */
  get attached(): boolean {
    return this.bridge !== null
  }

  /** Re-scan the document now instead of waiting for the next interval. */
  refresh(): void {
    this.scan()
  }

  /** Start watching for a Browser page; the dock calls this once on mount. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.scan()
    this.scanTimer = setInterval(() => { this.scan() }, BROWSER_SCAN_INTERVAL_MS)
  }

  /**
   * Attach the picker and arm it.
   *
   * The caller has already marked annotation mode on; a failure leaves the
   * picker unarmed and reports why.
   */
  async activate(): Promise<void> {
    this.pickMode = true
    try {
      await this.attach()
    } catch (error) {
      this.pickMode = false
      this.events.onFailure(error instanceof Error && error.message === 'no-page'
        ? 'no-page'
        : 'bridge-unavailable')
      return
    }
    this.bridge?.activate()
  }

  /** Leave annotation mode without dropping the attached bridge. */
  deactivate(): void {
    this.pickMode = false
    this.bridge?.deactivate()
    this.bridge?.cancelEdit()
  }

  /** Keep the page's numbered markers in step with the host pick list. */
  setPicks(picks: readonly PickItem[]): void {
    this.picks = picks
    this.bridge?.syncMarkers(picks)
  }

  /** Capture one element rectangle for the annotation review. */
  async capture(
    rect: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number },
  ): Promise<{ data?: string; error?: string }> {
    const guest = this.guest
    if (guest === null) return { error: 'not attached' }
    void reportChromeProbe(guest)
    return await captureGuestRect(guest, rect, viewport)
  }

  /** Re-open one existing pick's element in the page. */
  async openPick(pickId: string, cssPath: string): Promise<PreviewElementTarget | null> {
    const bridge = this.bridge
    if (bridge === null) return null
    return await bridge.openPick(pickId, cssPath)
  }

  async navigateElement(
    handle: PreviewElementHandle,
    action: PreviewElementNavigationAction,
  ): Promise<PreviewElementTarget | null> {
    return (await this.bridge?.navigateElement(handle, action)) ?? null
  }

  async selectElement(handle: PreviewElementHandle): Promise<PreviewElementTarget | null> {
    return (await this.bridge?.selectElement(handle)) ?? null
  }

  async readTree(handle: PreviewElementHandle): Promise<PreviewTreeNode | null> {
    return (await this.bridge?.readTree(handle)) ?? null
  }

  previewStyle(handle: PreviewElementHandle, property: EditableStyleProperty, value: string): void {
    this.bridge?.previewStyle(handle, property, value)
  }

  restoreStyle(handle: PreviewElementHandle, property: EditableStyleProperty): void {
    this.bridge?.restoreStyle(handle, property)
  }

  previewText(handle: PreviewElementHandle, value: string): void {
    this.bridge?.previewText(handle, value)
  }

  restoreText(handle: PreviewElementHandle): void {
    this.bridge?.restoreText(handle)
  }

  commitEdit(
    pickId: string,
    handle: PreviewElementHandle,
    changes: AnnotationStyleChange[],
    textChange: AnnotationTextChange | null,
  ): void {
    this.bridge?.commitEdit(pickId, handle, changes, textChange)
  }

  cancelEdit(): void {
    this.bridge?.cancelEdit()
  }

  /** Drop the bridge, its carrier, and the poll; the guest keeps its markers until reload. */
  detach(): void {
    this.disposeBridge()
    this.guest = null
  }

  /** Release everything; the dock calls this on unmount. */
  stop(): void {
    if (this.disposed) return
    this.disposed = true
    this.started = false
    if (this.scanTimer !== undefined) clearInterval(this.scanTimer)
    this.scanTimer = undefined
    this.detach()
  }

  private disposeBridge(): void {
    this.bridge?.dispose()
    this.bridge = null
    this.carrier?.dispose()
    this.carrier = null
  }

  private scan(): void {
    if (this.disposed) return
    const scan = scanBrowserGuests()
    this.events.onScan(scan)
    const guests = scan.guests
    const guest = guests.find(candidate => guestOnScreen(candidate))
    if (this.guest !== null && guest !== this.guest) {
      // The attached guest left the document (Browser tab closed or replaced).
      this.detach()
    }
    const url = guest === undefined ? undefined : guestPageUrl(guest)
    const next = guest === undefined || url === undefined
      ? null
      : { url, title: guestPageTitle(guest) }
    if (next === null && guest === undefined) {
      this.events.onIdle(guests.length === 0 ? 'no-guest' : 'not-visible')
    } else if (next === null) {
      this.events.onIdle('not-http')
    }
    if (next?.url === this.page?.url && next?.title === this.page?.title) return
    this.page = next
    this.events.onPage(next)
  }

  private async attach(): Promise<void> {
    if (this.attachTask !== null) return await this.attachTask
    const task = this.attachInner()
    this.attachTask = task
    try {
      await task
    } finally {
      if (this.attachTask === task) this.attachTask = null
    }
  }

  private async attachInner(): Promise<void> {
    if (this.disposed) throw new Error('no-page')
    if (this.bridge !== null) {
      // Already attached: reuse it, and repair the arm state on the way out.
      return
    }
    const guest = scanBrowserGuests().guests.find(candidate => guestOnScreen(candidate))
    if (guest === undefined) throw new Error('no-page')
    const probe = await probeWebviewPage(guest)
    const href = probe === undefined || !isPreviewableUrl(probe.href) ? guestPageUrl(guest) : probe.href
    if (href === undefined || !isPreviewableUrl(href)) throw new Error('no-page')
    const targetOrigin = new URL(href).origin
    const channel = probe?.channel ?? randomCapability()
    if (probe === undefined || probe.channel === null) {
      const source = await loadBridgeSource()
      const config: WebviewBridgeConfig = {
        protocol: PREVIEW_BRIDGE_PROTOCOL,
        version: PREVIEW_BRIDGE_VERSION,
        channel: channel as PreviewChannel,
        // Nothing is posted to a parent window here; the bridge only validates
        // this field and the queue carries every message.
        parentOrigin: window.location.origin,
        pageUrl: href,
        targetOrigin,
      }
      try {
        await injectWebviewBridge(guest, config, source)
      } catch {
        throw new Error('bridge-unavailable')
      }
    }
    if (this.disposed) return
    const descriptor: PreviewSessionDescriptor = {
      sessionId: randomCapability() as PreviewSessionId,
      // The guest keeps its true Origin and cookies, exactly like the plugin's
      // CDP browser transport; the host owns no session for it.
      mode: 'browser',
      frameUrl: href,
      frameOrigin: targetOrigin,
      targetOrigin,
      channel: channel as PreviewChannel,
    }
    const carrier = webviewCarrier(guest, {
      channel,
      frameOrigin: targetOrigin,
      onPage: (page) => { this.observe(page) },
      onStale: (page) => { this.recover(page) },
    })
    const bridge = new PreviewBridgeClient(carrier, descriptor, {
      onReady: (ready) => {
        this.events.onReady(ready)
        bridge.syncMarkers(this.picks)
        if (this.pickMode) bridge.activate()
      },
      onPick: (target) => { this.events.onPick(target) },
      onCancelPick: () => { this.events.onCancelPick() },
      onMarkClick: (pickId) => { this.events.onMarkClick(pickId) },
      onTargetGeometry: (handle, rect, viewport) => { this.events.onTargetGeometry(handle, rect, viewport) },
      onShortcut: (action) => { this.events.onShortcut(action) },
      onHandoff: () => { this.recover({ href: this.page?.url ?? href, title: this.page?.title ?? '', channel: null }) },
      onUnavailable: () => { this.events.onUnavailable() },
    })
    this.guest = guest
    this.carrier = carrier
    this.bridge = bridge
    this.page = { url: href, title: this.page?.url === href ? this.page.title : guestPageTitle(guest) }
    this.events.onPage(this.page)
    bridge.frameLoaded()
  }

  /** The carrier's own observation; only changed pages reach the dock. */
  private observe(page: WebviewPageState): void {
    if (this.page !== null && this.page.url === page.href && this.page.title === page.title) return
    this.page = { url: page.href, title: page.title }
    this.events.onPage(this.page)
  }

  /**
   * Re-attach after the guest document was replaced.
   *
   * The injected queue is gone with the old document, so a new channel and a new
   * descriptor are required; picks survive because markers re-anchor by cssPath.
   */
  private recover(page: WebviewPageState): void {
    if (this.disposed || this.recovering) return
    this.recovering = true
    this.disposeBridge()
    this.page = page.href === '' ? null : { url: page.href, title: page.title }
    this.events.onHandoff(this.page)
    this.events.onPage(this.page)
    void this.attach()
      .catch(() => { this.events.onFailure('no-page') })
      .finally(() => { this.recovering = false })
  }
}
