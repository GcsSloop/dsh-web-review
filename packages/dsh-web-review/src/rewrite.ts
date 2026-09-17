/** Pure HTML rewriting for one capability-scoped isolated Preview Origin. */
import {
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes,
} from 'parse5'
import type { PreviewChannel } from './preview-contract.ts'
import { isHttpUrl, proxyUrl } from './proxy-url.ts'

/** Attribute names whose URL values are rewritten (srcset handled separately). */
const URL_ATTRS = new Set(['href', 'src', 'action', 'poster', 'data-src'])

type Node = DefaultTreeAdapterTypes.Node
type ParentNode = DefaultTreeAdapterTypes.ParentNode
type Element = DefaultTreeAdapterTypes.Element

function isElement(node: Node): node is Element {
  return 'tagName' in node && Array.isArray(node.attrs)
}

function isRemovedMetaDirective(node: Node): boolean {
  if (!isElement(node) || node.tagName !== 'meta') return false
  const httpEquiv = node.attrs.find(attribute => attribute.name === 'http-equiv')?.value.trim().toLowerCase()
  return httpEquiv === 'content-security-policy'
    || httpEquiv === 'content-security-policy-report-only'
    || httpEquiv === 'refresh'
}

/** Paths and routing identity owned by one isolated preview origin. */
export interface IsolatedRewriteOptions {
  /** Absolute origin the frame is served from, e.g. `http://<session>.localhost:<port>`. */
  frameOrigin: string
  navigatePrefix: string
  bridgePath: string
  channel: PreviewChannel
  parentOrigin: string
}

/**
 * Rewrite one URL attribute value for the isolated Origin.
 *
 * Root-relative values resolve natively against the preview Origin and stay
 * untouched, so page-visible paths and framework routers keep the target's own
 * paths. Absolute same-target values must move onto the preview Origin, and
 * cross-Origin navigation goes through the handoff route; cross-Origin
 * subresources keep their browser-native CORS behavior.
 */
function isolatedUrlValue(
  value: string,
  base: string,
  attribute: string,
  options: IsolatedRewriteOptions,
): string {
  if (value === '') return value
  const candidate = value.trim()
  const protocolRelative = candidate.startsWith('//')
  if (!protocolRelative && !candidate.startsWith('/') && !isHttpUrl(candidate)) return value
  if (!protocolRelative && !isHttpUrl(candidate)) return value
  try {
    const resolved = new URL(candidate, base)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return value
    if (resolved.origin === new URL(base).origin) {
      return new URL(`${resolved.pathname}${resolved.search}${resolved.hash}`, options.frameOrigin).href
    }
    return attribute === 'href' || attribute === 'action'
      ? proxyUrl(resolved.href, options.navigatePrefix)
      : value
  } catch {
    return value
  }
}

function isolatedSrcset(value: string, base: string, options: IsolatedRewriteOptions): string {
  if (value.trim().startsWith('data:')) return value
  return value.split(',').map((part) => {
    const trimmed = part.trim()
    if (trimmed === '') return part
    const [url, ...descriptors] = trimmed.split(/\s+/u)
    const rewritten = url === undefined ? trimmed : isolatedUrlValue(url, base, 'srcset', options)
    return descriptors.length === 0 ? rewritten : `${rewritten} ${descriptors.join(' ')}`
  }).join(', ')
}

function rewriteIsolatedElement(element: Element, base: string, options: IsolatedRewriteOptions): void {
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase()
    if (name === 'srcset') attribute.value = isolatedSrcset(attribute.value, base, options)
    else if (URL_ATTRS.has(name)) attribute.value = isolatedUrlValue(attribute.value, base, name, options)
  }
}

function rewriteIsolatedTree(parent: ParentNode, base: string, options: IsolatedRewriteOptions): void {
  parent.childNodes = parent.childNodes.filter(node => !isRemovedMetaDirective(node))
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue
    rewriteIsolatedElement(child, base, options)
    rewriteIsolatedTree(child, base, options)
    if (child.tagName === 'template' && 'content' in child) {
      rewriteIsolatedTree(child.content, base, options)
    }
  }
}

function findElement(parent: ParentNode, tagName: string): Element | undefined {
  for (const child of parent.childNodes) {
    if (!isElement(child)) continue
    if (child.tagName === tagName) return child
    const nested = findElement(child, tagName)
    if (nested !== undefined) return nested
  }
  return undefined
}

function baseElement(href: string): Element {
  const fragment = parseFragment('<base>')
  const element = fragment.childNodes[0]
  if (element === undefined || !isElement(element)) throw new Error('failed to create proxy base element')
  element.attrs = [{ name: 'href', value: href }]
  return element
}

function scriptElement(attributes: Record<string, string>, source = ''): Element {
  const fragment = parseFragment(`<script>${source}</script>`)
  const element = fragment.childNodes[0]
  if (element === undefined || !isElement(element)) throw new Error('failed to create preview script element')
  element.attrs = Object.entries(attributes).map(([name, value]) => ({ name, value }))
  return element
}

/**
 * Rewrite one document for a dedicated preview origin and inject the bridge
 * before page-authored scripts. The frame's address is normalized to the
 * target's own path so `location`, framework routers, and page-visible URLs
 * match the original page; only cross-Origin navigation keeps a route prefix.
 */
export function rewriteIsolatedHtml(
  html: string,
  targetUrl: string,
  options: IsolatedRewriteOptions,
): string {
  const target = new URL(targetUrl)
  const absoluteTarget = target.href
  const document = parse(html)
  rewriteIsolatedTree(document, absoluteTarget, options)
  const head = findElement(document, 'head')
  if (head === undefined) throw new Error('parsed HTML document has no head element')
  const pagePath = `${target.pathname}${target.search}${target.hash}`
  const base = baseElement(new URL(`${target.pathname}${target.search}`, options.frameOrigin).href)
  const location = scriptElement(
    { 'data-dsh-web-review': 'location' },
    'try{history.replaceState(null,\'\','
    + `${JSON.stringify(pagePath).replaceAll('<', '\\u003c')})}catch(error){}`,
  )
  const configSource = `window.__DSH_WEB_REVIEW_BRIDGE_CONFIG__=Object.freeze(${JSON.stringify({
    protocol: 'dsh-web-review/bridge',
    version: 1,
    channel: options.channel,
    parentOrigin: options.parentOrigin,
    pageUrl: absoluteTarget,
    targetOrigin: new URL(absoluteTarget).origin,
  }).replaceAll('<', '\\u003c')});`
  const config = scriptElement({ 'data-dsh-web-review': 'config' }, configSource)
  const bridge = scriptElement({
    src: options.bridgePath,
    'data-dsh-web-review': 'bridge',
  })
  for (const child of [base, location, config, bridge]) child.parentNode = head
  head.childNodes.unshift(base, location, config, bridge)
  return serialize(document)
}
