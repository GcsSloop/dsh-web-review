/**
 * Browser-backed preview sessions.
 *
 * Each session owns one real Chromium page target driven over CDP, so the page
 * keeps its true Origin, cookie jar, service workers, and WebSockets — the
 * things the isolated HTTP proxy can never carry. The panel receives JPEG
 * screencast frames through one server-sent-event stream and sends input and
 * commands back over a regular POST route, which keeps the transport free of a
 * hand-rolled WebSocket server.
 */
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CdpBrowser,
  resolveBrowserExecutable,
  type CdpPage,
  type CdpPageHandlers,
} from './cdp-transport.ts'
import {
  PREVIEW_BRIDGE_PROTOCOL,
  PREVIEW_BRIDGE_VERSION,
  type PreviewBrowserRequest,
  type PreviewChannel,
  type PreviewSessionDescriptor,
  type PreviewSessionId,
} from './preview-contract.ts'

/** Sessions idle longer than this are released. */
const SESSION_TTL_MS = 60 * 60 * 1_000
/** Concurrent browser pages; each one is a live renderer process. */
const MAX_SESSIONS = 8
/** JPEG quality of the screencast stream. */
const FRAME_QUALITY = 85

/** Deployment-controlled browser launch options. */
export interface BrowserPreviewOptions {
  /**
   * The isolated-frame bridge artifact, injected into every browser document so
   * the picker, editor, and snapshot protocol runs unchanged in a real page.
   */
  bridgeSource: string
  /** Deployment switch; false keeps every preview on the isolated HTTP transport. */
  enabled?: boolean
  executable?: string
  profileDir?: string
  headless?: boolean
  viewportWidth: number
  viewportHeight: number
}

/** One event of the browser preview stream, serialized into SSE `data:` lines. */
export type BrowserStreamEvent =
  | { type: 'state'; url: string; title: string; loading: boolean }
  | { type: 'frame'; data: string; deviceWidth: number; deviceHeight: number }
  | { type: 'bridge'; payload: string }
  | { type: 'error'; message: string }

/** Result of one dispatched input/command request. */
export type BrowserDispatchResult =
  | { ok: true; screenshot?: string }
  | { ok: false; status: number; message: string }

interface BrowserSession {
  id: PreviewSessionId
  channel: PreviewChannel
  parentOrigin: string
  targetOrigin: string
  page: CdpPage
  listeners: Set<(event: BrowserStreamEvent) => void>
  streaming: boolean
  touchedAt: number
  width: number
  height: number
  /** Device pixel ratio the page renders at; frames are captured at this scale. */
  deviceScaleFactor: number
  /** Bit mask of pressed mouse buttons, reported on move events during a drag. */
  pressedButtons: number
  url: string
  title: string
  loading: boolean
}

/** Default persistent profile: logins performed in Preview survive restarts. */
export function defaultBrowserProfileDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'web-review', 'browser-profile')
}

function opaqueId(): string {
  return randomBytes(16).toString('hex')
}

/** CDP button bit mask for one named button. */
const BUTTON_MASK = { left: 1, right: 2, middle: 4 } as const

/** One exact-Origin bridge bootstrap for a real browser document. */
function bridgeBootstrap(session: {
  channel: string
  parentOrigin: string
  targetOrigin: string
  url: string
}, source: string): string {
  const config = JSON.stringify({
    protocol: PREVIEW_BRIDGE_PROTOCOL,
    version: PREVIEW_BRIDGE_VERSION,
    channel: session.channel,
    parentOrigin: session.parentOrigin,
    pageUrl: session.url,
    targetOrigin: session.targetOrigin,
  }).replaceAll('<', '\\u003c')
  return `window.__DSH_WEB_REVIEW_BRIDGE_CONFIG__=${config};\n${source}`
}

/**
 * Owns the launched browser and every page session it backs.
 *
 * The browser starts lazily on the first browser-mode session, so a deployment
 * without a Chromium available still boots and keeps proxy previews working.
 */
