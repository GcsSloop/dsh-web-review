/**
 * Fake built-in Browser guest for host-side tests.
 *
 * jsdom cannot run an Electron `<webview>`, so this stands in for the guest's
 * three observable faces (`getURL`, `getTitle`, `executeJavaScript`) and plays
 * the page's half of the wire: it interprets the host's probe/drain sources, runs
 * the injected configuration, queues `ready`, and answers host commands the way
 * the real bridge does.
 */
import { EDITABLE_STYLE_PROPERTIES, type EditableStyleProperty } from '../src/annotation-properties.ts'
import {
  PREVIEW_BRIDGE_PROTOCOL,
  PREVIEW_BRIDGE_VERSION,
  type PreviewFrameEvent,
} from '../src/preview-contract.ts'
import { WEBVIEW_DRAIN_SOURCE, WEBVIEW_PROBE_SOURCE } from '../src/client/webview-guest.ts'

export interface FakeGuestOptions {
  url: string
  title?: string
  /** Pre-existing queue channel; omit or null for a document with no bridge. */
  channel?: string | null
  /** Whether the element's rectangle is on screen. */
  visible?: boolean
}

export interface FakeGuest {
  element: HTMLElement
  /** Payloads the page queued for the host, oldest first. */
  outgoing: string[]
  /** Host messages the page received. */
  received: Record<string, unknown>[]
  /** Sources the host injected, in order. */
  injected: string[]
  /** Current document address (page-side navigation changes it). */
  url: string
  title: string
  channel: string | null
  /** Replace the document: new address, no bridge, new outgoing queue. */
  navigate: (url: string, title?: string) => void
  /** Queue one page event for the next drain. */
  emit: (name: PreviewFrameEvent['name'], payload: unknown) => void
  destroy: () => void
}

/** Payloads a test page would produce for one serialized element target. */
export function fakeTargetPayload(handle: string): Record<string, unknown> {
  const baselines = Object.fromEntries(EDITABLE_STYLE_PROPERTIES.map(property => [
    property,
    property === 'font-size' ? '16px'
      : property === 'display' ? 'block'
        : property === 'position' ? 'static'
          : '',
  ])) as Record<EditableStyleProperty, string>
  return {
    handle,
    snapshot: {
      tagName: 'button',
      id: 'go',
      className: 'primary',
      cssPath: '#go',
      fullPath: 'html > body > div > button',
      label: 'Go',
      role: 'button',
      stableClasses: ['primary'],
      inToolChrome: false,
      anchor: null,
      outerHTML: '<button id="go">Go</button>',
      textContent: 'Go',
      rect: { x: 10, y: 20, width: 80, height: 30 },
      computed: {
        display: 'block',
        position: 'static',
        fontSize: '14px',
        color: 'rgb(0, 0, 0)',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        margin: '0px',
        padding: '0px',
        width: '80px',
        height: '30px',
      },
    },
    rect: { x: 10, y: 20, width: 80, height: 30 },
    viewport: { width: 1024, height: 768 },
    baselines,
    inlineStyles: {},
    originalText: null,
    detail: { kind: 'text', text: 'Go' },
    navigation: {
      child: false,
      parent: true,
      'previous-sibling': false,
      'next-sibling': false,
    },
  }
}

/**
 * Install one fake guest element into the document.
 * @param options - page address, title, and whether the element is on screen.
 * @returns the fake guest handle.
 */
export function installFakeGuest(options: FakeGuestOptions): FakeGuest {
  const visible = options.visible ?? true
  const element = document.createElement('webview')
  element.setAttribute('data-sidebar-browser-frame', 'webview')

  const guest = {
    url: options.url,
    title: options.title ?? 'Fixture',
    channel: options.channel ?? null,
    outgoing: [] as string[],
    received: [] as Record<string, unknown>[],
    injected: [] as string[],
    destroyed: false,
  }

  const queue = (event: { name: string; payload: unknown }): void => {
    guest.outgoing.push(JSON.stringify({
      protocol: PREVIEW_BRIDGE_PROTOCOL,
      version: PREVIEW_BRIDGE_VERSION,
      channel: guest.channel,
      direction: 'frame-to-host',
      event,
    }))
  }

  const respond = (message: Record<string, unknown>): void => {
    const requestId = typeof message.requestId === 'string' ? message.requestId : ''
    guest.outgoing.push(JSON.stringify({
      protocol: PREVIEW_BRIDGE_PROTOCOL,
      version: PREVIEW_BRIDGE_VERSION,
      channel: guest.channel,
      direction: 'frame-to-host',
      requestId,
      response: { ok: true, value: null },
    }))
  }

  const pageState = (): Record<string, unknown> => ({
    href: guest.url,
    title: guest.title,
    channel: guest.channel,
  })

  const page = {
    async executeJavaScript(code: string): Promise<unknown> {
      if (guest.destroyed) throw new Error('guest destroyed')
      if (code === WEBVIEW_PROBE_SOURCE) return pageState()
      if (code === WEBVIEW_DRAIN_SOURCE) {
        return { ...pageState(), messages: guest.outgoing.splice(0, guest.outgoing.length) }
      }
      const configMatch = /window\.__DSH_WEB_REVIEW_BRIDGE_CONFIG__=(\{[\s\S]*?\});/u.exec(code)
      if (configMatch !== null) {
        const config = JSON.parse(configMatch[1] ?? '{}') as { channel?: unknown; pageUrl?: unknown }
        guest.injected.push(code)
        if (typeof config.channel === 'string') guest.channel = config.channel
        if (typeof config.pageUrl === 'string') guest.url = config.pageUrl
        queue({
          name: 'ready',
          payload: {
            pageUrl: guest.url,
            title: guest.title,
            viewport: { width: 1024, height: 768 },
            canGoBack: false,
            canGoForward: false,
          },
        })
        return undefined
      }
      const callMatch = /__dshWebReviewReceive\(("(?:[^"\\]|\\.)*")()/u.exec(code)
      if (callMatch !== null) {
        const message = JSON.parse(JSON.parse(callMatch[1] ?? '""')) as Record<string, unknown>
        guest.received.push(message)
        respond(message)
        return undefined
      }
      return undefined
    },
    getURL: (): string => guest.url,
    getTitle: (): string => guest.title,
    getBoundingClientRect: (): DOMRect => (visible
      ? { x: 900, y: 0, width: 320, height: 700, top: 0, left: 900, right: 1220, bottom: 700, toJSON: () => ({}) } as DOMRect
      : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect),
  }

  Object.assign(element, page)
  document.body.appendChild(element)

  return {
    element,
    get outgoing() { return guest.outgoing },
    get received() { return guest.received },
    get injected() { return guest.injected },
    get url() { return guest.url },
    get title() { return guest.title },
    get channel() { return guest.channel },
    navigate(url: string, title = guest.title) {
      guest.url = url
      guest.title = title
      guest.channel = null
      guest.outgoing.length = 0
    },
    emit(name, payload) {
      queue({ name, payload } as { name: string; payload: unknown })
    },
    destroy() {
      guest.destroyed = true
      element.remove()
    },
  }
}
