/**
 * Target-origin cookie handling for the isolated preview transport.
 *
 * The preview Origin (`<session>.localhost:<port>`) never shares the DSH host
 * Origin, so target cookies cannot collide with DSH credentials. Cookies are
 * captured per bound target Origin, replayed upstream, and relayed to the frame
 * browser without the host/transport scope that a loopback `http` preview Origin
 * cannot honour.
 */

/** One cookie bound to a single target Origin. */
export interface PreviewCookie {
  name: string
  value: string
  path: string
  expiresAt?: number
  secure: boolean
}

/** Longest accepted upstream `set-cookie` value. */
export const MAX_SET_COOKIE_BYTES = 4_096
/** Most cookies retained for one target Origin. */
export const MAX_COOKIES_PER_ORIGIN = 128

function attributeList(value: string): Array<{ name: string; raw: string }> {
  return value.split(';').slice(1).map((part) => {
    const trimmed = part.trim()
    const separator = trimmed.indexOf('=')
    return {
      name: (separator < 0 ? trimmed : trimmed.slice(0, separator)).trim().toLowerCase(),
      raw: trimmed,
    }
  })
}

/**
 * Parse one upstream `set-cookie` value.
 * @param value - the raw header value.
 * @param now - clock used to resolve Max-Age/Expires into an absolute deadline.
 * @returns the storable cookie, or undefined when the value is unusable.
 */
export function parsePreviewCookie(value: string, now = Date.now()): PreviewCookie | undefined {
  if (value.length > MAX_SET_COOKIE_BYTES) return undefined
  const pair = value.split(';', 1)[0]?.trim() ?? ''
  const separator = pair.indexOf('=')
  if (separator <= 0) return undefined
  const name = pair.slice(0, separator).trim()
  const cookieValue = pair.slice(separator + 1).trim()
  if (name === '' || /[^\x21-\x7e]/u.test(name)) return undefined
  let path = '/'
  let secure = false
  let maxAge: number | undefined
  let expires: number | undefined
  for (const attribute of attributeList(value)) {
    if (attribute.name === 'path') {
      const raw = attribute.raw.slice(attribute.raw.indexOf('=') + 1).trim()
      if (raw.startsWith('/')) path = raw
    } else if (attribute.name === 'max-age') {
      const seconds = Number(attribute.raw.slice(attribute.raw.indexOf('=') + 1).trim())
      if (Number.isFinite(seconds)) maxAge = now + seconds * 1_000
    } else if (attribute.name === 'expires') {
      const parsed = Date.parse(attribute.raw.slice(attribute.raw.indexOf('=') + 1).trim())
      if (Number.isFinite(parsed)) expires = parsed
    } else if (attribute.name === 'secure') {
      secure = true
    }
  }
  const expiresAt = maxAge ?? expires
  return {
    name,
    value: cookieValue,
    path,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    secure,
  }
}

/**
 * Rewrite one upstream `set-cookie` for the frame browser: `Domain` and
 * `Secure` cannot apply to the loopback `http` preview Origin, while the
 * remaining attributes keep their meaning.
 * @param value - the raw upstream header value.
 * @returns the relayable header value, or undefined when it is unusable.
 */
export function relayedPreviewCookie(value: string): string | undefined {
  if (value.length > MAX_SET_COOKIE_BYTES) return undefined
  const parsed = parsePreviewCookie(value)
  if (parsed === undefined) return undefined
  const kept = attributeList(value)
    .filter(attribute => attribute.name !== 'domain' && attribute.name !== 'secure' && attribute.name !== '')
    .map(attribute => attribute.raw)
  return [`${parsed.name}=${parsed.value}`, ...kept].join('; ')
}

/** Cookie path-matching per RFC 6265 §5.1.4, minus the default-path derivation. */
export function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === '/' || cookiePath === '') return true
  if (!requestPath.startsWith(cookiePath)) return false
  const boundary = requestPath[cookiePath.length]
  return cookiePath.endsWith('/') || boundary === undefined || boundary === '/'
}

/**
 * In-memory cookie store keyed by target Origin. One DSH process keeps one jar,
 * so a login performed in any preview session serves later sessions for the same
 * target Origin; a revoked or expired session never carries cookies to another
 * Origin.
 */
export class PreviewCookieJar {
  private readonly origins = new Map<string, Map<string, PreviewCookie>>()

  /**
   * Record the `set-cookie` values of one upstream response.
   * @param origin - the bound target Origin that produced them.
   * @param values - raw `set-cookie` header values.
   * @param now - clock used for expiry decisions.
   */
  store(origin: string, values: readonly string[], now = Date.now()): void {
    if (values.length === 0) return
    const store = this.origins.get(origin) ?? new Map<string, PreviewCookie>()
    for (const value of values) {
      const cookie = parsePreviewCookie(value, now)
      if (cookie === undefined) continue
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) store.delete(cookie.name)
      else if (store.has(cookie.name) || store.size < MAX_COOKIES_PER_ORIGIN) store.set(cookie.name, cookie)
    }
    if (store.size === 0) this.origins.delete(origin)
    else this.origins.set(origin, store)
  }

  /**
   * Build the upstream `Cookie` header for one request.
   * @param origin - the bound target Origin.
   * @param target - the absolute upstream URL of this hop.
   * @param frameCookie - the frame browser's own `Cookie` header, when present.
   * @param now - clock used for expiry decisions.
   * @returns the header value, or undefined when no cookie applies.
   */
  headerFor(
    origin: string,
    target: string,
    frameCookie: string | undefined,
    now = Date.now(),
  ): string | undefined {
    const url = new URL(target)
    const framePairs = (frameCookie ?? '').split(';')
      .map(pair => pair.trim())
      .filter((pair) => {
        const separator = pair.indexOf('=')
        return separator > 0
      })
    const frameNames = new Set(framePairs.map(pair => pair.slice(0, pair.indexOf('=')).trim()))
    const stored = [...(this.origins.get(origin)?.values() ?? [])]
      .filter(cookie => (cookie.expiresAt === undefined || cookie.expiresAt > now)
        && (!cookie.secure || url.protocol === 'https:')
        && cookiePathMatches(cookie.path, url.pathname))
      .filter(cookie => !frameNames.has(cookie.name))
      .map(cookie => `${cookie.name}=${cookie.value}`)
    const pairs = [...framePairs, ...stored]
    return pairs.length === 0 ? undefined : pairs.join('; ')
  }

  /** Drop every stored cookie. */
  clear(): void {
    this.origins.clear()
  }
}