export class BrowserPreviewSessions {
  private readonly options: BrowserPreviewOptions
  private readonly sessions = new Map<PreviewSessionId, BrowserSession>()
  private browser: CdpBrowser | undefined
  private launching: Promise<CdpBrowser | undefined> | undefined
  private expiry: NodeJS.Timeout | undefined
  private closed = false

  private constructor(options: BrowserPreviewOptions) {
    this.options = options
  }

  /** Create the manager; the browser process itself starts on first use. */
  static create(options: BrowserPreviewOptions): BrowserPreviewSessions {
    const manager = new BrowserPreviewSessions(options)
    manager.expiry = setInterval(() => { manager.reap() }, 60_000)
    manager.expiry.unref()
    return manager
  }

  /** Whether a browser executable is resolvable for this deployment. */
  get available(): boolean {
    return resolveBrowserExecutable(this.options.executable) !== undefined
  }

  private async ensureBrowser(): Promise<CdpBrowser | undefined> {
    if (this.closed) return undefined
    if (this.browser !== undefined) return this.browser
    if (this.launching !== undefined) return this.launching
    const executable = resolveBrowserExecutable(this.options.executable)
    if (executable === undefined) return undefined
    const profileDir = this.options.profileDir === undefined || this.options.profileDir === ''
      ? defaultBrowserProfileDir()
      : this.options.profileDir
    this.launching = (async () => {
      await mkdir(profileDir, { recursive: true })
      const browser = await CdpBrowser.launch({
        executable,
        profileDir,
        ...(this.options.headless === undefined ? {} : { headless: this.options.headless }),
      })
      this.browser = browser
      return browser
    })().catch((error: unknown) => {
      this.launching = undefined
      throw error
    })
    return this.launching
  }

  private emit(session: BrowserSession, event: BrowserStreamEvent): void {
    for (const listener of session.listeners) {
      try { listener(event) } catch { /* a dead stream must not break the session */ }
    }
  }

  private pageHandlers(session: { current?: BrowserSession }): CdpPageHandlers {
    return {
      frame: (data, metadata) => {
        const target = session.current
        if (target === undefined) return
        this.emit(target, {
          type: 'frame',
          data,
          deviceWidth: metadata.deviceWidth,
          deviceHeight: metadata.deviceHeight,
        })
      },
      binding: (_name, payload) => {
        const target = session.current
        if (target === undefined) return
        this.emit(target, { type: 'bridge', payload })
      },
      event: (method, params) => {
        const target = session.current
        if (target === undefined) return
        if (method === 'Page.frameStartedLoading') {
          target.loading = true
          this.emit(target, { type: 'state', url: target.url, title: target.title, loading: true })
          return
        }
        if (method === 'Page.frameNavigated') {
          const frame = params.frame as { parentId?: string; url?: string } | undefined
          if (frame === undefined || frame.parentId !== undefined) return
          target.url = String(frame.url ?? target.url)
          this.emit(target, { type: 'state', url: target.url, title: target.title, loading: target.loading })
          return
        }
        if (method === 'Page.loadEventFired') {
          target.loading = false
          void this.refreshState(target)
        }
      },
    }
  }

  private async refreshState(session: BrowserSession): Promise<void> {
    try {
      const value = await session.page.evaluate(
        'JSON.stringify({ url: location.href, title: document.title })',
      )
      const parsed = JSON.parse(String(value)) as { url?: string; title?: string }
      session.url = typeof parsed.url === 'string' ? parsed.url : session.url
      session.title = typeof parsed.title === 'string' ? parsed.title : session.title
    } catch { /* a navigation in flight can invalidate the context */ }
    this.emit(session, { type: 'state', url: session.url, title: session.title, loading: session.loading })
  }

