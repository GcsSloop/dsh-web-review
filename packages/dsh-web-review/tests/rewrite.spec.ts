/** Pure-function suite for the isolated Preview rewrite boundary. */
import { describe, expect, it } from 'vitest'
import {
  decodeTarget,
  encodeTarget,
  isHttpUrl,
  isPreviewableUrl,
  proxyUrl,
} from '../src/proxy-url.ts'
import { rewriteIsolatedHtml } from '../src/rewrite.ts'
import {
  PREVIEW_BRIDGE_PATH,
  PREVIEW_NAVIGATE_PREFIX,
  type PreviewChannel,
} from '../src/preview-contract.ts'

const BASE = 'http://localhost:5173/app/page.html'
const FRAME_ORIGIN = `http://${'b'.repeat(32)}.localhost:43123`
const options = {
  frameOrigin: FRAME_ORIGIN,
  navigatePrefix: PREVIEW_NAVIGATE_PREFIX,
  bridgePath: PREVIEW_BRIDGE_PATH,
  channel: 'a'.repeat(32) as PreviewChannel,
  parentOrigin: 'http://127.0.0.1:3090',
}

describe('isolated preview URL codec', () => {
  it('round-trips a full URL while keeping slashes path-safe', () => {
    const url = 'https://example.com/a/b?x=1&y=%20#frag'
    expect(decodeTarget(encodeTarget(url))).toBe(url)
    expect(encodeTarget(url)).not.toContain('%2F')
    expect(encodeTarget(url)).not.toContain('?')
  })

  it('joins prefixes with exactly one separator', () => {
    const encoded = 'https%3A//example.com/a'
    expect(proxyUrl('https://example.com/a', '/preview')).toBe(`/preview/${encoded}`)
    expect(proxyUrl('https://example.com/a', '/preview/')).toBe(`/preview/${encoded}`)
  })

  it('accepts credential-free public, LAN, and loopback HTTP(S) targets only', () => {
    for (const url of [
      'https://example.com/',
      'http://192.168.1.20/',
      'http://localhost:5173/',
      'http://127.0.0.1:3000/',
    ]) expect(isPreviewableUrl(url)).toBe(true)
    for (const url of [
      'ftp://example.com/',
      'file:///tmp/page.html',
      'http://user:password@example.com/',
      '/relative',
    ]) expect(isPreviewableUrl(url)).toBe(false)
    expect(isHttpUrl('https://example.com/')).toBe(true)
    expect(isHttpUrl('javascript:void(0)')).toBe(false)
  })
})

describe('rewriteIsolatedHtml', () => {
  it('normalizes the frame address to the target path before page scripts', () => {
    const out = rewriteIsolatedHtml('<head><script src="app.js"></script></head>', BASE, options)
    expect(out).toMatch(/<head><base [^>]+><script data-dsh-web-review="location">/u)
    expect(out).toMatch(/data-dsh-web-review="location">[^<]*<\/script><script data-dsh-web-review="config">/u)
    expect(out.indexOf('data-dsh-web-review="location"')).toBeLessThan(out.indexOf('src="app.js"'))
    expect(out.indexOf('data-dsh-web-review="config"')).toBeLessThan(out.indexOf('src="app.js"'))
    expect(out.indexOf('data-dsh-web-review="bridge"')).toBeLessThan(out.indexOf('src="app.js"'))
    expect(out).toContain('http://127.0.0.1:3090')
    expect(out).toContain('a'.repeat(32))
    expect(out).toContain('history.replaceState(null,\'\',"/app/page.html")')
    expect(out).not.toContain('/webview-proxy')

    const base = /<base href="([^"]+)"/u.exec(out)?.[1]
    expect(base).toBe(`${FRAME_ORIGIN}/app/page.html`)
  })

  it('carries the target search and hash into the normalized address', () => {
    const out = rewriteIsolatedHtml(
      '<head></head>',
      'http://localhost:5173/app/page.html?tab=one#part',
      options,
    )
    expect(out).toContain('history.replaceState(null,\'\',"/app/page.html?tab=one#part")')
    const base = /<base href="([^"]+)"/u.exec(out)?.[1]
    expect(base).toBe(`${FRAME_ORIGIN}/app/page.html?tab=one`)
  })

  it('keeps root-relative resources native and moves absolute same-target URLs onto the frame Origin', () => {
    const out = rewriteIsolatedHtml([
      '<a href="/next">rooted</a>',
      '<a href="http://localhost:5173/absolute">absolute</a>',
      '<a href="//localhost:5173/protocol-relative">protocol relative</a>',
      '<a href="https://other.example/page">other</a>',
      '<form action="https://form.example/submit"></form>',
      '<script src="https://cdn.example/app.js"></script>',
    ].join(''), BASE, options)
    expect(out).toContain('href="/next"')
    expect(out).toContain(`href="${FRAME_ORIGIN}/absolute"`)
    expect(out).toContain(`href="${FRAME_ORIGIN}/protocol-relative"`)
    expect(out).toContain(`href="${PREVIEW_NAVIGATE_PREFIX}https%3A//other.example/page"`)
    expect(out).toContain(`action="${PREVIEW_NAVIGATE_PREFIX}https%3A//form.example/submit"`)
    expect(out).toContain('src="https://cdn.example/app.js"')
  })

  it('leaves plain-relative, query, fragment, and non-network values for native resolution', () => {
    const out = rewriteIsolatedHtml([
      '<img src="asset.png">',
      '<a href="?tab=one">query</a>',
      '<a href="#part">fragment</a>',
      '<a href="mailto:user@example.com">mail</a>',
      '<img src="data:image/png;base64,AAAA">',
    ].join(''), BASE, options)
    expect(out).toContain('src="asset.png"')
    expect(out).toContain('href="?tab=one"')
    expect(out).toContain('href="#part"')
    expect(out).toContain('href="mailto:user@example.com"')
    expect(out).toContain('src="data:image/png;base64,AAAA"')
  })

  it('rewrites absolute same-Origin srcset candidates while preserving descriptors and remote CORS', () => {
    const out = rewriteIsolatedHtml(
      `<img srcset="http://localhost:5173/a.png 1x, /b.png 2x, https://cdn.example/c.png 3x">`,
      BASE,
      options,
    )
    expect(out).toContain(`${FRAME_ORIGIN}/a.png 1x`)
    expect(out).toContain('/b.png 2x')
    expect(out).toContain('https://cdn.example/c.png 3x')
  })

  it('removes page CSP/refresh directives without rewriting script text or comments', () => {
    const script = `const markup = '<img src="/asset.png">'`
    const comment = '<!-- <a href="/not-a-link">comment</a> -->'
    const out = rewriteIsolatedHtml([
      '<head>',
      '<meta http-equiv="Content-Security-Policy" content="default-src none">',
      '<meta HTTP-EQUIV="content-security-policy-report-only" content="report-uri /csp">',
      '<meta http-equiv="refresh" content="0;url=https://example.com/">',
      '<meta name="viewport" content="width=device-width">',
      `<script>${script}</script>${comment}`,
      '</head>',
    ].join(''), BASE, options)
    expect(out).not.toContain('Content-Security-Policy')
    expect(out).not.toContain('content-security-policy-report-only')
    expect(out).not.toContain('http-equiv="refresh"')
    expect(out).toContain('name="viewport"')
    expect(out).toContain(`<script>${script}</script>`)
    expect(out).toContain(comment)
  })
})
