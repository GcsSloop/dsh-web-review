/**
 * dsh-web-review node half: a small same-origin control endpoint plus an
 * independent loopback preview server. Every page session receives a random
 * `*.localhost` Origin, so arbitrary page scripts never share the DSH host
 * Origin. The frame and host communicate only through the versioned bridge.
 */
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-skill'
import { MAX_ANNOTATION_BODY } from './annotation-contract.ts'
import {
  acknowledgeAnnotationEvent,
  attachPendingAnnotationContext,
  forgetAgent,
  parseAnnotationBody,
  readRequestBody,
  storeAnnotationSnapshot,
  type AnnotationCommitState,
} from './annotation-context.ts'
import { PREVIEW_GUIDANCE } from './preview-guidance.ts'
import {
  PREVIEW_BROWSER_INPUT_PATH,
  PREVIEW_BROWSER_STREAM_PATH,
  PREVIEW_CLIENT_HEADER,
  PREVIEW_CLIENT_HEADER_VALUE,
  PREVIEW_SESSIONS_PATH,
  previewBrowserRequestOf,
  type PreviewSessionId,
} from './preview-contract.ts'
import { BrowserPreviewSessions } from './browser-preview.ts'
import { startIsolatedPreviewServer, type IsolatedPreviewServer } from './preview-server.ts'
import {
  readRequestBytes,
} from './proxy-transport.ts'
import { isPreviewableUrl } from './proxy-url.ts'
import { registerUiSkillProvider, type Config as PluginConfig } from './skill-provider.ts'
export { Config } from './skill-provider.ts'
export { PREVIEW_SESSIONS_PATH } from './preview-contract.ts'
export { PREVIEW_GUIDANCE } from './preview-guidance.ts'

/** Plugin identity for diagnostics and the client-modules scan. */
export const name = 'dsh-web-review'
/** Services required before the routes register. */
export const inject = ['webServer', 'agents', 'systemPrompt', 'skills']

/** `/webview-annotations` exact route path (annotation state sync). */
export const ANNOTATIONS_PREFIX = '/webview-annotations'
const MAX_PREVIEW_CONTROL_BODY = 16 * 1024

