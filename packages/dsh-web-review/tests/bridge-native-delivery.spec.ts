// @vitest-environment jsdom
/**
 * Native panel delivery.
 *
 * A previewed HTTPS page cannot POST to the plugin's loopback endpoint — WebKit
 * refuses the insecure request ("Load failed" for `fetch`, `false` from
 * `sendBeacon`, measured in a live panel) — so the shell installs a script
 * message handler and the bridge must prefer it. These cases pin that choice and
 * the bounded hold for the moment before the handler exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PREVIEW_BRIDGE_PROTOCOL, PREVIEW_BRIDGE_VERSION } from '../src/preview-contract.ts'

/** A valid channel for the frozen config. */
const CHANNEL = 'a'.repeat(32)
const ENDPOINT = `http://127.0.0.1:54321/native-event?sessionId=${'b'.repeat(32)}&channel=${CHANNEL}`

interface PageGlobals {
  __DSH_WEB_REVIEW_BRIDGE_CONFIG__?: unknown
  __DSH_WEB_REVIEW_NATIVE_ENDPOINT__?: unknown
  __DSH_WEB_REVIEW_NATIVE_IPC__?: unknown
  __DSH_WEB_REVIEW_CHANNEL__?: unknown
  webkit?: unknown
  postMessage?: unknown
}

/** Stage one panel document and record what it posts to the shell. */
function stagePage(options: { endpoint?: string; marker?: string; handler?: boolean }): {
  ipc: string[]
  parent: unknown[]
  endpointCalls: string[]
} {
  const globals = window as unknown as PageGlobals
  const ipc: string[] = []
  const parent: unknown[] = []
  const endpointCalls: string[] = []
  globals.__DSH_WEB_REVIEW_BRIDGE_CONFIG__ = {
    protocol: PREVIEW_BRIDGE_PROTOCOL,
    version: PREVIEW_BRIDGE_VERSION,
    channel: CHANNEL,
    parentOrigin: 'http://127.0.0.1:64240',
    pageUrl: 'https://example.test/app/',
    targetOrigin: 'https://example.test',
    ...(options.endpoint === undefined ? {} : { native: { endpoint: options.endpoint } }),
  }
  if (options.endpoint !== undefined) globals.__DSH_WEB_REVIEW_NATIVE_ENDPOINT__ = options.endpoint
  if (options.marker !== undefined) globals.__DSH_WEB_REVIEW_NATIVE_IPC__ = options.marker
  if (options.handler === true) {
    globals.webkit = { messageHandlers: { dshWebReview: { postMessage: (body: string) => { ipc.push(body) } } } }
  }
  globals.postMessage = (message: unknown) => { parent.push(message) }
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    endpointCalls.push(String(url))
    return Promise.resolve(new Response(null, { status: 204 }))
  }))
  return { ipc, parent, endpointCalls }
}

/** Parse every frame-to-host message a sink received. */
function frameMessages(bodies: readonly string[]): { event?: { name?: string } }[] {
  return bodies
    .map((body) => {
      try { return JSON.parse(body) as { direction?: string; event?: { name?: string } } } catch { return undefined }
    })
    .filter((parsed): parsed is { direction?: string; event?: { name?: string } } => parsed !== undefined)
    .filter(parsed => parsed.direction === 'frame-to-host')
}

beforeEach(() => {
  vi.resetModules()
  const globals = window as unknown as PageGlobals
  delete globals.__DSH_WEB_REVIEW_BRIDGE_CONFIG__
  delete globals.__DSH_WEB_REVIEW_NATIVE_ENDPOINT__
  delete globals.__DSH_WEB_REVIEW_NATIVE_IPC__
  delete globals.webkit
  document.body.innerHTML = ''
})

describe('native panel delivery', () => {
  it('uses the shell script message handler instead of the blocked endpoint', async () => {
    const staged = stagePage({ endpoint: ENDPOINT, marker: 'dshWebReview', handler: true })
    await import('../src/bridge/index.ts')

    const posted = frameMessages(staged.ipc)
    expect(posted.map(message => message.event?.name)).toContain('ready')
    // The insecure loopback request is exactly what WebKit refuses here.
    expect(staged.endpointCalls).toEqual([])
    expect(staged.parent).toEqual([])
  })

  it('falls back to the endpoint when no handler is exposed yet', async () => {
    const staged = stagePage({ endpoint: ENDPOINT, marker: 'dshWebReview' })
    await import('../src/bridge/index.ts')

    // An HTTP page still uses the loopback endpoint the shell named.
    expect(staged.endpointCalls).toEqual([ENDPOINT])
    expect(frameMessages(staged.ipc)).toEqual([])
  })

  it('keeps parent postMessage for a hosted preview frame', async () => {
    const staged = stagePage({})
    await import('../src/bridge/index.ts')

    expect(staged.parent.length).toBeGreaterThan(0)
    expect(staged.endpointCalls).toEqual([])
  })
})
