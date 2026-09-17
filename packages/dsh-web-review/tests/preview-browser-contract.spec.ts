/** Strict-decode suite for the browser preview session and input contracts. */
import { describe, expect, it } from 'vitest'
import {
  PREVIEW_BROWSER_LIMITS,
  previewBrowserRequestOf,
  previewSessionDescriptorOf,
} from '../src/preview-contract.ts'

const SESSION = 'a'.repeat(32)
const CHANNEL = 'b'.repeat(32)

describe('previewSessionDescriptorOf', () => {
  it('accepts a browser descriptor whose address is the live page URL', () => {
    const descriptor = previewSessionDescriptorOf({
      sessionId: SESSION,
      mode: 'browser',
      frameUrl: 'http://127.0.0.1:1280/cloc/webui/?tab=one',
      frameOrigin: 'http://127.0.0.1:58845',
      targetOrigin: 'http://127.0.0.1:1280',
      channel: CHANNEL,
    })
    expect(descriptor?.mode).toBe('browser')
    expect(descriptor?.targetOrigin).toBe('http://127.0.0.1:1280')
  })

  it('rejects a browser descriptor whose address left the target Origin', () => {
    expect(previewSessionDescriptorOf({
      sessionId: SESSION,
      mode: 'browser',
      frameUrl: 'https://attacker.example/',
      frameOrigin: 'http://127.0.0.1:58845',
      targetOrigin: 'http://127.0.0.1:1280',
      channel: CHANNEL,
    })).toBeUndefined()
  })

  it('keeps the proxy descriptor checks and requires the mode', () => {
    const proxy = {
      sessionId: SESSION,
      mode: 'proxy',
      frameOrigin: `http://${SESSION}.localhost:43123`,
      frameUrl: `http://${SESSION}.localhost:43123/.dsh-web-review/entry/http%3A//127.0.0.1%3A1280/`,
      targetOrigin: 'http://127.0.0.1:1280',
      channel: CHANNEL,
    }
    expect(previewSessionDescriptorOf(proxy)?.mode).toBe('proxy')
    expect(previewSessionDescriptorOf({ ...proxy, mode: undefined })).toBeUndefined()
    expect(previewSessionDescriptorOf({ ...proxy, mode: 'direct' })).toBeUndefined()
    expect(previewSessionDescriptorOf({ ...proxy, frameOrigin: 'http://other.localhost:43123' })).toBeUndefined()
  })

  it('rejects unknown keys, credentials, and a non-origin target', () => {
    const base = {
      sessionId: SESSION,
      mode: 'browser',
      frameUrl: 'http://127.0.0.1:1280/',
      frameOrigin: 'http://127.0.0.1:58845',
      targetOrigin: 'http://127.0.0.1:1280',
      channel: CHANNEL,
    }
    expect(previewSessionDescriptorOf({ ...base, extra: true })).toBeUndefined()
    expect(previewSessionDescriptorOf({ ...base, frameUrl: 'http://user:pass@127.0.0.1:1280/' })).toBeUndefined()
    expect(previewSessionDescriptorOf({ ...base, targetOrigin: 'http://127.0.0.1:1280/path' })).toBeUndefined()
  })
})

describe('previewBrowserRequestOf', () => {
  it('accepts one pointer input, one wheel input, and typed text', () => {
    expect(previewBrowserRequestOf({
      sessionId: SESSION,
      channel: CHANNEL,
      input: { kind: 'mouse', type: 'down', x: 10.5, y: -4, button: 'left', clickCount: 1, modifiers: 8 },
    })).toEqual({
      sessionId: SESSION,
      channel: CHANNEL,
      input: { kind: 'mouse', type: 'down', x: 10.5, y: -4, button: 'left', clickCount: 1, modifiers: 8 },
    })
    expect(previewBrowserRequestOf({
      sessionId: SESSION,
      channel: CHANNEL,
      input: { kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: -120 },
    })?.input).toEqual({ kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: -120, modifiers: 0 })
    expect(previewBrowserRequestOf({
      sessionId: SESSION,
      channel: CHANNEL,
      input: { kind: 'text', text: '城市照明' },
    })?.input).toEqual({ kind: 'text', text: '城市照明' })
  })

  it('rejects unbounded, malformed, or ambiguous input', () => {
    const reject = (input: unknown): void => {
      expect(previewBrowserRequestOf({ sessionId: SESSION, channel: CHANNEL, input })).toBeUndefined()
    }
    reject({ kind: 'mouse', type: 'down', x: 1e9, y: 0, button: 'left', clickCount: 1, modifiers: 0 })
    reject({ kind: 'mouse', type: 'click', x: 1, y: 0, button: 'left', clickCount: 1, modifiers: 0 })
    reject({ kind: 'mouse', type: 'down', x: 1, y: 0, button: 'back', clickCount: 1, modifiers: 0 })
    reject({ kind: 'mouse', type: 'down', x: 1, y: 0, button: 'left', clickCount: 1, modifiers: 99 })
    reject({ kind: 'text', text: 'x'.repeat(PREVIEW_BROWSER_LIMITS.text + 1) })
    reject({ kind: 'nope' })
    expect(previewBrowserRequestOf({
      sessionId: SESSION,
      channel: CHANNEL,
      input: { kind: 'text', text: 'a' },
      command: { name: 'reload' },
    })).toBeUndefined()
    expect(previewBrowserRequestOf({ sessionId: SESSION, channel: CHANNEL })).toBeUndefined()
  })

  it('accepts navigation only to the bound target Origin', () => {
    expect(previewBrowserRequestOf({
      sessionId: SESSION,
      channel: CHANNEL,
      command: { name: 'navigate', url: 'http://127.0.0.1:1280/other' },
    })?.command).toEqual({ name: 'navigate', url: 'http://127.0.0.1:1280/other' })
    expect(previewBrowserRequestOf({
      sessionId: SESSION,
      channel: CHANNEL,
      command: { name: 'navigate', url: 'file:///etc/passwd' },
    })).toBeUndefined()
    expect(previewBrowserRequestOf({
      sessionId: SESSION,
      channel: CHANNEL,
      command: { name: 'navigate' },
    })).toBeUndefined()
    expect(previewBrowserRequestOf({
      sessionId: SESSION,
      channel: CHANNEL,
      command: { name: 'reload', url: 'http://127.0.0.1:1280/' },
    })).toBeUndefined()
    expect(previewBrowserRequestOf({
      sessionId: SESSION,
      channel: CHANNEL,
      command: { name: 'back' },
    })?.command).toEqual({ name: 'back' })
  })
})