  /**
   * Open one real browser page for a preview target.
   * @param target - absolute HTTP(S) URL to open.
   * @param parentOrigin - the DSH host Origin that owns this session.
   * @returns the session descriptor, or undefined when no browser is available.
   */
  async create(target: string, parentOrigin: string): Promise<PreviewSessionDescriptor | undefined> {
    if (this.closed || this.options.enabled === false) return undefined
    const browser = await this.ensureBrowser()
    if (browser === undefined) return undefined
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.touchedAt - right.touchedAt)[0]
      if (oldest !== undefined) await this.release([oldest.id])
    }
    const holder: { current?: BrowserSession } = {}
    const page = await browser.createPage(this.pageHandlers(holder))
    const session: BrowserSession = {
      id: opaqueId() as PreviewSessionId,
      channel: opaqueId() as PreviewChannel,
      parentOrigin,
      targetOrigin: new URL(target).origin,
      page,
      listeners: new Set(),
      streaming: false,
      touchedAt: Date.now(),
      width: this.options.viewportWidth,
      height: this.options.viewportHeight,
      deviceScaleFactor: 1,
      pressedButtons: 0,
      url: target,
      title: '',
      loading: true,
    }
    holder.current = session
    this.sessions.set(session.id, session)
    // The page-callable binding carries bridge messages up; the injected
    // bootstrap gives the artifact its config and its host-bound transport.
    await page.addBinding('__dshWebReviewSend')
    await page.addInitScript(bridgeBootstrap(session, this.options.bridgeSource))
    await page.setViewport(session.width, session.height)
    await page.navigate(target)
    return {
      sessionId: session.id,
      mode: 'browser',
      frameUrl: session.url,
      frameOrigin: parentOrigin,
      targetOrigin: session.targetOrigin,
      channel: session.channel,
    }
  }

  private sessionFor(id: string, channel: string): BrowserSession | undefined {
    const session = this.sessions.get(id as PreviewSessionId)
    if (session === undefined || session.channel !== channel) return undefined
    session.touchedAt = Date.now()
    return session
  }

  /**
   * Stream one session to a listener (the SSE handler).
   * @returns the unsubscribe function, or undefined when the session is gone.
   */
  subscribe(id: string, channel: string, listener: (event: BrowserStreamEvent) => void): (() => void) | undefined {
    const session = this.sessionFor(id, channel)
    if (session === undefined) return undefined
    session.listeners.add(listener)
    listener({ type: 'state', url: session.url, title: session.title, loading: session.loading })
    if (!session.streaming) {
      session.streaming = true
      void session.page.startScreencast({
        width: session.width * session.deviceScaleFactor,
        height: session.height * session.deviceScaleFactor,
        quality: FRAME_QUALITY,
      }).catch((error: unknown) => {
        session.streaming = false
        this.emit(session, { type: 'error', message: error instanceof Error ? error.message : 'screencast failed' })
      })
    }
    return () => {
      session.listeners.delete(listener)
      if (session.listeners.size === 0 && session.streaming) {
        session.streaming = false
        void session.page.stopScreencast().catch(() => undefined)
      }
    }
  }

  /** Apply one validated input or command request. */
  async dispatch(request: PreviewBrowserRequest): Promise<BrowserDispatchResult> {
    const session = this.sessionFor(request.sessionId, request.channel)
    if (session === undefined) return { ok: false, status: 404, message: 'preview session not found' }
    try {
      if (request.input !== undefined) {
        await this.applyInput(session, request.input)
        return { ok: true }
      }
      const command = request.command
      if (command === undefined) return { ok: false, status: 400, message: 'input or command required' }
      if (command.name === 'reload') {
        await session.page.send('Page.reload', {})
        return { ok: true }
      }
      if (command.name === 'back' || command.name === 'forward') {
        const history = await session.page.send('Page.getNavigationHistory') as {
          currentIndex: number
          entries: Array<{ id: number }>
        }
        const index = command.name === 'back' ? history.currentIndex - 1 : history.currentIndex + 1
        const entry = history.entries[index]
        if (entry === undefined) return { ok: false, status: 409, message: 'no history entry' }
        await session.page.send('Page.navigateToHistoryEntry', { entryId: entry.id })
        return { ok: true }
      }
      if (command.name === 'bridge') {
        if (command.payload === undefined) return { ok: false, status: 400, message: 'bridge needs a payload' }
        await session.page.evaluate(
          `window.__dshWebReviewReceive && window.__dshWebReviewReceive(${JSON.stringify(command.payload)})`,
        )
        return { ok: true }
      }
      if (command.name === 'navigate') {
        if (command.url === undefined) return { ok: false, status: 400, message: 'navigate needs a url' }
        if (new URL(command.url).origin !== session.targetOrigin) {
          return { ok: false, status: 400, message: 'target outside preview session origin' }
        }
        await session.page.navigate(command.url)
        return { ok: true }
      }
      // A still is captured at the emulated device resolution (the page already
      // renders at `deviceScaleFactor`), so an idle surface is pixel-sharp even
      // though the motion stream can only carry CSS-sized frames.
      const still = await session.page.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 90,
        clip: { x: 0, y: 0, width: session.width, height: session.height, scale: 1 },
      }) as { data: string }
      return { ok: true, screenshot: still.data }
    } catch (error) {
      return { ok: false, status: 502, message: error instanceof Error ? error.message : 'browser command failed' }
    }
  }

  private async applyInput(
    session: BrowserSession,
    input: NonNullable<PreviewBrowserRequest['input']>,
  ): Promise<void> {
    if (input.kind === 'mouse') {
      session.pressedButtons = input.type === 'down'
        ? BUTTON_MASK[input.button]
        : input.type === 'up' ? 0 : session.pressedButtons
      await session.page.input('Input.dispatchMouseEvent', {
        type: input.type === 'move' ? 'mouseMoved' : input.type === 'down' ? 'mousePressed' : 'mouseReleased',
        x: input.x,
        y: input.y,
        button: input.button,
        clickCount: input.clickCount,
        modifiers: input.modifiers,
        buttons: session.pressedButtons,
      })
      return
    }
    if (input.kind === 'wheel') {
      await session.page.input('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers,
      })
      return
    }
    if (input.kind === 'key') {
      // CDP names the phases keyDown/keyUp/char; the panel speaks down/up/char.
      const type = input.type === 'down' ? 'keyDown' : input.type === 'up' ? 'keyUp' : 'char'
      await session.page.input('Input.dispatchKeyEvent', {
        type,
        key: input.key,
        code: input.code,
        ...(input.text === '' ? {} : { text: input.text, unmodifiedText: input.text }),
        windowsVirtualKeyCode: input.windowsVirtualKeyCode,
        nativeVirtualKeyCode: input.windowsVirtualKeyCode,
        modifiers: input.modifiers,
      })
      return
    }
    if (input.kind === 'text') {
      await session.page.input('Input.insertText', { text: input.text })
      return
    }
    // A `bounds` input belongs to the native panel transport.
    if (input.kind !== 'viewport') return
    session.width = Math.round(input.width)
    session.height = Math.round(input.height)
    session.deviceScaleFactor = input.deviceScaleFactor
    await session.page.setViewport(session.width, session.height, input.deviceScaleFactor)
    if (session.streaming) {
      // Capture at device resolution: a CSS-sized frame would be upscaled onto
      // the panel's retina canvas and read as blur.
      await session.page.startScreencast({
        width: session.width * session.deviceScaleFactor,
        height: session.height * session.deviceScaleFactor,
        quality: FRAME_QUALITY,
      })
    }
  }

  /** Release sessions and their page targets. */
  async release(ids: readonly (string | PreviewSessionId)[]): Promise<void> {
    for (const id of ids) {
      const session = this.sessions.get(id as PreviewSessionId)
      if (session === undefined) continue
      this.sessions.delete(session.id)
      session.listeners.clear()
      await session.page.close().catch(() => undefined)
    }
  }

  private reap(): void {
    const cutoff = Date.now() - SESSION_TTL_MS
    const stale = [...this.sessions.values()]
      .filter(session => session.touchedAt < cutoff && session.listeners.size === 0)
      .map(session => session.id)
    if (stale.length > 0) void this.release(stale)
  }

  /** Release every session and the browser process this manager launched. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.expiry !== undefined) clearInterval(this.expiry)
    await this.release([...this.sessions.keys()])
    const browser = this.browser
    this.browser = undefined
    await this.launching?.catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }
}