/**
 * Plugin body: register proxy/pending routes and send-time context admission.
 * @param ctx - root context carrying the webServer and live-agent services.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const annotations: AnnotationCommitState = new Map()
  registerUiSkillProvider(ctx, config)
  let previewServer: IsolatedPreviewServer | undefined
  const bridgeSource = await readBridgeSource()
  await ctx.effect(async () => {
    previewServer = await startIsolatedPreviewServer(bridgeSource, { cookies: config.previewCookies })
    ctx.logger.info(`isolated preview server listening on 127.0.0.1:${String(previewServer.port)}`)
    return async () => { await previewServer?.close() }
  }, 'dsh-web-review: isolated preview server')
  if (previewServer === undefined) throw new Error('dsh-web-review: preview server failed to start')
  ctx.systemPrompt.section({
    name: 'plugin:dsh-web-review-preview',
    order: -97,
    text: PREVIEW_GUIDANCE,
  })
  const livePreviewServer = previewServer
  const browserSessions = BrowserPreviewSessions.create({
    bridgeSource,
    enabled: config.browserPreview,
    executable: config.browserExecutable,
    profileDir: config.browserProfileDir,
    headless: config.browserHeadless,
    viewportWidth: config.browserViewportWidth,
    viewportHeight: config.browserViewportHeight,
  })
  ctx.effect(() => () => { void browserSessions.close() }, 'dsh-web-review: browser preview sessions')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREVIEW_SESSIONS_PATH,
    handler: previewSessionsHandler(livePreviewServer, browserSessions),
  }), 'dsh-web-review: preview-session control route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREVIEW_BROWSER_STREAM_PATH,
    handler: browserStreamHandler(browserSessions),
  }), 'dsh-web-review: /webview-browser-stream route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREVIEW_BROWSER_INPUT_PATH,
    handler: browserInputHandler(browserSessions),
  }), 'dsh-web-review: /webview-browser-input route')
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ANNOTATIONS_PREFIX,
      handler: annotationsHandler(ctx, annotations),
    }),
    'dsh-web-review: /webview-annotations route',
  )
  ctx.on('agent/pre-step', ({ agent, messages, signal }, next) =>
    attachPendingAnnotationContext(annotations, agent, ctx.skills, signal, messages, next))
  ctx.on('session/event', (session, event) => {
    acknowledgeAnnotationEvent(annotations, session.id, event)
  })
  ctx.on('agent/disposed', ({ agent }) => { forgetAgent(annotations, agent) })
}

async function readBridgeSource(): Promise<string> {
  const candidates = [
    new URL('./bridge.js', import.meta.url),
    new URL('../lib/bridge.js', import.meta.url),
  ]
  let failure: unknown
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8')
    } catch (error) {
      failure = error
    }
  }
  throw new Error('dsh-web-review: lib/bridge.js is missing; run the package build', { cause: failure })
}

function requestOrigin(req: IncomingMessage): string | undefined {
  const value = req.headers.origin
  const host = req.headers.host
  if (typeof value !== 'string' || typeof host !== 'string') return undefined
  try {
    const url = new URL(value)
    const requestHost = new URL(`http://${host}`).host
    return url.origin === value && url.host === requestHost
      && (url.protocol === 'http:' || url.protocol === 'https:')
      ? value
      : undefined
  } catch {
    return undefined
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key))
    ? record
    : undefined
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const bytes = await readRequestBytes(req, MAX_PREVIEW_CONTROL_BODY)
  if (bytes === undefined) return undefined
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

function previewSessionsHandler(
  server: IsolatedPreviewServer,
  browserSessions: BrowserPreviewSessions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.headers[PREVIEW_CLIENT_HEADER] !== PREVIEW_CLIENT_HEADER_VALUE
      || !(req.headers['content-type'] ?? '').toString().toLowerCase().startsWith('application/json')) {
      res.writeHead(415, { 'cache-control': 'no-store' })
      res.end('preview client JSON required')
      return
    }
    const origin = requestOrigin(req)
    if (origin === undefined) {
      res.writeHead(403, { 'cache-control': 'no-store' })
      res.end('same-origin browser request required')
      return
    }
    let value: unknown
    try {
      value = await jsonBody(req)
    } catch (error) {
      res.writeHead(413, { 'cache-control': 'no-store' })
      res.end(error instanceof Error ? error.message : 'request too large')
      return
    }
    if (req.method === 'POST') {
      const record = exactRecord(value, ['target']) ?? exactRecord(value, ['target', 'mode'])
      const mode = record?.mode === 'browser' ? 'browser' : record?.mode === undefined ? 'proxy' : undefined
      if (record === undefined || mode === undefined || typeof record.target !== 'string'
        || record.target.length > 4_096 || !isPreviewableUrl(record.target)) {
        res.writeHead(400, { 'cache-control': 'no-store' })
        res.end('invalid preview target')
        return
      }
      try {
        const descriptor = mode === 'browser'
          ? await browserSessions.create(record.target, origin)
          : server.createSession(record.target, origin)
        if (descriptor === undefined) {
          res.writeHead(503, { 'cache-control': 'no-store' })
          res.end('browser preview unavailable')
          return
        }
        res.writeHead(201, {
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8',
        })
        res.end(JSON.stringify(descriptor))
      } catch {
        res.writeHead(503, { 'cache-control': 'no-store' })
        res.end('preview session unavailable')
      }
      return
    }
    if (req.method === 'DELETE') {
      const record = exactRecord(value, ['sessionIds'])
      if (record === undefined || !Array.isArray(record.sessionIds) || record.sessionIds.length > 64
        || record.sessionIds.some(id => typeof id !== 'string' || !/^[a-f\d]{32}$/u.test(id))) {
        res.writeHead(400, { 'cache-control': 'no-store' })
        res.end('invalid preview session ids')
        return
      }
      server.releaseSessions(record.sessionIds as PreviewSessionId[])
      await browserSessions.release(record.sessionIds as PreviewSessionId[])
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(405, { allow: 'POST, DELETE', 'cache-control': 'no-store' })
    res.end()
  }
}

/**
 * Route handler for `/webview-browser-stream`: hold one server-sent-event
 * stream open for a browser session and forward its frames and state.
 *
 * The stream is a GET, so it cannot carry the plugin client header; the
 * 256-bit session/channel capability minted by the control route is the
 * authorization, and a browser-supplied Origin must still match the request
 * host when present.
 * @param sessions - browser preview manager owning the frames.
 * @returns the route handler owning the response until the client disconnects.
 */
