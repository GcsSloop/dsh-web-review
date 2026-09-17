/**
 * Minimal Chrome DevTools Protocol client for the browser preview transport.
 *
 * The plugin drives a real Chromium instead of proxying one: a page rendered
 * here keeps its true Origin, cookies, service workers, and WebSockets, which
 * the isolated HTTP transport can never carry. CDP is JSON over one WebSocket,
 * so this stays dependency-free (the node runtime provides `WebSocket`) and the
 * built node half keeps no bare runtime import.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Command deadline for one CDP round trip. */
const CDP_COMMAND_TIMEOUT_MS = 20_000
/** How long to wait for a freshly launched browser to publish its debug port. */
const CDP_START_TIMEOUT_MS = 20_000

type CdpParams = Record<string, unknown>
type CdpHandler = (params: CdpParams) => void

/** Executables probed in order when the deployment names none. */
const DEFAULT_EXECUTABLES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
]

/** Resolve the browser executable for this deployment. */
export function resolveBrowserExecutable(configured?: string): string | undefined {
  const candidates = [
    ...(configured === undefined || configured === '' ? [] : [configured]),
    process.env.DSH_WEB_REVIEW_BROWSER,
    ...DEFAULT_EXECUTABLES,
    ...playwrightCacheCandidates(),
  ]
  return candidates.find(candidate => typeof candidate === 'string' && candidate !== '' && existsSync(candidate))
}

function playwrightCacheCandidates(): string[] {
  const root = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
  const suffixes = [
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  ]
  const candidates: string[] = []
  for (const build of ['chromium-1234', 'chromium-1223', 'chromium-1161']) {
    for (const suffix of suffixes) candidates.push(join(root, build, suffix))
  }
  return candidates
}

interface PendingCommand {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * One CDP connection with flat session support.
 *
 * Commands are JSON objects with a monotonically increasing id; events arrive
 * without an id and are dispatched to per-method handlers plus one wildcard
 * listener. A command that never answers rejects on its own deadline so a
 * wedged browser cannot stall the transport.
 */
export class CdpConnection {
  private readonly socket: WebSocket
  private readonly pending = new Map<number, PendingCommand>()
  private readonly handlers = new Map<string, Set<CdpHandler>>()
  private readonly wildcard = new Set<CdpHandler>()
  private nextId = 1
  private closed = false

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.onmessage = (message) => { this.dispatch(JSON.parse(String(message.data)) as CdpParams & { id?: number }) }
    socket.onclose = () => { this.fail(new Error('cdp connection closed')) }
    socket.onerror = () => { this.fail(new Error('cdp connection failed')) }
  }

