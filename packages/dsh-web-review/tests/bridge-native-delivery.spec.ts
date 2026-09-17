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

/**
 * A valid channel for the frozen config.
 *
 * Every case takes its own: importing the bridge installs document listeners
 * that stay for the life of the jsdom document, so earlier bridges keep running
 * and would otherwise answer a later case's events.
 */
const CHANNEL = 'a'.repeat(32)
/** The endpoint a case's page reports to; unique per case for the same reason. */
function endpointFor(channel: string, port = 54321): string {
  return `http://127.0.0.1:${String(port)}/native-event?sessionId=${'b'.repeat(32)}&channel=${channel}`
}
const ENDPOINT = endpointFor(CHANNEL)

interface PageGlobals {
  __DSH_WEB_REVIEW_BRIDGE_CONFIG__?: unknown
  __DSH_WEB_REVIEW_NATIVE_ENDPOINT__?: unknown
  __DSH_WEB_REVIEW_NATIVE_IPC__?: unknown
  __DSH_WEB_REVIEW_CHANNEL__?: unknown
  webkit?: unknown
  postMessage?: unknown
}

/** Stage one panel document and record what it posts to the shell. */
function stagePage(options: { endpoint?: string; marker?: string; handler?: boolean; channel?: string }): {
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
    channel: options.channel ?? CHANNEL,
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

/** Parse the frame-to-host messages one case's sink received. */
function frameMessages(bodies: readonly string[], channel = CHANNEL): { event?: { name?: string } }[] {
  return bodies
    .map((body) => {
      try {
        return JSON.parse(body) as { direction?: string; channel?: string; event?: { name?: string } }
      } catch { return undefined }
    })
    .filter((parsed): parsed is { direction?: string; channel?: string; event?: { name?: string } } => parsed !== undefined)
    .filter(parsed => parsed.direction === 'frame-to-host' && parsed.channel === channel)
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

  it('installs the picker even when it runs before any element exists', async () => {
    // Exactly the document-start condition the shell's panel and a CDP-driven
    // page produce: no <head> and no <html> yet, so appending to a missing head
    // used to throw and silently take every picker listener with it.
    const html = document.documentElement
    document.removeChild(html)
    const channel = 'd'.repeat(32)
    const staged = stagePage({ endpoint: endpointFor(channel, 54325), marker: 'dshWebReview', handler: true, channel })
    try {
      await import('../src/bridge/index.ts')
      expect(document.querySelector('style[data-dsh-web-review="picker"]')).toBeNull()
    } finally {
      document.appendChild(html)
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.querySelector('style[data-dsh-web-review="picker"]')).not.toBeNull()

    // And the listeners came with it: hover then click still picks.
    const card = document.createElement('div')
    document.body.appendChild(card)
    const receive = (window as unknown as { __dshWebReviewReceive: (raw: string) => void }).__dshWebReviewReceive
    receive(JSON.stringify({
      protocol: PREVIEW_BRIDGE_PROTOCOL, version: PREVIEW_BRIDGE_VERSION, channel,
      direction: 'host-to-frame', requestId: 'arm-2', command: { name: 'activate', payload: null },
    }))
    card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(frameMessages(staged.ipc, channel).some(message => message.event?.name === 'pick')).toBe(true)
  })

  it('arms the picker and reports a hovered element click', async () => {
    const channel = 'c'.repeat(32)
    const staged = stagePage({ endpoint: endpointFor(channel, 54324), marker: 'dshWebReview', handler: true, channel })
    document.body.innerHTML = '<div id="card"><button id="go">Go</button></div>'
    await import('../src/bridge/index.ts')

    // The picker's own stylesheet is what draws the hover outline; without it
    // there is no visible feedback and no listener either.
    expect(document.querySelector('style[data-dsh-web-review="picker"]')).not.toBeNull()

    const activate = JSON.stringify({
      protocol: PREVIEW_BRIDGE_PROTOCOL, version: PREVIEW_BRIDGE_VERSION, channel,
      direction: 'host-to-frame', requestId: 'arm-1', command: { name: 'activate', payload: null },
    })
    const receive = (window as unknown as { __dshWebReviewReceive: (raw: string) => void }).__dshWebReviewReceive
    receive(activate)
    expect(document.documentElement.classList.contains('dsh-wv-picking')).toBe(true)

    // A pick is the hovered element's, exactly as a real pointer behaves.
    const button = document.getElementById('go') as HTMLButtonElement
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(document.querySelectorAll('[data-dsh-wv-hover]').length).toBe(1)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    const picked = frameMessages(staged.ipc, channel).filter(message => message.event?.name === 'pick')
    expect(picked.length).toBe(1)
  })

  it('keeps parent postMessage for a hosted preview frame', async () => {
    const staged = stagePage({})
    await import('../src/bridge/index.ts')

    expect(staged.parent.length).toBeGreaterThan(0)
    expect(staged.endpointCalls).toEqual([])
  })
})
