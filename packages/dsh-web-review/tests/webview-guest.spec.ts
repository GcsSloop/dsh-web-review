// @vitest-environment jsdom
/**
 * Built-in Browser guest wire.
 *
 * The desktop client's Browser is an Electron `<webview>` with no preload and no
 * reachable parent, so the plugin drives it with `executeJavaScript` in both
 * directions: it injects a host-owned queue and drains it. These cases pin that
 * wire — the injected bootstrap, the bounded drain decoding, the carrier's
 * message delivery, and which guest counts as on screen.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  WEBVIEW_DRAIN_GLOBAL,
  WEBVIEW_SINK_GLOBAL,
  browserGuests,
  guestOnScreen,
  guestPageUrl,
  visibleBrowserGuest,
  webviewBootstrapSource,
  webviewCarrier,
  webviewDrainStateOf,
  webviewGuestOf,
  webviewPageStateOf,
} from '../src/client/webview-guest.ts'
import type { PreviewChannel } from '../src/preview-contract.ts'
import { installFakeGuest } from './browser-annotation-fixture.ts'

const CHANNEL = 'a'.repeat(32) as PreviewChannel

function globals(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>
}

function drain(): string[] {
  const value = globals()[WEBVIEW_DRAIN_GLOBAL]
  if (typeof value !== 'function') throw new Error('drain is not installed')
  return (value as () => string[])()
}

/** Wait for a condition without depending on the poll interval. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition never became true')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  delete globals()[WEBVIEW_SINK_GLOBAL]
  delete globals()[WEBVIEW_DRAIN_GLOBAL]
})

describe('webview bootstrap', () => {
  it('installs a bounded queue and a draining function', () => {
    new Function(webviewBootstrapSource(CHANNEL))()

    const sink = globals()[WEBVIEW_SINK_GLOBAL] as { channel: string; push: (payload: unknown) => void }
    expect(sink.channel).toBe(CHANNEL)
    for (let index = 0; index < 200; index += 1) sink.push(`message-${String(index)}`)
    sink.push('')
    sink.push({ not: 'a string' })
    const drained = drain()
    expect(drained.length).toBe(128)
    // Bound drops the oldest payloads first.
    expect(drained[0]).toBe('message-72')
    expect(drained.at(-1)).toBe('message-199')
    expect(drain()).toEqual([])
  })
})

describe('drain decoding', () => {
  it('accepts a page observation with its queued payloads', () => {
    const parsed = webviewDrainStateOf({
      href: 'https://example.test/app/',
      title: 'Example',
      channel: CHANNEL,
      messages: ['{"direction":"frame-to-host"}'],
    })
    expect(parsed).toEqual({
      href: 'https://example.test/app/',
      title: 'Example',
      channel: CHANNEL,
      messages: ['{"direction":"frame-to-host"}'],
    })
  })

  it('rejects a forged channel, a non-array queue, and drops non-string messages', () => {
    expect(webviewDrainStateOf({ href: 'https://example.test/', title: '', channel: 'nope', messages: [] })).toBeUndefined()
    expect(webviewDrainStateOf({ href: 'https://example.test/', title: '', channel: null, messages: 'x' })).toBeUndefined()
    expect(webviewDrainStateOf(null)).toBeUndefined()
    expect(webviewDrainStateOf({
      href: 'https://example.test/', title: '', channel: null, messages: [1, null, 'ok'],
    })?.messages).toEqual(['ok'])
  })

  it('reads a probe result', () => {
    expect(webviewPageStateOf({ href: 'https://example.test/', title: 'T', channel: null }))
      .toEqual({ href: 'https://example.test/', title: 'T', channel: null })
    expect(webviewPageStateOf({ href: 'https://example.test/', title: 'T' })).toBeUndefined()
  })
})

describe('webview carrier', () => {
  it('delivers queued page messages and posts host commands through the receiver', async () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/', channel: CHANNEL })
    const carrier = webviewCarrier(guest.element as never, {
      channel: CHANNEL,
      frameOrigin: 'http://localhost:5173',
      intervalMs: 10,
    })
    const seen: unknown[] = []
    const unsubscribe = carrier.subscribe((message, origin) => { seen.push({ message, origin }) })

    guest.emit('cancel-pick', null)
    await until(() => seen.length > 0)
    expect(seen[0]).toEqual({ message: expect.objectContaining({ direction: 'frame-to-host' }), origin: 'http://localhost:5173' })

    carrier.post({ hello: 'page' }, 'http://localhost:5173')
    await until(() => guest.received.length > 0)
    expect(guest.received[0]).toEqual({ hello: 'page' })

    unsubscribe()
    carrier.dispose()
  })

  it('reports a replaced document instead of delivering its messages', async () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/', channel: CHANNEL })
    const stale: string[] = []
    const carrier = webviewCarrier(guest.element as never, {
      channel: CHANNEL,
      frameOrigin: 'http://localhost:5173',
      intervalMs: 10,
      onStale: (page) => { stale.push(page.href) },
    })
    const seen: unknown[] = []
    carrier.subscribe((message) => { seen.push(message) })

    guest.navigate('http://localhost:5173/next')
    guest.emit('cancel-pick', null)
    await until(() => stale.length > 0)
    expect(stale).toEqual(['http://localhost:5173/next'])
    expect(seen).toEqual([])
    carrier.dispose()
  })
})

describe('guest discovery', () => {
  it('narrows webview elements and skips everything else', () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/' })
    document.body.appendChild(document.createElement('div'))
    expect(browserGuests()).toHaveLength(1)
    expect(webviewGuestOf(document.body)).toBeUndefined()
    expect(webviewGuestOf({})).toBeUndefined()
    expect(guestPageUrl(browserGuests()[0]!)).toBe('http://localhost:5173/')
    expect(guestOnScreen(browserGuests()[0]!)).toBe(true)
    guest.destroy()
  })

  it('treats a hidden tab as not on screen and picks the visible one', () => {
    const hidden = installFakeGuest({ url: 'http://localhost:5173/hidden', visible: false })
    expect(visibleBrowserGuest()).toBeUndefined()
    const visible = installFakeGuest({ url: 'http://localhost:5173/visible' })
    expect(visibleBrowserGuest()).toBe(visible.element)
    expect(guestOnScreen(hidden.element as never)).toBe(false)
  })

  it('does not annotate a page that is not HTTP(S)', () => {
    const guest = installFakeGuest({ url: 'about:blank#lease' })
    expect(guestPageUrl(browserGuests()[0]!)).toBeUndefined()
    expect(visibleBrowserGuest()).toBe(guest.element)
  })
})