  /**
   * Open a connection to a debugger WebSocket endpoint.
   * @param url - `webSocketDebuggerUrl` from `/json/version` or a target list.
   */
  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('cdp socket rejected the connection'))
    })
    return new CdpConnection(socket)
  }

  /** Send one command, optionally scoped to a flat session. */
  send(method: string, params: CdpParams = {}, sessionId?: string): Promise<CdpParams> {
    if (this.closed) return Promise.reject(new Error('cdp connection is closed'))
    const id = this.nextId++
    return new Promise<CdpParams>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp command timed out: ${method}`))
      }, CDP_COMMAND_TIMEOUT_MS)
      timer.unref()
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  /** Subscribe to one CDP event method. */
  on(method: string, handler: CdpHandler): () => void {
    const set = this.handlers.get(method) ?? new Set<CdpHandler>()
    set.add(handler)
    this.handlers.set(method, set)
    return () => { set.delete(handler) }
  }

  /** Subscribe to every CDP event, including session-scoped ones. */
  onAny(handler: CdpHandler): () => void {
    this.wildcard.add(handler)
    return () => { this.wildcard.delete(handler) }
  }

  /** Close the socket and reject every in-flight command. */
  close(): void {
    this.closed = true
    this.fail(new Error('cdp connection closed'))
    try { this.socket.close() } catch { /* already gone */ }
  }

  private dispatch(payload: CdpParams & { id?: number; method?: string; params?: CdpParams; result?: CdpParams; error?: CdpParams }): void {
    if (typeof payload.id === 'number') {
      const entry = this.pending.get(payload.id)
      if (entry === undefined) return
      this.pending.delete(payload.id)
      clearTimeout(entry.timer)
      if (payload.error !== undefined) entry.reject(new Error(`cdp command failed: ${JSON.stringify(payload.error)}`))
      else entry.resolve(payload.result ?? {})
      return
    }
    const method = payload.method
    if (typeof method !== 'string') return
    const params = payload.params ?? {}
    this.handlers.get(method)?.forEach(handler => { handler(params) })
    this.wildcard.forEach(handler => { handler({ method, ...params }) })
  }

  private fail(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}

/** What one page target exposes to the browser transport. */
export interface CdpFrameMetadata {
  deviceWidth: number
  deviceHeight: number
  pageScaleFactor: number
  offsetTop: number
  scrollOffsetX: number
  scrollOffsetY: number
}

export interface CdpPageHandlers {
  frame: (data: string, metadata: CdpFrameMetadata) => void
  binding: (name: string, payload: string) => void
  event: (method: string, params: CdpParams) => void
}

/** One attached page target. */
export class CdpPage {
  private readonly connection: CdpConnection
  private readonly sessionId: string
  private readonly targetId: string
  private readonly disposers: Array<() => void> = []
  private screencasting = false

  private constructor(connection: CdpConnection, targetId: string, sessionId: string) {
    this.connection = connection
    this.targetId = targetId
    this.sessionId = sessionId
  }

  /** Attach to a page target and wire the transport callbacks. */
  static async attach(connection: CdpConnection, handlers: CdpPageHandlers, targetId?: string): Promise<CdpPage> {
    const target = targetId ?? String((await connection.send('Target.createTarget', { url: 'about:blank' })).targetId)
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId: target, flatten: true }) as { sessionId: string }
    const page = new CdpPage(connection, target, sessionId)
    page.disposers.push(
      connection.onAny((event) => {
        const scoped = event as unknown as { method: string; sessionId?: string }
        if (scoped.sessionId !== undefined && scoped.sessionId !== sessionId) return
        handlers.event(scoped.method, event)
      }),
      connection.on('Page.screencastFrame', (params) => {
        const metadata = params.metadata as Partial<CdpFrameMetadata> | undefined
        handlers.frame(String(params.data), {
          deviceWidth: Number(metadata?.deviceWidth ?? 0),
          deviceHeight: Number(metadata?.deviceHeight ?? 0),
          pageScaleFactor: Number(metadata?.pageScaleFactor ?? 1),
          offsetTop: Number(metadata?.offsetTop ?? 0),
          scrollOffsetX: Number(metadata?.scrollOffsetX ?? 0),
          scrollOffsetY: Number(metadata?.scrollOffsetY ?? 0),
        })
        void page.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined)
      }),
      connection.on('Runtime.bindingCalled', (params) => {
        handlers.binding(String(params.name), String(params.payload))
      }),
    )
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    return page
  }

  /** Session-scoped command. */
  send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    return this.connection.send(method, params, this.sessionId)
  }

  /** Navigate this page and resolve once the load event settles. */
  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    const loaded = this.waitFor('Page.loadEventFired', timeoutMs).catch(() => undefined)
    await this.send('Page.navigate', { url })
    await loaded
  }

  /** Wait for one CDP event on this session. */
  waitFor(method: string, timeoutMs = 15_000): Promise<CdpParams> {
    return new Promise<CdpParams>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${method}`)) }, timeoutMs)
      timer.unref()
      const off = this.connection.on(method, (params) => {
        clearTimeout(timer)
        off()
        resolve(params)
      })
    })
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page evaluation failed: ${result.exceptionDetails.text ?? 'unknown error'}`)
    }
    return result.result?.value
  }

  /** Capture the visible viewport (or the whole page) as PNG bytes. */
  async screenshot(options: { fullPage?: boolean } = {}): Promise<Buffer> {
    const captured = await this.send('Page.captureScreenshot', {
      format: 'png',
      ...(options.fullPage === true ? { captureBeyondViewport: true } : {}),
    }) as { data: string }
    return Buffer.from(captured.data, 'base64')
  }

  /** Start the JPEG screencast stream. */
  async startScreencast(options: { width: number; height: number; quality?: number }): Promise<void> {
    if (this.screencasting) await this.stopScreencast()
    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: options.quality ?? 70,
      maxWidth: Math.max(1, Math.round(options.width)),
      maxHeight: Math.max(1, Math.round(options.height)),
      everyNthFrame: 1,
    })
    this.screencasting = true
  }

  /** Stop the JPEG screencast stream. */
  async stopScreencast(): Promise<void> {
    if (!this.screencasting) return
    this.screencasting = false
    await this.send('Page.stopScreencast').catch(() => undefined)
  }

  /** Emulate a viewport size (device metrics + visible size). */
  async setViewport(width: number, height: number, deviceScaleFactor = 1): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      deviceScaleFactor,
      mobile: false,
    })
  }

  /** Install a script that runs before page scripts on every new document. */
  async addInitScript(source: string): Promise<void> {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source })
  }

  /** Expose a page-callable binding (the reverse bridge channel). */
  async addBinding(name: string): Promise<void> {
    await this.send('Runtime.addBinding', { name })
  }

  /** Dispatch one input command (`Input.*`). */
  async input(method: string, params: CdpParams): Promise<void> {
    await this.send(method, params)
  }

  /** Close this page target. */
  async close(): Promise<void> {
    await this.stopScreencast().catch(() => undefined)
    for (const dispose of this.disposers) dispose()
    this.disposers.length = 0
    await this.connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined)
  }
}

/** One launched or attached browser process. */
export class CdpBrowser {
  private readonly connection: CdpConnection
  private readonly child: ChildProcess | undefined
  private readonly ownedProfile: string | undefined
  private closed = false

  private constructor(connection: CdpConnection, child?: ChildProcess, ownedProfile?: string) {
    this.connection = connection
    this.child = child
    this.ownedProfile = ownedProfile
  }

  /**
   * Launch a browser with an ephemeral debug port and a persistent profile.
   * @param options - executable, profile directory, and window visibility.
   */
  static async launch(options: {
    executable: string
    profileDir?: string
    headless?: boolean
    args?: readonly string[]
  }): Promise<CdpBrowser> {
    let profileDir = options.profileDir
    let ownedProfile: string | undefined
    if (profileDir === undefined) {
      profileDir = await mkdtemp(join(tmpdir(), 'dsh-web-review-browser-'))
      ownedProfile = profileDir
    }
    const child = spawn(options.executable, [
      ...(options.headless === false ? [] : ['--headless=new']),
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1280,800',
      ...(options.args ?? []),
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    const portFile = join(profileDir, 'DevToolsActivePort')
    const deadline = Date.now() + CDP_START_TIMEOUT_MS
    let port = 0
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`browser exited early with code ${String(child.exitCode)}`)
      try {
        const [first] = (await readFile(portFile, 'utf8')).split('\n')
        port = Number(first)
        if (Number.isFinite(port) && port > 0) break
      } catch { /* not written yet */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (port === 0) {
      child.kill('SIGKILL')
      throw new Error('browser never published a debugging port')
    }
    const version = await fetch(`http://127.0.0.1:${String(port)}/json/version`).then(response => response.json()) as { webSocketDebuggerUrl: string }
    const connection = await CdpConnection.connect(version.webSocketDebuggerUrl)
    return new CdpBrowser(connection, child, ownedProfile)
  }

  /** Attach to an already running debugger endpoint. */
  static async attach(endpoint: string): Promise<CdpBrowser> {
    const url = endpoint.startsWith('http')
      ? (await fetch(`${endpoint.replace(/\/$/u, '')}/json/version`).then(response => response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
      : endpoint
    return new CdpBrowser(await CdpConnection.connect(url))
  }

  /** Create a page target bound to the transport callbacks. */
  createPage(handlers: CdpPageHandlers): Promise<CdpPage> {
    return CdpPage.attach(this.connection, handlers)
  }

  /** Close every target and, when this transport launched it, the process. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.connection.close()
    if (this.child !== undefined) {
      this.child.kill('SIGKILL')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (this.ownedProfile !== undefined) await rm(this.ownedProfile, { recursive: true, force: true })
  }
}
