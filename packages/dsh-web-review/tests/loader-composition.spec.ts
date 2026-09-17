/**
 * REAL-composition test for the node half (upstream testing rule): a
 * test-only cordis.yml booted through the real Loader + Include mounts the
 * webserver and this package; a local fixture http server stands in for the
 * target; assertions observe the user-visible HTTP surface of the running
 * isolated Preview Origin (rewritten HTML, redirects, stripped headers, byte-safe POST,
 * HEAD, query references and error containment). Module importing is stubbed
 * via the Loader's internal seam
 * (the harness's own webserver suite pattern); everything else — fibers,
 * injects, routes, the HTTP stack — is real.
 */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillService from '@deepseek-ai/dsh-skill'
import { resolveBrowserExecutable } from '../src/cdp-transport.ts'
import * as plugin from '../src/index.ts'
import { PREVIEW_GUIDANCE } from '../src/index.ts'
import { MAX_ANNOTATION_BODY, type AnnotationSnapshot } from '../src/annotation-contract.ts'
import {
  PREVIEW_BROWSER_INPUT_PATH,
  PREVIEW_BROWSER_STREAM_PATH,
  PREVIEW_CLIENT_HEADER,
  PREVIEW_CLIENT_HEADER_VALUE,
  PREVIEW_NAVIGATE_PREFIX,
  PREVIEW_SESSIONS_PATH,
  previewSessionDescriptorOf,
  type PreviewSessionDescriptor,
} from '../src/preview-contract.ts'

const TARGET_HTML = `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>fixture</title>
  <link rel="stylesheet" href="style.css">
</head><body>
  <a href="http://target.test/page2.html">absolute</a>
  <a href="/rooted.html">rooted</a>
  <img src="img.png">
  <form action="http://target.test/submit" method="post"></form>
</body></html>`

let fixture: Server
let fixtureUrl = ''
let context: Context | undefined
let root: string | undefined
let port = 0

beforeAll(async () => {
  fixture = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://target.test')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('content-security-policy', "default-src 'none'")
    res.setHeader('set-cookie', 'preview-secret=must-not-reach-host; Path=/; Domain=target.test; Secure; HttpOnly')
    res.setHeader('clear-site-data', '"cookies"')
    if (url.pathname === '/login' && req.method === 'POST') {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'session=ok; Path=/; HttpOnly; Domain=target.test',
      })
      res.end('{"ok":true}')
      return
    }
    if (url.pathname === '/dashboard') {
      const authed = (req.headers.cookie ?? '').includes('session=ok')
      res.writeHead(authed ? 200 : 401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(authed ? 'dashboard' : 'unauthorized')
      return
    }
    if (url.pathname === '/typed') {
      // This page runs a handler, so it must not inherit the suite's CSP header.
      res.removeHeader('content-security-policy')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>typed:</title></head>'
        + '<body style="margin:0"><input id="field" autofocus style="position:fixed;left:0;top:0;'
        + 'width:600px;height:80px;font-size:32px" '
        + "oninput=\"document.title='typed:'+this.value\"></body></html>")
      return
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/nested/page.html' })
      res.end()
      return
    }
    if (url.pathname === '/remote-redirect') {
      res.writeHead(302, { location: 'https://example.com/' })
      res.end()
      return
    }
    if (url.pathname === '/post-303' && req.method === 'POST') {
      res.writeHead(303, { location: '/query?redirected=yes' })
      res.end()
      return
    }
    if (url.pathname === '/post-307' && req.method === 'POST') {
      res.writeHead(307, { location: '/binary' })
      res.end()
      return
    }
    if (url.pathname === '/nested/page.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head></head><body><img src="asset.png"></body></html>')
      return
    }
    if (url.pathname === '/query') {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-seen-method': req.method ?? '' })
      res.end(url.search)
      return
    }
    if (url.pathname === '/binary' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer | string) => { chunks.push(Buffer.from(chunk)) })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(Buffer.concat(chunks))
      })
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(`posted:${body}`)
      })
      return
    }
    if (url.pathname === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end('export const x = 1;\n')
      return
    }
    if (url.pathname === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' })
      res.end('body { color: rebeccapurple; }\n')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(TARGET_HTML)
  })
  await new Promise<void>((resolve) => { fixture.listen(0, '127.0.0.1', resolve) })
  const address = fixture.address()
  if (address === null || typeof address === 'string') throw new Error('fixture failed to bind')
  fixtureUrl = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    fixture.close((error) => (error === undefined ? resolve() : reject(error)))
  })
})

