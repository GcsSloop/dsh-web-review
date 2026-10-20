// @vitest-environment jsdom
/**
 * Host annotation session against the built-in Browser.
 *
 * There is no node-side preview session here: the guest loads its own URL, and
 * the controller injects the same bridge artifact, builds a descriptor for that
 * document, and re-attaches when the document is replaced. These cases pin the
 * attach flow, the picker arm/disarm, marker sync, and the recovery path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserAnnotationSession,
  type BrowserAnnotationEvents,
  type BrowserPage,
} from '../src/client/browser-annotation.ts'
import { PREVIEW_BRIDGE_PROTOCOL, PREVIEW_BRIDGE_VERSION } from '../src/preview-contract.ts'
import { installFakeGuest, type FakeGuest } from './browser-annotation-fixture.ts'

const BRIDGE_SOURCE = ';(() => { /* the built bridge artifact */ })()'

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition never became true')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

interface RecordedEvents extends BrowserAnnotationEvents {
  pages: (BrowserPage | null)[]
  idle: string[]
  failures: string[]
  handoffs: unknown[]
  ready: number
}

function recordingEvents(): RecordedEvents {
  const events: RecordedEvents = {
    pages: [],
    idle: [],
    failures: [],
    handoffs: [],
    ready: 0,
    onPage: (page) => { events.pages.push(page) },
    onIdle: (reason) => { events.idle.push(reason) },
    onReady: () => { events.ready += 1 },
    onPick: () => undefined,
    onCancelPick: () => undefined,
    onMarkClick: () => undefined,
    onTargetGeometry: () => undefined,
    onShortcut: () => undefined,
    onHandoff: (next) => { events.handoffs.push(next) },
    onUnavailable: () => undefined,
    onFailure: (failure) => { events.failures.push(failure) },
  }
  return events
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(BRIDGE_SOURCE, {
    status: 200,
    headers: { 'content-type': 'text/javascript' },
  }))))
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('BrowserAnnotationSession', () => {
  it('announces the visible page and attaches on demand', async () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/', title: 'Demo' })
    const events = recordingEvents()
    const session = new BrowserAnnotationSession(events)
    session.start()
    expect(events.pages.at(-1)).toEqual({ url: 'http://localhost:5173/', title: 'Demo' })
    expect(events.ready).toBe(0)

    await session.activate()
    await until(() => events.ready === 1)

    // The injection carries the frozen config for this exact document.
    expect(guest.injected.length).toBe(1)
    const config = /window\.__DSH_WEB_REVIEW_BRIDGE_CONFIG__=(\{[\s\S]*?\});/u.exec(guest.injected[0] ?? '')
    const parsed = JSON.parse(config?.[1] ?? '{}') as Record<string, unknown>
    expect(parsed.protocol).toBe(PREVIEW_BRIDGE_PROTOCOL)
    expect(parsed.version).toBe(PREVIEW_BRIDGE_VERSION)
    expect(parsed.pageUrl).toBe('http://localhost:5173/')
    expect(parsed.targetOrigin).toBe('http://localhost:5173')
    expect(parsed.channel).toBe(guest.channel)
    expect(guest.injected[0]).not.toContain('sourceMappingURL')
    expect(session.attached).toBe(true)
    session.stop()
  })

  it('arms the picker on activate and disarms it without dropping the bridge', async () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/' })
    const session = new BrowserAnnotationSession(recordingEvents())
    session.start()
    await session.activate()
    await until(() => guest.received.some(message => nameOf(message) === 'activate'))

    session.deactivate()
    await until(() => guest.received.some(message => nameOf(message) === 'deactivate'))
    expect(session.attached).toBe(true)
    expect(guest.received.some(message => nameOf(message) === 'cancel-edit')).toBe(true)
    session.stop()
    expect(session.attached).toBe(false)
  })

  it('mirrors picks into page markers', async () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/' })
    const session = new BrowserAnnotationSession(recordingEvents())
    session.start()
    await session.activate()
    await until(() => guest.received.some(message => nameOf(message) === 'activate'))

    session.setPicks([{
      id: 'pick-1',
      snapshot: {
        tagName: 'button', id: 'go', className: 'primary', cssPath: '#go',
        fullPath: 'html > body > button', label: 'Go', role: 'button',
        stableClasses: ['primary'], anchor: null, inToolChrome: false,
        outerHTML: '<button id="go">Go</button>', textContent: 'Go',
        rect: { x: 1, y: 2, width: 3, height: 4 },
        computed: {
          display: 'block', position: 'static', fontSize: '14px', color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgba(0, 0, 0, 0)', margin: '0px', padding: '0px',
          width: '3px', height: '4px',
        },
      },
      comment: 'make it bigger',
      changes: [],
      textChange: null,
      viewport: { width: 1024, height: 768 },
    }])
    await until(() => guest.received.filter(message => nameOf(message) === 'sync-markers').length > 0)
    // The ready handshake already re-synced the (then empty) list; the last one
    // carries the pick that was added afterwards.
    const markers = guest.received.filter(message => nameOf(message) === 'sync-markers').at(-1)
    const payload = markers?.command as { payload?: { markers?: { cssPath: string; index: number }[] } } | undefined
    expect(payload?.payload?.markers).toEqual([
      { id: 'pick-1', index: 1, cssPath: '#go', changes: [], textChange: null },
    ])
    session.stop()
  })

  it('re-attaches with a fresh channel when the document is replaced', async () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/', title: 'Demo' })
    const events = recordingEvents()
    const session = new BrowserAnnotationSession(events)
    session.start()
    await session.activate()
    await until(() => events.ready === 1)
    const first = guest.channel

    guest.navigate('http://localhost:5173/next', 'Next')
    await until(() => events.ready === 2)

    expect(guest.injected.length).toBe(2)
    expect(guest.channel).not.toBe(first)
    expect(events.handoffs).toEqual([{ url: 'http://localhost:5173/next', title: 'Next' }])
    // Picking survives the document change: the new bridge is armed as well.
    await until(() => guest.received.filter(message => nameOf(message) === 'activate').length >= 2)
    session.stop()
  })

  it('reports why it cannot attach instead of leaving the mode armed', async () => {
    const events = recordingEvents()
    const session = new BrowserAnnotationSession(events)
    session.start()
    await session.activate()
    expect(events.failures).toEqual(['no-page'])
    expect(session.attached).toBe(false)
    session.stop()
  })

  it('keeps a page that is not HTTP(S) out of annotation', async () => {
    installFakeGuest({ url: 'about:blank#lease' })
    const events = recordingEvents()
    const session = new BrowserAnnotationSession(events)
    session.start()
    expect(events.idle).toEqual(['not-http'])
    await session.activate()
    expect(events.failures).toEqual(['no-page'])
    session.stop()
  })

  it('tells the dock why there is nothing to annotate', () => {
    const events = recordingEvents()
    const session = new BrowserAnnotationSession(events)
    session.start()
    expect(events.idle).toEqual(['no-guest'])

    const hidden = installFakeGuest({ url: 'http://localhost:5173/', visible: false })
    session.refresh()
    expect(events.idle.at(-1)).toBe('not-visible')
    hidden.destroy()
    session.stop()
  })
})

function nameOf(message: Record<string, unknown>): string | undefined {
  const command = message.command as { name?: unknown } | undefined
  return typeof command?.name === 'string' ? command.name : undefined
}

function unusedGuestType(_guest: FakeGuest): void {}
void unusedGuestType
