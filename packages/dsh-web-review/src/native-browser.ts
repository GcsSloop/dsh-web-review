/**
 * Native panel transport: the desktop shell renders the page in its own WKWebView.
 *
 * The shell publishes a descriptor under `$DSH_HOME` and serves a loopback
 * control API (see the shell's `control_server.rs`). This module discovers it,
 * drives it, and owns a small loopback listener of its own so the panel page can
 * push bridge messages and page state back without depending on any harness
 * route or authentication: the page runs on an arbitrary Origin, so it posts a
 * token-bearing `no-cors` request that the browser sends without a preflight.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import {
  PREVIEW_BRIDGE_PROTOCOL,
  PREVIEW_BRIDGE_VERSION,
  type PreviewBrowserRequest,
  type PreviewChannel,
  type PreviewSessionDescriptor,
  type PreviewSessionId,
} from './preview-contract.ts'

/** Path the panel page posts to on this module's own listener. */
export const NATIVE_EVENT_PATH = '/native-event'
/** Panel sessions idle longer than this are released. */
const SESSION_TTL_MS = 60 * 60 * 1_000
/** Most concurrent panel sessions; the shell hosts one panel at a time. */
const MAX_SESSIONS = 8
/** Bounds the panel page may report. */
const MAX_EVENT_BYTES = 1_048_576
/**
 * Script message handler name the shell installs on its panel webview.
 *
 * This is the page-to-host channel that works from an HTTPS document, where
 * WebKit blocks the loopback fetch the endpoint below relies on.
 */
const NATIVE_IPC_HANDLER = 'dshWebReview'
/**
 * How long a panel may stay up with no client attached.
 *
 * A reload of the DSH page takes the client half with it while this half keeps
 * running: without this, the shell's panel would stay drawn over the interface
 * with nothing left able to close it. A sidebar tab switch detaches and
 * re-attaches well inside this window, so the panel survives it untouched.
 */
const PANEL_IDLE_GRACE_MS = 4_000
/** After this long with no client, the panel is taken down for good. */
const PANEL_IDLE_CLOSE_MS = 60_000

/** One event the panel page or the shell produced. */
export type NativeStreamEvent =
  | { type: 'state'; url: string; title: string; loading: boolean }
  | { type: 'bridge'; payload: string }
  | { type: 'error'; message: string }

/** Where the panel stands on screen, in the shell window's logical coordinates. */
export interface NativePanelBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

/** A discovered shell control endpoint. */
export interface NativePanelHost {
  port: number
  version: string
}

/** Result of one dispatched request. */
export type NativeDispatchResult =
  | { ok: true; screenshot?: string }
  | { ok: false; status: number; message: string }

interface NativeSession {
  id: PreviewSessionId
  channel: PreviewChannel
  parentOrigin: string
  targetOrigin: string
  target: string
  listeners: Set<(event: NativeStreamEvent) => void>
  /** Hidden then closed once its client stops listening (see `watchDetach`). */
  idleTimer: NodeJS.Timeout | undefined
  closeTimer: NodeJS.Timeout | undefined
  /**
   * The client asked for this panel to be hidden (its tab went inactive, or the
   * body unmounted). Such a session is parked on purpose and is never closed for
   * being quiet: the user is expected to come back to it.
   */
  parked: boolean
  opened: boolean
  touchedAt: number
  url: string
  title: string
  loading: boolean
}

/** Descriptor file the shell publishes for clients to discover. */
export function nativePanelDescriptorPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'web-review', 'native-browser.json')
}

/**
 * Read the shell descriptor and confirm the endpoint answers.
 * @param env - environment carrying `DSH_HOME`.
 * @returns the host, or undefined when no shell advertises a panel.
 */