/** Boot a test cordis.yml (webserver + dsh-web-review) through the real Loader. */
async function loadComposition(pluginConfig?: Record<string, unknown>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-web-review-loader-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  const configPath = join(root, 'cordis.yml')
  const pluginRow = pluginConfig === undefined
    ? ["- name: 'dsh-web-review-test'"]
    : [
      "- name: 'dsh-web-review-test'",
      '  config:',
      ...Object.entries(pluginConfig).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`),
    ]
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    '',
    "- name: '@deepseek-ai/dsh-system-prompt'",
    '',
    "- name: '@deepseek-ai/dsh-skill'",
    '',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    `    distIndex: '${distIndex}'`,
    '',
    ...pluginRow,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-skill', SkillService],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['dsh-web-review-test', plugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  const webServer = context.webServer
  port = webServer.port
  expect(port).toBeGreaterThan(0)
  return context
}

async function createPreview(target: string): Promise<PreviewSessionDescriptor> {
  const hostOrigin = `http://127.0.0.1:${String(port)}`
  const response = await fetch(`${hostOrigin}${PREVIEW_SESSIONS_PATH}`, {
    method: 'POST',
    headers: {
      origin: hostOrigin,
      'content-type': 'application/json',
      [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
    },
    body: JSON.stringify({ target }),
  })
  expect(response.status).toBe(201)
  const descriptor = previewSessionDescriptorOf(await response.json() as unknown)
  if (descriptor === undefined) throw new Error('invalid preview descriptor')
  return descriptor
}

function annotationSnapshot(sessionId = 'session-1', comments = 1): AnnotationSnapshot {
  return {
    sessionId,
    selectedSkills: [],
    page: { url: 'http://localhost:5173/', title: 'Example Domain' },
    comments: Array.from({ length: comments }, (_, index) => ({
      id: `pick-${index + 1}`,
      comment: 'Make this heading smaller.',
      tagName: 'h1',
      role: 'heading',
      label: 'Example Domain',
      cssPath: 'html > body > div > h1',
      fullPath: 'html > body > div > h1',
      stableClasses: [],
      textContent: 'Example Domain',
      inToolChrome: false,
      anchor: null,
      changes: [],
      textChange: null,
      viewport: { width: 597, height: 835 },
    })),
  }
}

function registerStubAgent(rawId = 'session-1'): {
  dispose: () => void
} {
  if (context === undefined) throw new Error('composition is not loaded')
  const id = SessionId(rawId)
  const agent = {
    id,
    session: Session.create(id),
    ctx: new Context(),
  } as unknown as Agent
  return { dispose: context.agents.register(agent) }
}

describe('isolated preview Origin (real Loader + webserver composition)', () => {
  it('registers the reviewed Preview capability guidance', async () => {
    const loaded = await loadComposition()
    const section = (await loaded.systemPrompt.assemble()).sections
      .find(candidate => candidate.name === 'plugin:dsh-web-review-preview')
    expect(section?.text).toBe(PREVIEW_GUIDANCE)
  })

  it('creates a distinct random Origin and injects the bridge before page scripts', async () => {
    await loadComposition()
    const descriptor = await createPreview(fixtureUrl + '/')
    expect(descriptor.frameOrigin).not.toBe(`http://127.0.0.1:${String(port)}`)
    expect(new URL(descriptor.frameOrigin).hostname).toMatch(/^[a-f\d]{32}\.localhost$/u)
    const response = await fetch(descriptor.frameUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('x-frame-options')).toBeNull()
    expect(response.headers.get('content-security-policy'))
      .toBe(`frame-ancestors http://127.0.0.1:${String(port)}`)
    expect(response.headers.get('clear-site-data')).toBeNull()
    // Upstream cookies reach the isolated frame Origin only, without host/transport scope.
    expect(response.headers.getSetCookie())
      .toEqual(['preview-secret=must-not-reach-host; Path=/; HttpOnly'])
    const body = await response.text()
    const baseHref = `${descriptor.frameOrigin}/`
    expect(body).toContain(`<base href="${baseHref}">`)
    expect(body).toContain(`history.replaceState(null,'',"/")`)
    expect(body.indexOf('data-dsh-web-review="location"')).toBeLessThan(body.indexOf('<link'))
    expect(body.indexOf('data-dsh-web-review="config"')).toBeLessThan(body.indexOf('<link'))
    expect(body.indexOf('data-dsh-web-review="bridge"')).toBeLessThan(body.indexOf('<link'))
    expect(body).toContain(`href="${PREVIEW_NAVIGATE_PREFIX}http%3A//target.test/page2.html"`)
    expect(body).toContain('href="/rooted.html"')
    expect(body).toContain('src="img.png"')
    expect(body).toContain(`action="${PREVIEW_NAVIGATE_PREFIX}http%3A//target.test/submit"`)
    const stylesheet = await fetch(new URL('style.css', baseHref))
    expect(stylesheet.status).toBe(200)
    expect(await stylesheet.text()).toBe('body { color: rebeccapurple; }\n')
  })

  it('normalizes the frame address to the target path for framework routers', async () => {
    await loadComposition()
    const descriptor = await createPreview(`${fixtureUrl}/nested/page.html?tab=one#part`)
    const body = await (await fetch(descriptor.frameUrl)).text()
    expect(body).toContain(`history.replaceState(null,'',"/nested/page.html?tab=one#part")`)
    expect(body).toContain(`<base href="${descriptor.frameOrigin}/nested/page.html?tab=one">`)
  })

  it('carries target-Origin cookies so a login-gated page renders after login', async () => {
    await loadComposition()
    const descriptor = await createPreview(`${fixtureUrl}/dashboard`)
    expect((await fetch(descriptor.frameUrl)).status).toBe(401)

    const login = await fetch(`${descriptor.frameOrigin}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=admin&password=secret',
    })
    expect(login.status).toBe(200)
    expect(login.headers.getSetCookie()).toEqual(['session=ok; Path=/; HttpOnly'])

    const authed = await fetch(descriptor.frameUrl)
    expect(authed.status).toBe(200)
    expect(await authed.text()).toBe('dashboard')
  })

  it('leaves target cookies out of the transport when the deployment disables them', async () => {
    await loadComposition({ previewCookies: false })
    const descriptor = await createPreview(`${fixtureUrl}/dashboard`)
    const login = await fetch(`${descriptor.frameOrigin}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'user=admin&password=secret',
    })
    expect(login.status).toBe(200)
    expect(login.headers.getSetCookie()).toEqual([])
    expect((await fetch(descriptor.frameUrl)).status).toBe(401)
  })

  it('passes non-HTML through unchanged', async () => {
    await loadComposition()
    const response = await fetch((await createPreview(fixtureUrl + '/app.js')).frameUrl)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(await response.text()).toBe('export const x = 1;\n')
  })

  it('forwards POST bodies (rewritten form actions)', async () => {
    await loadComposition()
    const response = await fetch((await createPreview(fixtureUrl + '/submit')).frameUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=2',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('posted:a=1&b=2')
  })

  it('forwards binary POST bodies without text transcoding', async () => {
    await loadComposition()
    const bytes = Uint8Array.from([0, 255, 128, 13, 10, 1])
    const response = await fetch((await createPreview(fixtureUrl + '/binary')).frameUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  it('uses the final redirect URL as the document base', async () => {
    await loadComposition()
    const descriptor = await createPreview(fixtureUrl + '/redirect')
    const response = await fetch(descriptor.frameUrl)
    const body = await response.text()
    expect(body).toContain(`<base href="${descriptor.frameOrigin}/nested/page.html">`)
    expect(body).toContain(`history.replaceState(null,'',"/nested/page.html")`)
    expect(body).toContain('src="asset.png"')
  })

  it('matches Fetch POST redirect semantics for 303 and 307', async () => {
    await loadComposition()
    const converted = await fetch((await createPreview(fixtureUrl + '/post-303')).frameUrl, {
      method: 'POST', body: 'discarded', headers: { 'content-type': 'text/plain' },
    })
    expect(converted.headers.get('x-seen-method')).toBe('GET')
    expect(await converted.text()).toBe('?redirected=yes')

    const bytes = Uint8Array.from([0, 255, 7])
    const preserved = await fetch((await createPreview(fixtureUrl + '/post-307')).frameUrl, {
      method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' },
    })
    expect(new Uint8Array(await preserved.arrayBuffer())).toEqual(bytes)
  })

  it('promotes query-only proxy references into the encoded target URL', async () => {
    await loadComposition()
    const response = await fetch(
      `${(await createPreview(fixtureUrl + '/query?old=1')).frameUrl}?new=2&next=yes`,
    )
    expect(await response.text()).toBe('?new=2&next=yes')
  })

  it('forwards HEAD as HEAD and returns no response body', async () => {
    await loadComposition()
    const response = await fetch((await createPreview(fixtureUrl + '/query')).frameUrl, {
      method: 'HEAD',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-seen-method')).toBe('HEAD')
    expect(await response.text()).toBe('')
  })

  it('requires the same-origin JSON control request and rejects malformed targets', async () => {
    await loadComposition()
    const hostOrigin = `http://127.0.0.1:${String(port)}`
    const missingHeader = await fetch(`${hostOrigin}${PREVIEW_SESSIONS_PATH}`, {
      method: 'POST', headers: { origin: hostOrigin, 'content-type': 'application/json' }, body: '{}',
    })
    expect(missingHeader.status).toBe(415)
    const invalid = await fetch(`${hostOrigin}${PREVIEW_SESSIONS_PATH}`, {
      method: 'POST',
      headers: { origin: hostOrigin, 'content-type': 'application/json', [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE },
      body: JSON.stringify({ target: 'file:///etc/passwd' }),
    })
    expect(invalid.status).toBe(400)
    const foreignOrigin = await fetch(`${hostOrigin}${PREVIEW_SESSIONS_PATH}`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example',
        'content-type': 'application/json',
        [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
      },
      body: JSON.stringify({ target: fixtureUrl }),
    })
    expect(foreignOrigin.status).toBe(403)
  })

  it('returns 502 for unreachable targets and rejects unsupported frame methods', async () => {
    await loadComposition()
    const descriptor = await createPreview('http://127.0.0.1:1/')
    const response = await fetch(descriptor.frameUrl)
    expect(response.status).toBe(502)
    const put = await fetch((await createPreview(fixtureUrl + '/')).frameUrl, { method: 'PUT' })
    expect(put.status).toBe(405)
  })

  it('accepts arbitrary HTTP(S) targets and isolates cross-origin redirects with a handoff document', async () => {
    await loadComposition()
    const remote = await createPreview('https://example.com/')
    expect(remote.frameUrl).toContain('/.dsh-web-review/entry/https%3A//example.com/')
    const redirected = await fetch((await createPreview(fixtureUrl + '/remote-redirect')).frameUrl)
    expect(redirected.status).toBe(200)
    const handoff = await redirected.text()
    expect(handoff).toContain('"name":"handoff"')
    expect(handoff).toContain('example.com')

    const source = await createPreview(fixtureUrl + '/')
    const getFormHandoff = await fetch(
      `${source.frameOrigin}${PREVIEW_NAVIGATE_PREFIX}https%3A//example.com/search?q=review`,
    )
    expect(await getFormHandoff.text()).toContain('search%3Fq%3Dreview')
  })

  it('mints unique Origins and revokes a completed navigation chain', async () => {
    await loadComposition()
    const first = await createPreview(fixtureUrl + '/')
    const second = await createPreview(fixtureUrl + '/')
    expect(first.frameOrigin).not.toBe(second.frameOrigin)
    const hostOrigin = `http://127.0.0.1:${String(port)}`
    const released = await fetch(`${hostOrigin}${PREVIEW_SESSIONS_PATH}`, {
      method: 'DELETE',
      headers: {
        origin: hostOrigin,
        'content-type': 'application/json',
        [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
      },
      body: JSON.stringify({ sessionIds: [first.sessionId] }),
    })
    expect(released.status).toBe(204)
    expect((await fetch(first.frameUrl)).status).toBe(404)
    expect((await fetch(second.frameUrl)).status).toBe(200)
  })
})

describe('/webview-annotations (real Loader + webserver composition)', () => {
  it('stores pending context for a live agent without injecting and deduplicates it', async () => {
    await loadComposition()
    registerStubAgent()
    const request = (): Promise<Response> => fetch(`http://127.0.0.1:${port}/webview-annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(annotationSnapshot()),
    })
    const response = await request()
    expect(response.status).toBe(200)
    expect(response.headers.get('x-webview-annotation-result')).toBe('pending')
    const receipt = await response.json() as { kind: string; snapshotId: string }
    expect(receipt).toMatchObject({ kind: 'ready', snapshotId: expect.any(String) })
    const duplicate = await request()
    expect(duplicate.headers.get('x-webview-annotation-result')).toBe('deduplicated')
    expect(await duplicate.json()).toEqual(receipt)
  })

  it('clears pending state without creating a model context', async () => {
    await loadComposition()
    registerStubAgent()
    const post = (body: AnnotationSnapshot): Promise<Response> => fetch(`http://127.0.0.1:${port}/webview-annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const initialEmpty = await post(annotationSnapshot('session-1', 0))
    expect(initialEmpty.headers.get('x-webview-annotation-result')).toBe('initial-empty')
    await post(annotationSnapshot())
    const cleared = await post(annotationSnapshot('session-1', 0))
    expect(cleared.headers.get('x-webview-annotation-result')).toBe('cleared')
  })

  it('requires a live session and releases dedupe state on agent disposal', async () => {
    await loadComposition()
    const body = JSON.stringify(annotationSnapshot())
    const post = (): Promise<Response> => fetch(`http://127.0.0.1:${port}/webview-annotations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
    expect((await post()).status).toBe(404)
    const first = registerStubAgent()
    expect((await post()).status).toBe(200)
    first.dispose()
    const replacement = registerStubAgent()
    expect((await post()).headers.get('x-webview-annotation-result')).toBe('pending')
    replacement.dispose()
  })

  it('rejects malformed/legacy bodies, missing content type and empty sessionId', async () => {
    await loadComposition()
    registerStubAgent()
    const bad = await fetch(`http://127.0.0.1:${port}/webview-annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(bad.status).toBe(400)
    const legacy = await fetch(`http://127.0.0.1:${port}/webview-annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: '', xml: '<annotation/>' }),
    })
    expect(legacy.status).toBe(400)
    const missingType = await fetch(`http://127.0.0.1:${port}/webview-annotations`, {
      method: 'POST', body: JSON.stringify(annotationSnapshot()),
    })
    expect(missingType.status).toBe(415)
  })

  it('rejects oversized bodies with 413', async () => {
    await loadComposition()
    const response = await fetch(`http://127.0.0.1:${port}/webview-annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(MAX_ANNOTATION_BODY + 1),
    })
    expect(response.status).toBe(413)
  })

  it('rejects non-POST methods with 405', async () => {
    await loadComposition()
    const response = await fetch(`http://127.0.0.1:${port}/webview-annotations`)
    expect(response.status).toBe(405)
  })
})

/**
 * Read server-sent events until `done` accepts the collected batch.
 * @param response - the open SSE response.
 * @param done - predicate deciding when enough events arrived.
 * @param timeoutMs - overall deadline.
 */
async function readSseEvents(
  response: Response,
  done: (events: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 45_000,
): Promise<Array<Record<string, unknown>>> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('stream has no body')
  const decoder = new TextDecoder()
  const events: Array<Record<string, unknown>> = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      buffer += decoder.decode(value, { stream: true })
      let separator = buffer.indexOf('\n\n')
      while (separator >= 0) {
        const chunk = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const line = chunk.split('\n').find(candidate => candidate.startsWith('data: '))
        if (line !== undefined) events.push(JSON.parse(line.slice(6)) as Record<string, unknown>)
        separator = buffer.indexOf('\n\n')
      }
      if (done(events)) return events
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  throw new Error(`stream produced ${String(events.length)} events before the deadline`)
}

describe('browser preview transport (real Loader + webserver composition)', () => {
  it.skipIf(resolveBrowserExecutable() === undefined)(
    'streams a real page, forwards input, and releases the session',
    async () => {
      const profileDir = await mkdtemp(join(tmpdir(), 'dsh-web-review-browser-'))
      await loadComposition({ browserProfileDir: profileDir })
      const host = `http://127.0.0.1:${String(port)}`
      const control = (body: unknown): Promise<Response> => fetch(`${host}${PREVIEW_SESSIONS_PATH}`, {
        method: 'POST',
        headers: {
          origin: host,
          'content-type': 'application/json',
          [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
        },
        body: JSON.stringify(body),
      })

      const created = await control({ target: `${fixtureUrl}/`, mode: 'browser' })
      expect(created.status).toBe(201)
      const descriptor = previewSessionDescriptorOf(await created.json() as unknown)
      if (descriptor === undefined) throw new Error('invalid browser descriptor')
      expect(descriptor.mode).toBe('browser')
      expect(descriptor.frameUrl).toBe(`${fixtureUrl}/`)
      expect(descriptor.frameOrigin).toBe(host)

      const stream = await fetch(
        `${host}${PREVIEW_BROWSER_STREAM_PATH}?sessionId=${descriptor.sessionId}&channel=${descriptor.channel}`,
      )
      expect(stream.status).toBe(200)
      expect(stream.headers.get('content-type')).toContain('text/event-stream')
      const events = await readSseEvents(stream, collected => (
        collected.some(event => event.type === 'frame') && collected.some(event => event.type === 'state')
      ))
      const frame = events.find(event => event.type === 'frame')
      expect(String(frame?.data).length).toBeGreaterThan(200)
      expect(Number(frame?.deviceHeight)).toBeGreaterThan(0)

      const input = (body: unknown): Promise<Response> => fetch(`${host}${PREVIEW_BROWSER_INPUT_PATH}`, {
        method: 'POST',
        headers: {
          origin: host,
          'content-type': 'application/json',
          [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
        },
        body: JSON.stringify(body),
      })
      const moved = await input({
        sessionId: descriptor.sessionId,
        channel: descriptor.channel,
        input: { kind: 'mouse', type: 'move', x: 12, y: 24, button: 'left', clickCount: 1, modifiers: 0 },
      })
      expect(moved.status).toBe(200)

      const shot = await input({
        sessionId: descriptor.sessionId,
        channel: descriptor.channel,
        command: { name: 'screenshot' },
      })
      expect(shot.status).toBe(200)
      const captured = await shot.json() as { screenshot?: string }
      // The still is a device-resolution JPEG.
      expect(captured.screenshot?.startsWith('/9j/')).toBe(true)
      expect(jpegSize(String(captured.screenshot))?.width).toBeGreaterThan(0)

      expect((await input({ sessionId: descriptor.sessionId, channel: descriptor.channel })).status).toBe(400)
      expect((await input({
        sessionId: descriptor.sessionId,
        channel: 'f'.repeat(32),
        input: { kind: 'mouse', type: 'move', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0 },
      })).status).toBe(404)

      const released = await fetch(`${host}${PREVIEW_SESSIONS_PATH}`, {
        method: 'DELETE',
        headers: {
          origin: host,
          'content-type': 'application/json',
          [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
        },
        body: JSON.stringify({ sessionIds: [descriptor.sessionId] }),
      })
      expect(released.status).toBe(204)
      expect((await input({
        sessionId: descriptor.sessionId,
        channel: descriptor.channel,
        input: { kind: 'mouse', type: 'move', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0 },
      })).status).toBe(404)
      await rm(profileDir, { recursive: true, force: true })
    },
    90_000,
  )

  it.skipIf(resolveBrowserExecutable() === undefined)(
    'runs the injected bridge in the real page and carries it back over the binding',
    async () => {
      await loadComposition({ browserProfileDir: await mkdtemp(join(tmpdir(), 'dsh-web-review-bridge-')) })
      const host = `http://127.0.0.1:${String(port)}`
      const created = await fetch(`${host}${PREVIEW_SESSIONS_PATH}`, {
        method: 'POST',
        headers: {
          origin: host,
          'content-type': 'application/json',
          [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
        },
        body: JSON.stringify({ target: `${fixtureUrl}/`, mode: 'browser' }),
      })
      const descriptor = previewSessionDescriptorOf(await created.json() as unknown)
      if (descriptor === undefined) throw new Error('invalid browser descriptor')

      // Open the stream first so the binding answer cannot be missed, then ask
      // the page for its ready state through CDP evaluation.
      const stream = await fetch(
        `${host}${PREVIEW_BROWSER_STREAM_PATH}?sessionId=${descriptor.sessionId}&channel=${descriptor.channel}`,
      )
      const probe = await fetch(`${host}${PREVIEW_BROWSER_INPUT_PATH}`, {
        method: 'POST',
        headers: {
          origin: host,
          'content-type': 'application/json',
          [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
        },
        body: JSON.stringify({
          sessionId: descriptor.sessionId,
          channel: descriptor.channel,
          command: {
            name: 'bridge',
            payload: JSON.stringify({
              protocol: 'dsh-web-review/bridge',
              version: 1,
              channel: descriptor.channel,
              direction: 'host-to-frame',
              requestId: 'probe-1',
              command: { name: 'request-ready', payload: null },
            }),
          },
        }),
      })
      expect(probe.status).toBe(200)

      // The bridge answers the probe with a `ready` event and a `null` response.
      const decode = (events: Array<Record<string, unknown>>): Array<Record<string, unknown>> => events
        .filter(event => event.type === 'bridge')
        .map(event => JSON.parse(String(event.payload)) as Record<string, unknown>)
      const events = await readSseEvents(stream, collected => {
        const payloads = decode(collected)
        return payloads.some(payload => payload.requestId === 'probe-1')
          && payloads.some(payload => (payload.event as { name?: string } | undefined)?.name === 'ready')
      })
      const payloads = decode(events)
      const response = payloads.find(payload => payload.requestId === 'probe-1')
      expect((response?.response as { ok?: boolean } | undefined)?.ok).toBe(true)
      const ready = payloads.find(payload => (payload.event as { name?: string } | undefined)?.name === 'ready')
      const readyState = (ready?.event as { payload?: Record<string, unknown> } | undefined)?.payload
      expect(String(readyState?.pageUrl)).toContain(String(new URL(fixtureUrl).port))
      expect(Number((readyState?.viewport as { width?: number } | undefined)?.width)).toBeGreaterThan(0)
    },
    90_000,
  )
})

/** Pixel size of a base64 JPEG, read from its start-of-frame marker. */
function jpegSize(base64: string): { width: number; height: number } | undefined {
  const bytes = Buffer.from(base64, 'base64')
  let index = 2
  while (index + 9 < bytes.length) {
    if (bytes[index] !== 0xff) { index += 1; continue }
    const marker = bytes[index + 1]
    if (marker === undefined) return undefined
    const length = bytes.readUInt16BE(index + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(index + 5), width: bytes.readUInt16BE(index + 7) }
    }
    index += 2 + length
  }
  return undefined
}

describe('browser preview input and frame resolution', () => {
  const control = (host: string, body: unknown): Promise<Response> => fetch(
    `${host}${PREVIEW_BROWSER_INPUT_PATH}`,
    {
      method: 'POST',
      headers: {
        origin: host,
        'content-type': 'application/json',
        [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
      },
      body: JSON.stringify(body),
    },
  )

  const createBrowserSession = async (target: string): Promise<{
    host: string
    descriptor: PreviewSessionDescriptor
  }> => {
    const host = `http://127.0.0.1:${String(port)}`
    const created = await fetch(`${host}${PREVIEW_SESSIONS_PATH}`, {
      method: 'POST',
      headers: {
        origin: host,
        'content-type': 'application/json',
        [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
      },
      body: JSON.stringify({ target, mode: 'browser' }),
    })
    expect(created.status).toBe(201)
    const descriptor = previewSessionDescriptorOf(await created.json() as unknown)
    if (descriptor === undefined) throw new Error('invalid browser descriptor')
    return { host, descriptor }
  }

  it.skipIf(resolveBrowserExecutable() === undefined)(
    'focuses a page control and types into it',
    async () => {
      await loadComposition({ browserProfileDir: await mkdtemp(join(tmpdir(), 'dsh-web-review-typing-')) })
      const { host, descriptor } = await createBrowserSession(`${fixtureUrl}/typed`)
      const session = { sessionId: descriptor.sessionId, channel: descriptor.channel }
      const stream = await fetch(
        `${host}${PREVIEW_BROWSER_STREAM_PATH}?sessionId=${descriptor.sessionId}&channel=${descriptor.channel}`,
      )

      // Press the control, then type: pointer input must give the page's control
      // focus and key events must reach it as text.
      expect((await control(host, {
        ...session,
        input: { kind: 'mouse', type: 'down', x: 40, y: 40, button: 'left', clickCount: 1, modifiers: 0 },
      })).status).toBe(200)
      await control(host, {
        ...session,
        input: { kind: 'mouse', type: 'up', x: 40, y: 40, button: 'left', clickCount: 1, modifiers: 0 },
      })
      for (const [key, code, virtual] of [['a', 'KeyA', 65], ['b', 'KeyB', 66]] as const) {
        await control(host, {
          ...session,
          input: { kind: 'key', type: 'down', key, code, text: key, windowsVirtualKeyCode: virtual, modifiers: 0 },
        })
      }
      await control(host, {
        ...session,
        command: {
          name: 'bridge',
          payload: JSON.stringify({
            protocol: 'dsh-web-review/bridge',
            version: 1,
            channel: descriptor.channel,
            direction: 'host-to-frame',
            requestId: 'probe-typed',
            command: { name: 'request-ready', payload: null },
          }),
        },
      })

      const events = await readSseEvents(stream, collected => collected.some((event) => {
        if (event.type !== 'bridge') return false
        return String(event.payload).includes('typed:ab')
      }))
      const ready = events
        .filter(event => event.type === 'bridge')
        .map(event => JSON.parse(String(event.payload)) as { event?: { name?: string; payload?: { title?: string } } })
        .find(payload => payload.event?.name === 'ready')
      expect(ready?.event?.payload?.title).toBe('typed:ab')
    },
    90_000,
  )

  it.skipIf(resolveBrowserExecutable() === undefined)(
    'captures frames at device resolution instead of CSS size',
    async () => {
      await loadComposition({ browserProfileDir: await mkdtemp(join(tmpdir(), 'dsh-web-review-scale-')) })
      const { host, descriptor } = await createBrowserSession(`${fixtureUrl}/typed`)
      expect((await control(host, {
        sessionId: descriptor.sessionId,
        channel: descriptor.channel,
        input: { kind: 'viewport', width: 800, height: 600, deviceScaleFactor: 2 },
      })).status).toBe(200)

      const stream = await fetch(
        `${host}${PREVIEW_BROWSER_STREAM_PATH}?sessionId=${descriptor.sessionId}&channel=${descriptor.channel}`,
      )
      const events = await readSseEvents(stream, collected => collected.some(event => event.type === 'frame'))
      const frame = events.find(event => event.type === 'frame')
      // The motion stream is CSS-sized; the idle still is device-resolution.
      expect(jpegSize(String(frame?.data))?.width).toBeLessThanOrEqual(800)
      expect(Number(frame?.deviceWidth)).toBe(800)
      const still = await control(host, { sessionId: descriptor.sessionId, channel: descriptor.channel, command: { name: 'screenshot' } })
      const stillBody = await still.json() as { screenshot?: string }
      expect(jpegSize(String(stillBody.screenshot))?.width).toBeGreaterThan(1_200)
    },
    90_000,
  )
})

describe('native panel transport (fake shell + real composition)', () => {
  interface ShellCall { path: string; body: Record<string, unknown> }

  /** Stand-in for the desktop shell's loopback control API. */
  const startFakeShell = async (): Promise<{ port: number; calls: ShellCall[]; close: () => Promise<void> }> => {
    const calls: ShellCall[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: Record<string, unknown> = {}
        try { body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown> } catch { /* ignore */ }
        const path = (req.url ?? '').split('?')[0] ?? ''
        if (path === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, product: 'fake-shell', version: 'test' }))
          return
        }
        calls.push({ path, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fake shell failed to bind')
    return {
      port: address.port,
      calls,
      close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
    }
  }

  const withHome = async <T,>(home: string, body: () => Promise<T>): Promise<T> => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      return await body()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }

  const post = (host: string, body: unknown): Promise<Response> => fetch(`${host}${PREVIEW_BROWSER_INPUT_PATH}`, {
    method: 'POST',
    headers: {
      origin: host,
      'content-type': 'application/json',
      [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
    },
    body: JSON.stringify(body),
  })

  it('drives the shell panel and carries page events back over the stream', async () => {
    const shell = await startFakeShell()
    const home = await mkdtemp(join(tmpdir(), 'dsh-web-review-native-'))
    await mkdir(join(home, 'web-review'), { recursive: true })
    await writeFile(
      join(home, 'web-review', 'native-browser.json'),
      JSON.stringify({ schema: 1, port: shell.port, capabilities: ['browser-panel'], version: 'test' }),
    )
    try {
      await withHome(home, async () => {
        await loadComposition()
        const host = `http://127.0.0.1:${String(port)}`
        const created = await fetch(`${host}${PREVIEW_SESSIONS_PATH}`, {
          method: 'POST',
          headers: {
            origin: host,
            'content-type': 'application/json',
            [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
          },
          body: JSON.stringify({ target: `${fixtureUrl}/`, mode: 'native' }),
        })
        expect(created.status).toBe(201)
        const descriptor = previewSessionDescriptorOf(await created.json() as unknown)
        if (descriptor === undefined) throw new Error('invalid native descriptor')
        expect(descriptor.mode).toBe('native')
        // Registering a session alone must not open a panel.
        expect(shell.calls).toHaveLength(0)

        const stream = await fetch(
          `${host}${PREVIEW_BROWSER_STREAM_PATH}?sessionId=${descriptor.sessionId}&channel=${descriptor.channel}`,
        )
        const session = { sessionId: descriptor.sessionId, channel: descriptor.channel }

        // The first visible rectangle is what opens the panel.
        expect((await post(host, {
          ...session,
          input: { kind: 'bounds', x: 10, y: 20, width: 800, height: 600, visible: true },
        })).status).toBe(200)
        const opened = shell.calls.find(call => call.path === '/panel/open')
        expect(opened?.body.url).toBe(`${fixtureUrl}/`)
        expect(Number(opened?.body.width)).toBe(800)
        const bootstrap = String(opened?.body.bootstrap)
        expect(bootstrap).toContain('__DSH_WEB_REVIEW_BRIDGE_CONFIG__')
        // The config names the native transport the bridge artifact selects.
        expect(bootstrap).toContain('"native":{"endpoint":"http://127.0.0.1:')
        // A secure page may not request that endpoint, so the bootstrap also
        // names the shell's script message handler, the channel that works.
        expect(bootstrap).toContain('window.__DSH_WEB_REVIEW_NATIVE_IPC__="dshWebReview"')
        expect(bootstrap).toContain('window.webkit&&window.webkit.messageHandlers')

        // The bootstrap names the loopback endpoint the page reports to.
        const endpoint = /http:\/\/127\.0\.0\.1:\d+\/native-event\?sessionId=[a-f\d]{32}&channel=[a-f\d]{32}/u.exec(bootstrap)?.[0]
        if (endpoint === undefined) throw new Error('bootstrap has no native endpoint')
        // The shell relays the page's script messages to that same endpoint.
        expect(opened?.body.endpoint).toBe(endpoint)

        // The shell only moves the panel after it exists.
        await post(host, { ...session, input: { kind: 'bounds', x: 11, y: 21, width: 801, height: 601, visible: true } })
        expect(shell.calls.some(call => call.path === '/panel/bounds')).toBe(true)
        await post(host, { ...session, input: { kind: 'bounds', x: 11, y: 21, width: 801, height: 601, visible: false } })
        const hidden = shell.calls.filter(call => call.path === '/panel/bounds').at(-1)
        expect(hidden?.body.visible).toBe(false)

        // A page inside the panel reports over its own loopback endpoint.
        const bridgeMessage = JSON.stringify({ channel: descriptor.channel, event: { name: 'ready', payload: null } })
        expect((await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ type: 'bridge', payload: bridgeMessage }),
        })).status).toBe(204)
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ type: 'state', url: `${fixtureUrl}/typed`, title: '来自面板', loading: false }),
        })
        // The bridge artifact posts its own message shape (not the envelope) when
        // the native sink is its transport; the same stream must carry it.
        const rawBridge = JSON.stringify({
          protocol: 'dsh-web-review/bridge',
          version: 1,
          channel: descriptor.channel,
          direction: 'frame-to-host',
          requestId: 'raw-1',
          response: { ok: true, value: null },
        })
        expect((await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: rawBridge,
        })).status).toBe(204)
        const events = await readSseEvents(stream, collected => (
          collected.some(event => event.type === 'bridge' && String(event.payload) === bridgeMessage)
          && collected.some(event => String(event.payload).includes('"requestId":"raw-1"'))
          && collected.some(event => event.type === 'state' && event.title === '来自面板')
        ))
        expect(events.some(event => event.payload === bridgeMessage)).toBe(true)
        expect(events.some(event => String(event.payload).includes('"requestId":"raw-1"'))).toBe(true)
        // The stream opens with the session's own state; the page's report follows.
        expect(events.filter(event => event.type === 'state').map(event => event.url))
          .toEqual([`${fixtureUrl}/`, `${fixtureUrl}/typed`])

        // Host commands reach the panel through the shell's eval path.
        expect((await post(host, {
          ...session,
          command: { name: 'bridge', payload: bridgeMessage },
        })).status).toBe(200)
        const evalCall = shell.calls.filter(call => call.path === '/panel/command').at(-1)
        expect(evalCall?.body.kind).toBe('eval')
        expect(String(evalCall?.body.script)).toContain('__dshWebReviewReceive')

        expect((await post(host, { ...session, command: { name: 'close' } })).status).toBe(200)
        expect(shell.calls.filter(call => call.path === '/panel/command').at(-1)?.body.kind).toBe('close')
      })
    } finally {
      await shell.close()
      await rm(home, { recursive: true, force: true })
    }
  }, 60_000)

  it('refuses a stale descriptor whose shell is gone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-web-review-stale-'))
    await mkdir(join(home, 'web-review'), { recursive: true })
    // Port 1 is reserved and never answers a health probe.
    await writeFile(
      join(home, 'web-review', 'native-browser.json'),
      JSON.stringify({ schema: 1, port: 1, capabilities: ['browser-panel'] }),
    )
    try {
      await withHome(home, async () => {
        await loadComposition()
        const host = `http://127.0.0.1:${String(port)}`
        const created = await fetch(`${host}${PREVIEW_SESSIONS_PATH}`, {
          method: 'POST',
          headers: {
            origin: host,
            'content-type': 'application/json',
            [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
          },
          body: JSON.stringify({ target: `${fixtureUrl}/`, mode: 'native' }),
        })
        expect(created.status).toBe(503)
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)
})
