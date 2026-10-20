// @vitest-environment jsdom
/**
 * Built-in Browser delivery.
 *
 * The desktop client's Browser guest has no preload (`ipc-message` is out) and no
 * reachable parent window (`parent.postMessage` is out), so the host installs a
 * queue and drains it with `executeJavaScript`. These cases pin that the bridge
 * prefers the queue over every other transport and answers the same commands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewChannel } from '../src/preview-contract.ts'
import { WEBVIEW_DRAIN_GLOBAL, WEBVIEW_SINK_GLOBAL, webviewBootstrapSource } from '../src/client/webview-guest.ts'

const CHANNEL = 'e'.repeat(32) as PreviewChannel

interface PageGlobals extends Record<string, unknown> {
  __DSH_WEB_REVIEW_BRIDGE_CONFIG__?: unknown
  postMessage?: unknown
}

function globals(): PageGlobals {
  return window as unknown as PageGlobals
}

/** Install the host queue and freeze the bridge config for one document. */
function stageGuest(): { drained: () => string[] } {
  new Function(webviewBootstrapSource(CHANNEL))()
  globals().__DSH_WEB_REVIEW_BRIDGE_CONFIG__ = {
    protocol: 'dsh-web-review/bridge',
    version: 1,
    channel: CHANNEL,
    // A guest has no parent to answer to; the bridge only validates the field.
    parentOrigin: 'http://127.0.0.1:64240',
    pageUrl: 'https://example.test/app/',
    targetOrigin: 'https://example.test',
  }
  globals().postMessage = vi.fn()
  return {
    drained: () => {
      const value = globals()[WEBVIEW_DRAIN_GLOBAL]
      if (typeof value !== 'function') throw new Error('drain is not installed')
      return (value as () => string[])()
    },
  }
}

function messages(drained: readonly string[]): { channel?: string; direction?: string; event?: { name?: string } }[] {
  const parsed: { channel?: string; direction?: string; event?: { name?: string } }[] = []
  for (const payload of drained) {
    try {
      parsed.push(JSON.parse(payload) as { channel?: string; direction?: string; event?: { name?: string } })
    } catch { /* a host payload is never malformed; one here would be a bug */ }
  }
  return parsed.filter(message => message.direction === 'frame-to-host' && message.channel === CHANNEL)
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  delete globals()[WEBVIEW_SINK_GLOBAL]
  delete globals()[WEBVIEW_DRAIN_GLOBAL]
  delete globals().__DSH_WEB_REVIEW_BRIDGE_CONFIG__
})

describe('built-in Browser delivery', () => {
  it('queues its handshake instead of posting to a parent window', async () => {
    const staged = stageGuest()
    await import('../src/bridge/index.ts')
    const posted = messages(staged.drained())
    expect(posted.map(message => message.event?.name)).toContain('ready')
    expect(globals().postMessage).not.toHaveBeenCalled()
  })

  it('answers a host command delivered through the receiver global', async () => {
    stageGuest()
    document.body.innerHTML = '<div id="card"><button id="go">Go</button></div>'
    await import('../src/bridge/index.ts')
    const received = globals()['__dshWebReviewReceive'] as (raw: string) => void

    received(JSON.stringify({
      protocol: 'dsh-web-review/bridge',
      version: 1,
      channel: CHANNEL,
      direction: 'host-to-frame',
      requestId: 'arm-1',
      command: { name: 'activate', payload: null },
    }))
    expect(document.documentElement.classList.contains('dsh-wv-picking')).toBe(true)

    const button = document.getElementById('go') as HTMLButtonElement
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    const value = globals()[WEBVIEW_DRAIN_GLOBAL]
    if (typeof value !== 'function') throw new Error('drain is not installed')
    const drained = value() as string[]
    const parsed = drained.map(payload => JSON.parse(payload) as {
      direction?: string
      requestId?: string
      response?: { ok?: boolean }
      event?: { name?: string }
    })
    expect(parsed.some(message => message.requestId === 'arm-1' && message.response?.ok === true)).toBe(true)
    expect(parsed.filter(message => message.event?.name === 'pick')).toHaveLength(1)
  })

  it('ignores a page-level postMessage that tries to address the bridge', async () => {
    stageGuest()
    await import('../src/bridge/index.ts')
    const received = globals()['__dshWebReviewReceive'] as (raw: string) => void
    let executed = false
    received(JSON.stringify({
      protocol: 'dsh-web-review/bridge',
      version: 1,
      channel: CHANNEL,
      direction: 'host-to-frame',
      requestId: 'probe',
      command: { name: 'activate', payload: null },
    }))
    executed = document.documentElement.classList.contains('dsh-wv-picking')
    expect(executed).toBe(true)

    // Without a host, a guest page can only reach itself; that path is disabled
    // so the page cannot replay commands into its own bridge as if the host had.
    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: 'http://127.0.0.1:64240',
      data: {
        protocol: 'dsh-web-review/bridge',
        version: 1,
        channel: CHANNEL,
        direction: 'host-to-frame',
        requestId: 'forged',
        command: { name: 'deactivate', payload: null },
      },
    }))
    expect(document.documentElement.classList.contains('dsh-wv-picking')).toBe(true)
  })
})