export async function discoverNativePanel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativePanelHost | undefined> {
  let raw: string
  try {
    raw = await readFile(nativePanelDescriptorPath(env), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
  const record = parsed as { port?: unknown; version?: unknown; capabilities?: unknown }
  const port = typeof record.port === 'number' && Number.isInteger(record.port)
    && record.port > 0 && record.port < 65_536 ? record.port : undefined
  if (port === undefined) return undefined
  if (Array.isArray(record.capabilities) && !record.capabilities.includes('browser-panel')) return undefined
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, {
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return undefined
    const health = await response.json() as { ok?: boolean }
    if (health.ok !== true) return undefined
  } catch {
    // A stale descriptor (a hard-killed shell) must not be trusted.
    return undefined
  }
  return { port, version: typeof record.version === 'string' ? record.version : 'unknown' }
}

function opaqueId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * One exact-Origin bridge bootstrap for a native panel document.
 *
 * It carries the transports the bridge artifact selects — the shell's script
 * message handler first, because an HTTPS document may not request the insecure
 * loopback endpoint, then that endpoint for the HTTP case — and reports the
 * page's address and title on load, because a native panel has no frame and no
 * host postMessage channel.
 */
function nativeBootstrap(
  session: { channel: string; parentOrigin: string; targetOrigin: string; target: string },
  endpoint: string,
  bridgeSource: string,
): string {
  const config = JSON.stringify({
    protocol: PREVIEW_BRIDGE_PROTOCOL,
    version: PREVIEW_BRIDGE_VERSION,
    channel: session.channel,
    parentOrigin: session.parentOrigin,
    pageUrl: session.target,
    targetOrigin: session.targetOrigin,
    native: { endpoint },
  }).replaceAll('<', '\\u003c')
  const target = JSON.stringify(endpoint).replaceAll('<', '\\u003c')
  return `window.__DSH_WEB_REVIEW_BRIDGE_CONFIG__=${config};
window.__DSH_WEB_REVIEW_NATIVE_ENDPOINT__=${target};
window.__DSH_WEB_REVIEW_NATIVE_IPC__=${JSON.stringify(NATIVE_IPC_HANDLER)};
window.__DSH_WEB_REVIEW_CHANNEL__=${JSON.stringify(session.channel)};
(function(){
  var endpoint=${target};
  var name=${JSON.stringify(NATIVE_IPC_HANDLER)};
  function sink(){
    try{
      var host=window.chrome&&window.chrome.webview;
      if(host&&typeof host.postMessage==='function') return function(body){ host.postMessage(body) };
    }catch(error){}
    try{
      var handlers=window.webkit&&window.webkit.messageHandlers;
      var handler=handlers&&handlers[name];
      if(handler&&typeof handler.postMessage==='function') return function(body){ handler.postMessage(body) };
    }catch(error){}
    return function(body){ try{ fetch(endpoint,{method:'POST',mode:'no-cors',body:body}) }catch(error){} };
  }
  function report(){ try{ sink()(JSON.stringify({type:'state',url:location.href,title:document.title,loading:false})) }catch(error){} }
  document.addEventListener('DOMContentLoaded',report);
  window.addEventListener('load',report);
})();
${bridgeSource}`
}

/** Owns native panel sessions and the loopback listener their pages report to. */
export class NativeBrowserSessions {
  private readonly bridgeSource: string
  private readonly sessions = new Map<PreviewSessionId, NativeSession>()
  private server: Server | undefined
  private port = 0
  private expiry: NodeJS.Timeout | undefined
  private closed = false

  private constructor(bridgeSource: string) {
    this.bridgeSource = bridgeSource
  }

  /** Start the manager and its event listener. */
  static async create(bridgeSource: string): Promise<NativeBrowserSessions> {
    const sessions = new NativeBrowserSessions(bridgeSource)
    await sessions.listen()
    sessions.expiry = setInterval(() => { sessions.reap() }, 60_000)
    sessions.expiry.unref()
    return sessions
  }

  private async listen(): Promise<void> {
    const sockets = new Set<Socket>()
    const server = createServer((req, res) => { void this.handleEvent(req, res) })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('native event listener has no TCP address'))
          return
        }
        this.port = address.port
        resolve()
      })
    })
    this.server = server
  }

  /** Loopback port the panel pages report to. */
  get eventPort(): number {
    return this.port
  }

  private async handleEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...headers, allow: 'POST' })
      res.end()
      return
    }
    let requestUrl: URL
    try {
      requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${String(this.port)}`)
    } catch {
      res.writeHead(400, headers)
      res.end()
      return
    }
    if (requestUrl.pathname !== NATIVE_EVENT_PATH) {
      res.writeHead(404, headers)
      res.end()
      return
    }
    const id = requestUrl.searchParams.get('sessionId') ?? ''
    const channel = requestUrl.searchParams.get('channel') ?? ''
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > MAX_EVENT_BYTES) {
        res.writeHead(413, headers)
        res.end()
        return
      }
      chunks.push(buffer)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown
    } catch {
      res.writeHead(400, headers)
      res.end()
      return
    }
    const accepted = this.ingest(id, channel, parsed)
    res.writeHead(accepted ? 204 : 404, headers)
    res.end()
  }

  /** Fan one untrusted panel event into the session's listeners. */
  ingest(id: string, channel: string, value: unknown): boolean {
    const session = this.sessionFor(id, channel)
    if (session === undefined) return false
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
    if (record === undefined) return false
    if (record.type === 'bridge') {
      if (typeof record.payload !== 'string' || record.payload.length > MAX_EVENT_BYTES) return false
      this.emit(session, { type: 'bridge', payload: record.payload })
      return true
    }
    // The bridge artifact posts its own message shape when the native sink is
    // its transport, exactly as the CDP binding would hand it over: wrap it into
    // the stream envelope the panel half consumes.
    if (record.protocol === PREVIEW_BRIDGE_PROTOCOL && record.direction === 'frame-to-host') {
      const payload = JSON.stringify(value)
      if (payload.length > MAX_EVENT_BYTES) return false
      this.emit(session, { type: 'bridge', payload })
      return true
    }
    if (record.type === 'error') {
      if (typeof record.message !== 'string') return false
      this.emit(session, { type: 'error', message: record.message.slice(0, 500) })
      return true
    }
    if (record.type === 'state') {
      const url = typeof record.url === 'string' ? record.url.slice(0, 4_096) : session.url
      const title = typeof record.title === 'string' ? record.title.slice(0, 500) : session.title
      session.url = url
      session.title = title
      session.loading = record.loading === true
      this.emit(session, { type: 'state', url, title, loading: session.loading })
      return true
    }
    return false
  }

  private emit(session: NativeSession, event: NativeStreamEvent): void {
    for (const listener of session.listeners) {
      try { listener(event) } catch { /* a dead stream must not break the session */ }
    }
  }

  private sessionFor(id: string, channel: string): NativeSession | undefined {
    const session = this.sessions.get(id as PreviewSessionId)
    if (session === undefined || session.channel !== channel) return undefined
    session.touchedAt = Date.now()
    return session
  }

  /** Whether a shell currently advertises a usable panel. */
  static async available(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    return (await discoverNativePanel(env)) !== undefined
  }

  /**
   * Register one native preview session.
   * @param target - absolute HTTP(S) URL the panel will show.
   * @param parentOrigin - the DSH host Origin that owns this session.
   * @returns the descriptor, or undefined when no shell panel is available.
   */
  async create(target: string, parentOrigin: string): Promise<PreviewSessionDescriptor | undefined> {
    if (this.closed) return undefined
    const host = await discoverNativePanel()
    if (host === undefined) return undefined
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.touchedAt - right.touchedAt)[0]
      if (oldest !== undefined) await this.release([oldest.id])
    }
    const id = opaqueId() as PreviewSessionId
    const session: NativeSession = {
      id,
      channel: opaqueId() as PreviewChannel,
      parentOrigin,
      targetOrigin: new URL(target).origin,
      target: new URL(target).href,
      listeners: new Set(),
      idleTimer: undefined,
      closeTimer: undefined,
      parked: false,
      opened: false,
      touchedAt: Date.now(),
      url: target,
      title: '',
      loading: true,
    }
    this.sessions.set(id, session)
    return {
      sessionId: id,
      mode: 'native',
      frameUrl: session.target,
      frameOrigin: parentOrigin,
      targetOrigin: session.targetOrigin,
      channel: session.channel,
    }
  }

  /** Stream one session to a listener (the SSE handler). */
  subscribe(id: string, channel: string, listener: (event: NativeStreamEvent) => void): (() => void) | undefined {
    const session = this.sessionFor(id, channel)
    if (session === undefined) return undefined
    session.listeners.add(listener)
    this.watchDetach(session)
    listener({ type: 'state', url: session.url, title: session.title, loading: session.loading })
    return () => {
      session.listeners.delete(listener)
      this.watchDetach(session)
    }
  }

  /**
   * Keep the shell's panel in step with this half's own client.
   *
   * A reload of the DSH page destroys the client that owns the preview while this
   * process keeps running, which used to leave the shell's panel drawn over the
   * interface with nothing able to close it. With no listener attached for a
   * grace period the panel is hidden, and closed outright after a longer one.
   *
   * A panel the client deliberately hid is only ever parked: its tab is inactive
   * and the user is coming back, so the page is kept exactly as it was. Only a
   * session that went quiet without a deliberate hide — the reload case — is
   * closed, and even then the client rebuilds a session if it ever returns.
   */
  private watchDetach(session: NativeSession): void {
    if (session.listeners.size > 0) {
      if (session.idleTimer !== undefined) clearTimeout(session.idleTimer)
      if (session.closeTimer !== undefined) clearTimeout(session.closeTimer)
      session.idleTimer = undefined
      session.closeTimer = undefined
      return
    }
    if (session.idleTimer !== undefined || session.closeTimer !== undefined) return
    session.idleTimer = setTimeout(() => {
      session.idleTimer = undefined
      if (session.listeners.size > 0) return
      void this.hide(session).catch(() => undefined)
    }, PANEL_IDLE_GRACE_MS)
    session.idleTimer.unref?.()
    if (session.parked) return
    session.closeTimer = setTimeout(() => {
      session.closeTimer = undefined
      if (session.listeners.size > 0 || session.parked) return
      void this.closeIdle(session).catch(() => undefined)
    }, PANEL_IDLE_CLOSE_MS)
    session.closeTimer.unref?.()
  }

  /** Hide the panel without touching the page. */
  private async hide(session: NativeSession): Promise<void> {
    if (!session.opened) return
    const host = await discoverNativePanel()
    if (host === undefined) return
    await this.call(host, '/panel/bounds', { x: 0, y: 0, width: 0, height: 0, visible: false })
  }

  /** Close the panel and forget the session (the idle path, not shutdown). */
  private async closeIdle(session: NativeSession): Promise<void> {
    if (session.listeners.size > 0) return
    if (session.idleTimer !== undefined) clearTimeout(session.idleTimer)
    if (session.closeTimer !== undefined) clearTimeout(session.closeTimer)
    session.idleTimer = undefined
    session.closeTimer = undefined
    const host = await discoverNativePanel()
    if (host !== undefined && session.opened) {
      await this.call(host, '/panel/command', { kind: 'close' })
    }
    session.opened = false
    this.sessions.delete(session.id)
  }

  /** Place (and on first use create) the shell panel for one session. */
  async bounds(id: string, channel: string, bounds: NativePanelBounds): Promise<NativeDispatchResult> {
    const session = this.sessionFor(id, channel)
    if (session === undefined) return { ok: false, status: 404, message: 'preview session not found' }
    if (!bounds.visible) session.parked = true
    const host = await discoverNativePanel()
    if (host === undefined) return { ok: false, status: 503, message: 'browser panel unavailable' }
    if (!session.opened) {
      if (!bounds.visible || bounds.width < 1 || bounds.height < 1) {
        // Nothing to show yet; wait for a real rectangle before opening.
        return { ok: true }
      }
      const endpoint = `http://127.0.0.1:${String(this.port)}${NATIVE_EVENT_PATH}`
        + `?sessionId=${encodeURIComponent(session.id)}&channel=${encodeURIComponent(session.channel)}`
      const opened = await this.call(host, '/panel/open', {
        session: session.id,
        url: session.target,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        bootstrap: nativeBootstrap(session, endpoint, this.bridgeSource),
        // The shell relays the page's script messages here; a secure page cannot
        // reach this endpoint itself.
        endpoint,
      })
      if (!opened.ok) return opened
      session.opened = true
      return { ok: true }
    }
    return await this.call(host, '/panel/bounds', {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      visible: bounds.visible,
    })
  }

  /** Apply one validated input or command request. */
  async dispatch(request: PreviewBrowserRequest): Promise<NativeDispatchResult> {
    const session = this.sessionFor(request.sessionId, request.channel)
    if (session === undefined) return { ok: false, status: 404, message: 'preview session not found' }
    if (request.input !== undefined) {
      if (request.input.kind === 'bounds') {
        return await this.bounds(session.id, session.channel, {
          x: request.input.x,
          y: request.input.y,
          width: request.input.width,
          height: request.input.height,
          visible: request.input.visible,
        })
      }
      // Pointer and keyboard belong to the native view itself.
      return { ok: true }
    }
    const command = request.command
    if (command === undefined) return { ok: false, status: 400, message: 'input or command required' }
    const host = await discoverNativePanel()
    if (host === undefined) return { ok: false, status: 503, message: 'browser panel unavailable' }
    if (!session.opened && command.name !== 'close') {
      return { ok: false, status: 409, message: 'browser panel is not open yet' }
    }
    if (command.name === 'close') {
      const result = await this.call(host, '/panel/command', { kind: 'close' })
      session.opened = false
      return result
    }
    if (command.name === 'bridge') {
      if (command.payload === undefined) return { ok: false, status: 400, message: 'bridge needs a payload' }
      return await this.call(host, '/panel/command', {
        kind: 'eval',
        script: `window.__dshWebReviewReceive && window.__dshWebReviewReceive(${JSON.stringify(command.payload)})`,
      })
    }
    if (command.name === 'reload') return await this.call(host, '/panel/command', { kind: 'reload' })
    if (command.name === 'back' || command.name === 'forward') {
      return await this.call(host, '/panel/command', {
        kind: 'eval',
        script: command.name === 'back' ? 'history.back()' : 'history.forward()',
      })
    }
    if (command.name === 'navigate') {
      if (command.url === undefined) return { ok: false, status: 400, message: 'navigate needs a url' }
      if (new URL(command.url).origin !== session.targetOrigin) {
        return { ok: false, status: 400, message: 'target outside preview session origin' }
      }
      return await this.call(host, '/panel/command', { kind: 'navigate', url: command.url })
    }
    if (command.name === 'screenshot') {
      // The shell's own compositor bitmap: cross-Origin content included.
      return await this.capture(host)
    }
    return { ok: false, status: 501, message: `unsupported native command: ${command.name}` }
  }

  /** Capture one panel bitmap through the shell. */
  private async capture(host: NativePanelHost): Promise<NativeDispatchResult> {
    try {
      const response = await fetch(`http://127.0.0.1:${String(host.port)}/panel/snapshot`, {
        method: 'POST',
        signal: AbortSignal.timeout(25_000),
      })
      const payload = await response.json() as { ok?: boolean; image?: unknown; error?: unknown }
      if (!response.ok || payload.ok !== true || typeof payload.image !== 'string') {
        const message = typeof payload.error === 'string' ? payload.error : `panel snapshot failed (${String(response.status)})`
        return { ok: false, status: 502, message }
      }
      return { ok: true, screenshot: payload.image }
    } catch (error) {
      return { ok: false, status: 502, message: error instanceof Error ? error.message : 'panel snapshot failed' }
    }
  }

  private async call(
    host: NativePanelHost,
    path: string,
    body: Record<string, unknown>,
  ): Promise<NativeDispatchResult> {
    try {
      const response = await fetch(`http://127.0.0.1:${String(host.port)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      const payload = await response.json().catch(() => ({}) as Record<string, unknown>)
      if (!response.ok || (payload as { ok?: boolean }).ok !== true) {
        const message = typeof (payload as { error?: unknown }).error === 'string'
          ? String((payload as { error?: unknown }).error)
          : `panel request failed (${String(response.status)})`
        return { ok: false, status: 502, message }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, status: 502, message: error instanceof Error ? error.message : 'panel request failed' }
    }
  }

  /** Close the panel when it belongs to one of these sessions. */
  async release(ids: readonly (string | PreviewSessionId)[]): Promise<void> {
    const host = await discoverNativePanel()
    for (const id of ids) {
      const session = this.sessions.get(id as PreviewSessionId)
      if (session === undefined) continue
      this.sessions.delete(session.id)
      session.listeners.clear()
      if (session.opened && host !== undefined) await this.call(host, '/panel/command', { kind: 'close' })
    }
  }

  private reap(): void {
    const cutoff = Date.now() - SESSION_TTL_MS
    const stale = [...this.sessions.values()]
      .filter(session => session.touchedAt < cutoff && session.listeners.size === 0)
      .map(session => session.id)
    if (stale.length > 0) void this.release(stale)
  }

  /** Release every session and close the listener. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.expiry !== undefined) clearInterval(this.expiry)
    await this.release([...this.sessions.keys()])
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
        server.closeAllConnections()
      })
    }
  }
}
