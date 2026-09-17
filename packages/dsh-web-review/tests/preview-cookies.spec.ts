/** Pure-function suite for the preview transport cookie policy. */
import { describe, expect, it } from 'vitest'
import {
  MAX_COOKIES_PER_ORIGIN,
  PreviewCookieJar,
  cookiePathMatches,
  parsePreviewCookie,
  relayedPreviewCookie,
} from '../src/preview-cookies.ts'

describe('parsePreviewCookie', () => {
  it('parses name, value, path, expiry, and secure scope', () => {
    const now = 1_000_000
    expect(parsePreviewCookie('sid=abc; Path=/app; Max-Age=60; Secure; HttpOnly', now)).toEqual({
      name: 'sid',
      value: 'abc',
      path: '/app',
      expiresAt: now + 60_000,
      secure: true,
    })
    expect(parsePreviewCookie('sid=abc', now)).toEqual({
      name: 'sid',
      value: 'abc',
      path: '/',
      secure: false,
    })
  })

  it('prefers Max-Age over Expires and keeps the default path', () => {
    const now = 1_000_000
    const cookie = parsePreviewCookie('a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Max-Age=5', now)
    expect(cookie?.expiresAt).toBe(now + 5_000)
    expect(cookie?.path).toBe('/')
  })

  it('rejects values without a usable name/value pair', () => {
    for (const value of ['', 'novalue', '=abc', 'bad name=1']) {
      expect(parsePreviewCookie(value)).toBeUndefined()
    }
  })
})

describe('relayedPreviewCookie', () => {
  it('drops host and transport scope that a loopback http frame cannot honour', () => {
    expect(relayedPreviewCookie('sid=abc; Domain=127.0.0.1; Path=/; Secure; HttpOnly; SameSite=Lax'))
      .toBe('sid=abc; Path=/; HttpOnly; SameSite=Lax')
    expect(relayedPreviewCookie('sid=abc')).toBe('sid=abc')
    expect(relayedPreviewCookie('=broken')).toBeUndefined()
  })
})

describe('cookiePathMatches', () => {
  it('matches on path boundaries only', () => {
    expect(cookiePathMatches('/', '/anything')).toBe(true)
    expect(cookiePathMatches('/app', '/app')).toBe(true)
    expect(cookiePathMatches('/app', '/app/deep')).toBe(true)
    expect(cookiePathMatches('/app/', '/app/deep')).toBe(true)
    expect(cookiePathMatches('/app', '/application')).toBe(false)
    expect(cookiePathMatches('/app', '/other')).toBe(false)
  })
})

describe('PreviewCookieJar', () => {
  it('replays one target Origin cookies and never crosses Origins', () => {
    const jar = new PreviewCookieJar()
    jar.store('http://127.0.0.1:1280', ['sid=one; Path=/'])
    expect(jar.headerFor('http://127.0.0.1:1280', 'http://127.0.0.1:1280/app', undefined))
      .toBe('sid=one')
    expect(jar.headerFor('http://127.0.0.1:9999', 'http://127.0.0.1:9999/app', undefined))
      .toBeUndefined()
  })

  it('honours path, secure scope, and expiry', () => {
    const now = 1_000_000
    const jar = new PreviewCookieJar()
    jar.store('https://target.test', [
      'a=1; Path=/app',
      'b=2; Secure',
      'c=3; Max-Age=10',
    ], now)
    expect(jar.headerFor('https://target.test', 'https://target.test/app/page', undefined, now))
      .toBe('a=1; b=2; c=3')
    expect(jar.headerFor('https://target.test', 'https://target.test/other', undefined, now))
      .toBe('b=2; c=3')
    expect(jar.headerFor('https://target.test', 'https://target.test/app', undefined, now + 11_000))
      .toBe('a=1; b=2')
  })

  it('keeps secure cookies away from a plain-http target Origin', () => {
    const now = 1_000_000
    const jar = new PreviewCookieJar()
    jar.store('http://target.test', ['a=1; Path=/', 'b=2; Secure'], now)
    expect(jar.headerFor('http://target.test', 'http://target.test/app', undefined, now)).toBe('a=1')
  })

  it('deletes on an expired set-cookie and replaces by name', () => {
    const now = 1_000_000
    const jar = new PreviewCookieJar()
    jar.store('http://target.test', ['sid=one; Path=/'], now)
    jar.store('http://target.test', ['sid=two; Path=/'], now)
    expect(jar.headerFor('http://target.test', 'http://target.test/', undefined, now)).toBe('sid=two')
    jar.store('http://target.test', ['sid=two; Path=/; Max-Age=0'], now)
    expect(jar.headerFor('http://target.test', 'http://target.test/', undefined, now)).toBeUndefined()
  })

  it('keeps the frame browser value and fills only missing names from the jar', () => {
    const jar = new PreviewCookieJar()
    jar.store('http://target.test', ['sid=server; Path=/', 'extra=jar; Path=/'])
    expect(jar.headerFor('http://target.test', 'http://target.test/', 'sid=frame; csrf=tok'))
      .toBe('sid=frame; csrf=tok; extra=jar')
  })

  it('caps retained cookies per Origin and clears on demand', () => {
    const jar = new PreviewCookieJar()
    jar.store('http://target.test', Array.from(
      { length: MAX_COOKIES_PER_ORIGIN + 5 },
      (_, index) => `c${String(index)}=1`,
    ))
    const header = jar.headerFor('http://target.test', 'http://target.test/', undefined)
    expect(header?.split('; ')).toHaveLength(MAX_COOKIES_PER_ORIGIN)
    jar.clear()
    expect(jar.headerFor('http://target.test', 'http://target.test/', undefined)).toBeUndefined()
  })
})