function browserStreamHandler(
  sessions: BrowserPreviewSessions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' })
      res.end()
      return
    }
    const origin = req.headers.origin
    if (typeof origin === 'string' && requestOrigin(req) === undefined) {
      res.writeHead(403, { 'cache-control': 'no-store' })
      res.end('same-origin browser request required')
      return
    }
    let requestUrl: URL
    try {
      requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    } catch {
      res.writeHead(400, { 'cache-control': 'no-store' })
      res.end('bad request')
      return
    }
    const sessionId = requestUrl.searchParams.get('sessionId') ?? ''
    const channel = requestUrl.searchParams.get('channel') ?? ''
    if (!/^[a-f\d]{32}$/u.test(sessionId) || !/^[a-f\d]{32}$/u.test(channel)) {
      res.writeHead(400, { 'cache-control': 'no-store' })
      res.end('invalid preview session')
      return
    }
    res.writeHead(200, {
      'cache-control': 'no-store, no-transform',
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let closed = false
    const write = (chunk: string): void => {
      if (closed || res.writableEnded) return
      res.write(chunk)
    }
    const unsubscribe = sessions.subscribe(sessionId, channel, (event) => {
      write(`data: ${JSON.stringify(event)}\n\n`)
    })
    if (unsubscribe === undefined) {
      write(`data: ${JSON.stringify({ type: 'error', message: 'preview session not found' })}\n\n`)
      closed = true
      res.end()
      return
    }
    const heartbeat = setInterval(() => { write(': keep-alive\n\n') }, 15_000)
    heartbeat.unref()
    const cleanup = (): void => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
    }
    res.once('close', cleanup)
    req.once('close', cleanup)
  }
}

/**
 * Route handler for `/webview-browser-input`: forward pointer, keyboard, text,
 * viewport, and command requests into the browser page of one session.
 * @param sessions - browser preview manager owning the page targets.
 * @returns the route handler.
 */
function browserInputHandler(
  sessions: BrowserPreviewSessions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (req.headers[PREVIEW_CLIENT_HEADER] !== PREVIEW_CLIENT_HEADER_VALUE
      || !(req.headers['content-type'] ?? '').toString().toLowerCase().startsWith('application/json')) {
      res.writeHead(415, { 'cache-control': 'no-store' })
      res.end('preview client JSON required')
      return
    }
    if (requestOrigin(req) === undefined) {
      res.writeHead(403, { 'cache-control': 'no-store' })
      res.end('same-origin browser request required')
      return
    }
    let value: unknown
    try {
      value = await jsonBody(req)
    } catch (error) {
      res.writeHead(413, { 'cache-control': 'no-store' })
      res.end(error instanceof Error ? error.message : 'request too large')
      return
    }
    const request = previewBrowserRequestOf(value)
    if (request === undefined) {
      res.writeHead(400, { 'cache-control': 'no-store' })
      res.end('invalid browser input')
      return
    }
    const result = await sessions.dispatch(request)
    if (!result.ok) {
      res.writeHead(result.status, { 'cache-control': 'no-store' })
      res.end(result.message)
      return
    }
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    res.end(JSON.stringify(result.screenshot === undefined ? { ok: true } : { ok: true, screenshot: result.screenshot }))
  }
}

/**
 * Route handler for `/webview-annotations`: validate the POST body
 * structured snapshot and inject its node-owned rendering into the live agent.
 * @param ctx - context carrying the live-agent registry.
 * @param state - per-session dedupe state.
 * @returns the route handler owning this store.
 */
function annotationsHandler(
  ctx: Context,
  state: AnnotationCommitState,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    if (!(req.headers['content-type'] ?? '').toString().toLowerCase().startsWith('application/json')) {
      res.writeHead(415)
      res.end('application/json required')
      return
    }
    let body: string | undefined
    try {
      body = await readRequestBody(req, MAX_ANNOTATION_BODY)
    } catch (error) {
      res.writeHead(413)
      res.end(error instanceof Error ? error.message : 'body too large')
      return
    }
    const parsed = body === undefined ? undefined : parseAnnotationBody(body)
    if (parsed === undefined) {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    let result: ReturnType<typeof storeAnnotationSnapshot>
    try {
      result = storeAnnotationSnapshot(ctx.agents, state, parsed)
    } catch (error) {
      ctx.logger.warn(`annotation injection failed for session "${parsed.sessionId}": ${String(error)}`)
      res.writeHead(409)
      res.end('agent unavailable')
      return
    }
    if (result.kind === 'agent-not-found') {
      res.writeHead(404)
      res.end('session not found')
      return
    }
    if (result.kind === 'context-too-large') {
      res.writeHead(413)
      res.end('annotation context too large')
      return
    }
    const receipt = 'pending' in result
      ? { kind: 'ready' as const, snapshotId: result.pending.snapshotId }
      : { kind: 'empty' as const }
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-webview-annotation-result': result.kind,
    })
    res.end(JSON.stringify(receipt))
  }
}
