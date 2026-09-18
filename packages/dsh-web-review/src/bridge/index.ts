/** Isolated-frame picker and controlled postMessage bridge. */
import {
  EDITABLE_STYLE_PROPERTIES,
  isEditableStyleProperty,
  isSafeAnnotationStyleValue,
  type EditableStyleProperty,
} from '../annotation-properties.ts'
import type { AnnotationStyleChange, AnnotationTextChange } from '../annotation-contract.ts'
import {
  PREVIEW_BRIDGE_PROTOCOL,
  PREVIEW_BRIDGE_VERSION,
  PREVIEW_ELEMENT_LIMITS,
  PREVIEW_ENTRY_PREFIX,
  PREVIEW_PROXY_PREFIX,
  PREVIEW_TREE_LIMITS,
  type PreviewBridgeCommand,
  type PreviewChannel,
  type PreviewElementHandle,
  type PreviewElementTarget,
  type PreviewFrameEvent,
  type PreviewFrameEventMessage,
  type PreviewFrameResponseMessage,
  type PreviewMarker,
  type PreviewTreeNode,
} from '../preview-contract.ts'
import {
  applyCommitted,
  baselineValue,
  createLivePatch,
  previewStyle,
  previewText,
  restoreAll,
  restoreStyle,
  restoreText,
  type LiveElementPatch,
} from '../client/live-patch.ts'
import {
  boundedReviewableTree,
  elementNavigationAction,
  elementTreeDetail,
  firstReviewableChild,
  isReviewableElement,
  navigateElement,
  nextReviewableSibling,
  previousReviewableSibling,
  reviewableParent,
} from '../client/element-navigation.ts'
import { snapshotOf, truncate } from '../client/picker-core.ts'
import { PICKER_STYLE } from './picker-style.ts'

interface BridgeConfig {
  protocol: typeof PREVIEW_BRIDGE_PROTOCOL
  version: typeof PREVIEW_BRIDGE_VERSION
  channel: PreviewChannel
  parentOrigin: string
  pageUrl: string
  targetOrigin: string
  /** Present when the host renders this page in the desktop shell's own panel. */
  native?: { endpoint: string }
}

declare global {
  interface Window {
    __DSH_WEB_REVIEW_BRIDGE_CONFIG__?: unknown
  }
}

interface CommittedPick {
  id: string
  cssPath: string
  element: Element
  patch: LiveElementPatch
  changes: AnnotationStyleChange[]
  textChange: AnnotationTextChange | null
}

interface ActiveEdit {
  handle: PreviewElementHandle
  originalPickId: string | null
}

const configOf = (value: unknown): BridgeConfig | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.protocol !== PREVIEW_BRIDGE_PROTOCOL || record.version !== PREVIEW_BRIDGE_VERSION
    || typeof record.channel !== 'string' || !/^[a-f\d]{32}$/u.test(record.channel)
    || typeof record.parentOrigin !== 'string' || typeof record.pageUrl !== 'string'
    || typeof record.targetOrigin !== 'string') return undefined
  try {
    const parent = new URL(record.parentOrigin)
    const page = new URL(record.pageUrl)
    if (parent.origin !== record.parentOrigin || page.origin !== record.targetOrigin) return undefined
    if (record.native !== undefined) {
      const native = record.native as { endpoint?: unknown }
      if (typeof native !== 'object' || native === null) return undefined
      if (typeof native.endpoint !== 'string') return undefined
      const endpoint = new URL(native.endpoint)
      if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') return undefined
    }
  } catch {
    return undefined
  }
  return record as unknown as BridgeConfig
}

const parsedConfig = configOf(window.__DSH_WEB_REVIEW_BRIDGE_CONFIG__)
if (parsedConfig === undefined) throw new Error('dsh-web-review: invalid bridge configuration')
const config: BridgeConfig = parsedConfig
delete window.__DSH_WEB_REVIEW_BRIDGE_CONFIG__

// Chromium exposes postMessage on the WindowProxy instance rather than as an
// own method of Window.prototype. Capture it before page-authored scripts can
// replace window.postMessage, then invoke it with the parent WindowProxy.
const nativePostMessage = window.postMessage
const handles = new Map<PreviewElementHandle, Element>()
const handlesByElement = new WeakMap<Element, PreviewElementHandle>()
const patchesByElement = new WeakMap<Element, LiveElementPatch>()
const committed = new Map<string, CommittedPick>()
const markerChrome = new Map<string, { element: Element; circle: HTMLDivElement }>()
let active: ActiveEdit | null = null
let picking = false
let hovered: Element | null = null
let selected: Element | null = null
let selectionBox: HTMLDivElement | null = null
let selectionObserver: ResizeObserver | null = null
let repositionQueued = false

function randomHandle(): PreviewElementHandle {
  const values = new Uint8Array(12)
  crypto.getRandomValues(values)
  return [...values].map(value => value.toString(16).padStart(2, '0')).join('') as PreviewElementHandle
}

function handleOf(element: Element): PreviewElementHandle {
  const existing = handlesByElement.get(element)
  if (existing !== undefined) return existing
  const handle = randomHandle()
  handles.set(handle, element)
  handlesByElement.set(element, handle)
  return handle
}

function patchOf(element: Element): LiveElementPatch {
  const existing = patchesByElement.get(element)
  if (existing !== undefined) return existing
  const patch = createLivePatch(element)
  patchesByElement.set(element, patch)
  return patch
}

function rectOf(element: Element): PreviewElementTarget['rect'] {
  const rect = element.getBoundingClientRect()
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function navigationOf(element: Element): PreviewElementTarget['navigation'] {
  return {
    child: firstReviewableChild(element) !== null,
    parent: reviewableParent(element) !== null,
    'previous-sibling': previousReviewableSibling(element) !== null,
    'next-sibling': nextReviewableSibling(element) !== null,
  }
}

function targetOf(element: Element): PreviewElementTarget {
  const patch = patchOf(element)
  const baselines = Object.fromEntries(EDITABLE_STYLE_PROPERTIES.map(property => [
    property,
    truncate(baselineValue(patch, property), PREVIEW_ELEMENT_LIMITS.styleValue),
  ])) as Record<EditableStyleProperty, string>
  const style = (element as HTMLElement).style
  const inlineStyles: PreviewElementTarget['inlineStyles'] = {}
  for (const property of EDITABLE_STYLE_PROPERTIES) {
    const value = style?.getPropertyValue(property) ?? ''
    if (value !== '') {
      inlineStyles[property] = {
        value: truncate(value, PREVIEW_ELEMENT_LIMITS.styleValue),
        priority: truncate(
          style.getPropertyPriority(property),
          PREVIEW_ELEMENT_LIMITS.stylePriority,
        ),
      }
    }
  }
  return {
    handle: handleOf(element),
    snapshot: snapshotOf(element),
    rect: rectOf(element),
    viewport: { width: innerWidth, height: innerHeight },
    baselines,
    inlineStyles,
    originalText: patch.originalText === null
      ? null
      : truncate(patch.originalText.value, PREVIEW_ELEMENT_LIMITS.textValue),
    detail: elementTreeDetail(element),
    navigation: navigationOf(element),
  }
}

/**
 * Deliver one host-bound message on whichever transport this page runs on.
 *
 * A hosted preview iframe has a parent window to post to; a page that the
 * plugin opened in a real browser has no parent, so the host installs a CDP
 * binding (`Runtime.addBinding`) under this exact global name instead.
 *
 * A native shell panel has neither: it reaches the host through the shell's
 * script message handler (the only channel an HTTPS page may use, because WebKit
 * blocks an insecure loopback request from a secure document) and falls back to
 * the loopback endpoint for the HTTP case.
 */
function deliver(message: PreviewFrameEventMessage | PreviewFrameResponseMessage): void {
  const payload = JSON.stringify(message)
  const send = (window as unknown as { __dshWebReviewSend?: unknown }).__dshWebReviewSend
  if (typeof send === 'function') {
    (send as (payload: string) => void)(payload)
    return
  }
  if (deliverToNative(payload)) return
  // The panel's handler is installed by the shell right after the webview
  // exists, which can trail this document's first scripts by a moment: hold the
  // message until a native channel answers instead of dropping the handshake.
  if (isNativePanel()) {
    queueNative(payload)
    return
  }
  Reflect.apply(nativePostMessage, parent, [message, config.parentOrigin])
}

/** The handler name the native bootstrap published, when it published one. */
function nativeIpcMarker(): string | undefined {
  const marker = (window as unknown as { __DSH_WEB_REVIEW_NATIVE_IPC__?: unknown }).__DSH_WEB_REVIEW_NATIVE_IPC__
  return typeof marker === 'string' && marker !== '' ? marker : undefined
}

/** Whether this document was loaded by the shell's own browser panel. */
function isNativePanel(): boolean {
  return nativeIpcMarker() !== undefined || nativeEndpointGlobal() !== undefined
}

/**
 * The shell's native message channel, once the host webview has exposed it.
 *
 * The two host webviews differ: WebKit (macOS) exposes a named
 * `WKScriptMessageHandler` under `webkit.messageHandlers`, while WebView2
 * (Windows) exposes one unnamed channel per webview under `chrome.webview`.
 * Both reach the same relay in the shell, so the payload shape is identical.
 */
function nativeIpcPost(marker: string | undefined): ((payload: string) => void) | undefined {
  if (marker === undefined) return undefined
  const host = (window as unknown as {
    chrome?: { webview?: { postMessage?: unknown } }
  }).chrome?.webview
  if (typeof host?.postMessage === 'function') {
    const post = host.postMessage
    return (payload: string) => { (post as (body: string) => void).call(host, payload) }
  }
  const handlers = (window as unknown as {
    webkit?: { messageHandlers?: Record<string, { postMessage?: unknown } | undefined> }
  }).webkit?.messageHandlers
  const target = handlers?.[marker]
  const post = target?.postMessage
  if (typeof post !== 'function') return undefined
  // A detached invocation throws "Illegal invocation" in WebKit.
  return (payload: string) => { (post as (body: string) => void).call(target, payload) }
}

/** Try every native channel once; whether the endpoint accepted is unknowable. */
function deliverToNative(payload: string): boolean {
  if (!isNativePanel()) return false
  const ipc = nativeIpcPost(nativeIpcMarker())
  if (ipc !== undefined) {
    try {
      ipc(payload)
      return true
    } catch (error) {
      noteNativeFailure(error)
    }
  }
  const endpoint = config.native?.endpoint ?? nativeEndpointGlobal()
  if (endpoint === undefined) return false
  try {
    // `keepalive` is deliberately absent: WebKit rejects some keepalive
    // combinations, and a beacon is the fallback when fetch fails.
    void fetch(endpoint, { method: 'POST', mode: 'no-cors', body: payload }).catch((error: unknown) => {
      noteNativeFailure(error)
      try { navigator.sendBeacon?.(endpoint, payload) } catch { /* nothing left to try */ }
    })
  } catch (error) {
    noteNativeFailure(error)
    try { navigator.sendBeacon?.(endpoint, payload) } catch { /* nothing left to try */ }
  }
  return true
}

/** Messages waiting for the panel's handler to be installed. */
const nativeOutbox: string[] = []
/** Bounded hold: the shell installs the handler milliseconds after the document. */
const NATIVE_OUTBOX_ATTEMPTS = 50
const NATIVE_OUTBOX_LIMIT = 64
let nativeOutboxTimer: ReturnType<typeof setInterval> | undefined

/** Hold one payload until a native channel can deliver it. */
function queueNative(payload: string): void {
  nativeOutbox.push(payload)
  if (nativeOutbox.length > NATIVE_OUTBOX_LIMIT) nativeOutbox.shift()
  if (nativeOutboxTimer !== undefined) return
  let attempts = 0
  nativeOutboxTimer = setInterval(() => {
    attempts += 1
    const ready = nativeIpcPost(nativeIpcMarker()) !== undefined
      || (config.native?.endpoint ?? nativeEndpointGlobal()) !== undefined
    if (!ready && attempts <= NATIVE_OUTBOX_ATTEMPTS) return
    clearInterval(nativeOutboxTimer)
    nativeOutboxTimer = undefined
    if (!ready) {
      nativeOutbox.length = 0
      return
    }
    const pending = nativeOutbox.splice(0, nativeOutbox.length)
    for (const item of pending) {
      if (!deliverToNative(item)) nativeOutbox.push(item)
    }
  }, 100)
}

/** Record why a native delivery failed, for the host's diagnostics. */
function noteNativeFailure(error: unknown): void {
  try {
    (window as unknown as { __DSH_WEB_REVIEW_NATIVE_ERROR__?: unknown }).__DSH_WEB_REVIEW_NATIVE_ERROR__ =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } catch { /* diagnostics are best effort */ }
}

/** The bootstrap's endpoint global, when a host published one. */
function nativeEndpointGlobal(): string | undefined {
  const value = (window as unknown as { __DSH_WEB_REVIEW_NATIVE_ENDPOINT__?: unknown }).__DSH_WEB_REVIEW_NATIVE_ENDPOINT__
  return typeof value === 'string' ? value : undefined
}

function postEvent(event: PreviewFrameEvent): void {
  deliver({
    protocol: PREVIEW_BRIDGE_PROTOCOL,
    version: PREVIEW_BRIDGE_VERSION,
    channel: config.channel,
    direction: 'frame-to-host',
    event,
  })
}

function postResponse(requestId: string, response: PreviewFrameResponseMessage['response']): void {
  deliver({
    protocol: PREVIEW_BRIDGE_PROTOCOL,
    version: PREVIEW_BRIDGE_VERSION,
    channel: config.channel,
    direction: 'frame-to-host',
    requestId,
    response,
  })
}

function pageUrl(): string {
  try {
    if (!location.pathname.startsWith(PREVIEW_ENTRY_PREFIX)
      && !location.pathname.startsWith(PREVIEW_PROXY_PREFIX)) {
      return new URL(
        `${location.pathname}${location.search}${location.hash}`,
        `${config.targetOrigin}/`,
      ).href
    }
    // The server-owned value is the final upstream URL after redirects and
    // query promotion. Client-side query/hash changes remain browser-local and
    // are overlaid when present on the isolated route.
    const target = new URL(config.pageUrl)
    if (location.search !== '') target.search = location.search
    if (location.hash !== '') target.hash = location.hash
    return target.href
  } catch {
    return config.pageUrl
  }
}

function historyState(): { canGoBack: boolean; canGoForward: boolean } {
  const navigation = (window as Window & {
    navigation?: { canGoBack: boolean; canGoForward: boolean }
  }).navigation
  return {
    canGoBack: navigation?.canGoBack ?? history.length > 1,
    canGoForward: navigation?.canGoForward ?? false,
  }
}

function postReady(): void {
  const state = historyState()
  postEvent({
    name: 'ready',
    payload: {
      pageUrl: pageUrl(),
      title: document.title.slice(0, 500),
      viewport: { width: innerWidth, height: innerHeight },
      ...state,
    },
  })
}

function isChrome(element: Element | null): boolean {
  return element?.closest('.dsh-wv-marker,.dsh-wv-selection-box') !== null
}

function clearHover(): void {
  hovered?.removeAttribute('data-dsh-wv-hover')
  hovered = null
}

function releasePageFocus(): void {
  const focused = document.activeElement
  if (focused instanceof HTMLElement && focused !== document.body) focused.blur()
}

function ensureSelectionBox(): HTMLDivElement {
  if (selectionBox?.isConnected === true) return selectionBox
  selectionBox = document.createElement('div')
  selectionBox.className = 'dsh-wv-selection-box'
  selectionBox.setAttribute('aria-hidden', 'true')
  document.documentElement.appendChild(selectionBox)
  return selectionBox
}

function positionSelection(animate: boolean): void {
  if (selected === null || !selected.isConnected) {
    selectionBox?.removeAttribute('data-visible')
    return
  }
  const rect = selected.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    selectionBox?.removeAttribute('data-visible')
    return
  }
  const box = ensureSelectionBox()
  if (animate) {
    box.removeAttribute('data-static')
    box.getBoundingClientRect()
  } else {
    box.setAttribute('data-static', '')
  }
  box.style.left = `${String(rect.left - 2)}px`
  box.style.top = `${String(rect.top - 2)}px`
  box.style.width = `${String(rect.width + 4)}px`
  box.style.height = `${String(rect.height + 4)}px`
  box.setAttribute('data-visible', '')
  if (!animate) requestAnimationFrame(() => { box.removeAttribute('data-static') })
}

function setSelected(element: Element): void {
  releasePageFocus()
  if (selected === element) return
  const animate = selected !== null && selectionBox?.hasAttribute('data-visible') === true
  selected?.removeAttribute('data-dsh-wv-selected')
  selected = element
  selected.setAttribute('data-dsh-wv-selected', '')
  selectionObserver?.disconnect()
  if (typeof ResizeObserver !== 'undefined') {
    selectionObserver = new ResizeObserver(() => { queueReposition() })
    selectionObserver.observe(element)
  }
  positionSelection(animate)
}

function clearSelection(): void {
  selected?.removeAttribute('data-dsh-wv-selected')
  selected = null
  selectionObserver?.disconnect()
  selectionObserver = null
  selectionBox?.removeAttribute('data-visible')
}

function repositionMarkers(): void {
  for (const marker of markerChrome.values()) {
    const rect = marker.element.getBoundingClientRect()
    marker.circle.style.display = rect.width === 0 && rect.height === 0 ? 'none' : ''
    marker.circle.style.left = `${String(rect.left + rect.width / 2)}px`
    marker.circle.style.top = `${String(rect.top)}px`
  }
}

function postGeometry(): void {
  if (active === null) return
  const element = handles.get(active.handle)
  if (element === undefined || !element.isConnected) return
  postEvent({
    name: 'target-geometry',
    payload: {
      handle: active.handle,
      rect: rectOf(element),
      viewport: { width: innerWidth, height: innerHeight },
    },
  })
}

function queueReposition(): void {
  if (repositionQueued) return
  repositionQueued = true
  requestAnimationFrame(() => {
    repositionQueued = false
    repositionMarkers()
    positionSelection(false)
    postGeometry()
  })
}

function rollbackActive(): void {
  if (active === null) return
  const currentElement = handles.get(active.handle)
  if (currentElement !== undefined) restoreAll(patchOf(currentElement))
  if (active.originalPickId !== null) {
    const original = committed.get(active.originalPickId)
    if (original !== undefined) applyCommitted(original.patch, original.changes, original.textChange)
  }
}

function begin(element: Element, originalPickId: string | null): PreviewElementTarget {
  rollbackActive()
  const handle = handleOf(element)
  active = { handle, originalPickId }
  setSelected(element)
  return targetOf(element)
}

function selectWithinTransaction(element: Element): PreviewElementTarget {
  const originalPickId = active?.originalPickId ?? null
  return begin(element, originalPickId)
}

function syncMarkers(markers: readonly PreviewMarker[]): void {
  const seen = new Set<string>()
  for (const marker of markers) {
    seen.add(marker.id)
    let record = committed.get(marker.id)
    let element = record?.element
    if (element === undefined || !element.isConnected || record?.cssPath !== marker.cssPath) {
      try {
        element = document.querySelector(marker.cssPath) ?? undefined
      } catch {
        element = undefined
      }
    }
    if (element === undefined || !isReviewableElement(element)) continue
    if (record !== undefined && record.element !== element) restoreAll(record.patch)
    const patch = patchOf(element)
    restoreAll(patch)
    applyCommitted(patch, marker.changes, marker.textChange)
    record = {
      id: marker.id,
      cssPath: marker.cssPath,
      element,
      patch,
      changes: [...marker.changes],
      textChange: marker.textChange,
    }
    committed.set(marker.id, record)
    const chrome = markerChrome.get(marker.id)
    if (chrome === undefined) {
      const circle = document.createElement('div')
      circle.className = 'dsh-wv-marker'
      circle.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        postEvent({ name: 'mark-click', payload: { pickId: marker.id } })
      })
      document.documentElement.appendChild(circle)
      markerChrome.set(marker.id, { element, circle })
    } else {
      chrome.element = element
    }
    markerChrome.get(marker.id)!.circle.textContent = String(marker.index)
  }
  for (const [id, record] of committed) {
    if (seen.has(id)) continue
    restoreAll(record.patch)
    committed.delete(id)
  }
  for (const [id, chrome] of markerChrome) {
    if (seen.has(id)) continue
    chrome.circle.remove()
    markerChrome.delete(id)
  }
  repositionMarkers()
}

function treeOf(current: Element): PreviewTreeNode {
  const serialize = (node: ReturnType<typeof boundedReviewableTree>): PreviewTreeNode => {
    const { element } = node
    const handle = handleOf(element)
    return {
      handle,
      key: handle,
      tagName: truncate(element.tagName.toLowerCase(), PREVIEW_ELEMENT_LIMITS.tagName),
      detail: elementTreeDetail(element),
      current: element === current,
      children: node.children.map(serialize),
    }
  }
  return serialize(boundedReviewableTree(
    current,
    PREVIEW_TREE_LIMITS.nodes,
    PREVIEW_TREE_LIMITS.depth,
  ))
}

function commandOf(value: unknown): PreviewBridgeCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && Object.hasOwn(record, 'payload')
    ? value as PreviewBridgeCommand
    : undefined
}

function elementFor(handle: unknown): Element | undefined {
  return typeof handle === 'string' ? handles.get(handle as PreviewElementHandle) : undefined
}

function stylePayload(payload: unknown): {
  element: Element
  property: EditableStyleProperty
  value?: string
} | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const element = elementFor(record.handle)
  if (element === undefined || typeof record.property !== 'string' || !isEditableStyleProperty(record.property)) return undefined
  return {
    element,
    property: record.property,
    ...(typeof record.value === 'string' ? { value: record.value } : {}),
  }
}

function execute(command: PreviewBridgeCommand): unknown {
  const payload = command.payload as unknown
  if (command.name === 'request-ready') { postReady(); return null }
  if (command.name === 'activate') {
    picking = true
    setPickingClass(true)
    return null
  }
  if (command.name === 'deactivate') {
    picking = false
    clearHover()
    clearSelection()
    setPickingClass(false)
    return null
  }
  if (command.name === 'clear-selection') {
    clearSelection()
    return null
  }
  if (command.name === 'sync-markers') {
    const markers = (payload as { markers?: unknown }).markers
    if (!Array.isArray(markers) || markers.length > 20) throw new Error('invalid markers')
    syncMarkers(markers as PreviewMarker[])
    return null
  }
  if (command.name === 'open-pick') {
    const data = payload as { pickId?: unknown; cssPath?: unknown }
    if (typeof data.pickId !== 'string' || typeof data.cssPath !== 'string') throw new Error('invalid pick')
    const existing = committed.get(data.pickId)
    let element = existing?.element
    if (element === undefined || !element.isConnected) element = document.querySelector(data.cssPath) ?? undefined
    if (element === undefined) return null
    return begin(element, data.pickId)
  }
  if (command.name === 'navigate-element') {
    const data = payload as { handle?: unknown; action?: unknown }
    const element = elementFor(data.handle)
    const action = data.action
    if (element === undefined || (action !== 'child' && action !== 'parent'
      && action !== 'previous-sibling' && action !== 'next-sibling')) throw new Error('invalid navigation')
    const target = navigateElement(element, action)
    return target === null ? null : selectWithinTransaction(target)
  }
  if (command.name === 'select-element') {
    const element = elementFor((payload as { handle?: unknown }).handle)
    if (element === undefined) throw new Error('element unavailable')
    return selectWithinTransaction(element)
  }
  if (command.name === 'read-tree') {
    const element = elementFor((payload as { handle?: unknown }).handle)
    if (element === undefined) throw new Error('element unavailable')
    return treeOf(element)
  }
  if (command.name === 'preview-style') {
    const data = stylePayload(payload)
    if (data === undefined || data.value === undefined || data.value.length > 500
      || !isSafeAnnotationStyleValue(data.value)) throw new Error('invalid style preview')
    previewStyle(patchOf(data.element), data.property, data.value)
    queueReposition()
    return null
  }
  if (command.name === 'restore-style') {
    const data = stylePayload(payload)
    if (data === undefined) throw new Error('invalid style restore')
    restoreStyle(patchOf(data.element), data.property)
    queueReposition()
    return null
  }
  if (command.name === 'preview-text') {
    const data = payload as { handle?: unknown; value?: unknown }
    const element = elementFor(data.handle)
    if (element === undefined || typeof data.value !== 'string' || data.value.length > 2_000) throw new Error('invalid text preview')
    previewText(patchOf(element), data.value)
    queueReposition()
    return null
  }
  if (command.name === 'restore-text') {
    const element = elementFor((payload as { handle?: unknown }).handle)
    if (element === undefined) throw new Error('element unavailable')
    restoreText(patchOf(element))
    queueReposition()
    return null
  }
  if (command.name === 'cancel-edit') {
    rollbackActive()
    active = null
    clearSelection()
    return null
  }
  if (command.name === 'commit-edit') {
    const data = payload as {
      pickId?: unknown
      handle?: unknown
      changes?: unknown
      textChange?: unknown
    }
    const element = elementFor(data.handle)
    if (typeof data.pickId !== 'string' || element === undefined || !Array.isArray(data.changes)) throw new Error('invalid commit')
    const originalId = active?.originalPickId
    if (originalId !== null && originalId !== undefined) {
      const original = committed.get(originalId)
      if (original !== undefined && original.element !== element) restoreAll(original.patch)
      if (originalId !== data.pickId) committed.delete(originalId)
    }
    const patch = patchOf(element)
    restoreAll(patch)
    applyCommitted(patch, data.changes as AnnotationStyleChange[], data.textChange as AnnotationTextChange | null)
    const snapshot = snapshotOf(element)
    committed.set(data.pickId, {
      id: data.pickId,
      cssPath: snapshot.cssPath,
      element,
      patch,
      changes: [...data.changes] as AnnotationStyleChange[],
      textChange: data.textChange as AnnotationTextChange | null,
    })
    active = null
    clearSelection()
    return null
  }
  if (command.name === 'history-back') { history.back(); return null }
  if (command.name === 'history-forward') { history.forward(); return null }
  if (command.name === 'reload') { location.reload(); return null }
  throw new Error('unsupported command')
}

/**
 * Mount the picker's own stylesheet.
 *
 * This bridge is injected at **document start** — the shell's panel runs it as an
 * initialization script and a CDP-driven page as an init script — where the
 * parser has not created `<head>` (or even `<html>`) yet. Appending to a missing
 * head threw, and that one throw took every picker listener after it with the
 * exception, so the handshake and the command channel looked healthy while hover
 * outlines and clicks silently did nothing. Mount as soon as a root exists.
 */
function mountPickerStyle(style: HTMLStyleElement): void {
  const host = (): Element | null => document.head ?? document.documentElement
  const current = host()
  if (current !== null) {
    current.appendChild(style)
    return
  }
  const observer = new MutationObserver((): void => {
    const target = host()
    if (target === null) return
    target.appendChild(style)
    observer.disconnect()
  })
  observer.observe(document, { childList: true, subtree: true })
}

/** Mark the page as picking, when there is a root to mark yet. */
function setPickingClass(picking: boolean): void {
  const root = document.documentElement
  if (root === null) return
  if (picking) root.classList.add('dsh-wv-picking')
  else root.classList.remove('dsh-wv-picking')
}

/** Execute one host command carried by either transport. */
function receiveHostMessage(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (record.protocol !== PREVIEW_BRIDGE_PROTOCOL || record.version !== PREVIEW_BRIDGE_VERSION
    || record.direction !== 'host-to-frame' || record.channel !== config.channel
    || typeof record.requestId !== 'string' || record.requestId.length > 64) return
  const command = commandOf(record.command)
  if (command === undefined) return
  try {
    postResponse(record.requestId, { ok: true, value: execute(command) })
  } catch (error) {
    postResponse(record.requestId, {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'bridge command failed',
    })
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== parent || event.origin !== config.parentOrigin) return
  receiveHostMessage(event.data)
})

// The host drives a real browser through CDP evaluation, which calls this
// global with the JSON-encoded host message.
;(window as unknown as { __dshWebReviewReceive?: unknown }).__dshWebReviewReceive = (raw: unknown): void => {
  if (typeof raw !== 'string' || raw.length > 1_048_576) return
  try {
    receiveHostMessage(JSON.parse(raw) as unknown)
  } catch { /* a malformed host payload is ignored */ }
}

function installPicker(): void {
  const style = document.createElement('style')
  style.dataset.dshWebReview = 'picker'
  style.textContent = PICKER_STYLE
  mountPickerStyle(style)
  document.addEventListener('mouseover', (event) => {
    if (!picking || !(event.target instanceof Element) || event.target === document.documentElement
      || event.target === document.body || isChrome(event.target) || event.target === selected) return
    if (hovered === event.target) return
    clearHover()
    hovered = event.target
    hovered.setAttribute('data-dsh-wv-hover', '')
  }, true)
  document.addEventListener('mouseout', (event) => {
    if (picking && event.target === hovered) clearHover()
  }, true)
  document.addEventListener('pointerdown', (event) => {
    if (!picking || !(event.target instanceof Element) || isChrome(event.target)) return
    event.preventDefault()
    releasePageFocus()
  }, true)
  document.addEventListener('click', (event) => {
    if (!picking || !(event.target instanceof Element) || isChrome(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    const element = hovered
    clearHover()
    if (element === null) return
    const existing = [...committed.values()].find(record => record.element === element)
    if (existing !== undefined) {
      postEvent({ name: 'mark-click', payload: { pickId: existing.id } })
      return
    }
    postEvent({ name: 'pick', payload: { target: begin(element, null) } })
  }, true)
  document.addEventListener('keydown', (event) => {
    if (picking && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      postEvent({ name: 'cancel-pick', payload: null })
      return
    }
    if (active === null) return
    const action = elementNavigationAction(event, { capturePageActions: true })
    if (action === null) return
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    postEvent({ name: 'shortcut', payload: { action } })
  }, true)
  document.addEventListener('scroll', queueReposition, true)
  window.addEventListener('resize', queueReposition)
}

installPicker()
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', postReady, { once: true })
else queueMicrotask(postReady)
window.addEventListener('popstate', postReady)
window.addEventListener('hashchange', postReady)
const navigation = (window as Window & { navigation?: EventTarget }).navigation
navigation?.addEventListener('currententrychange', postReady)
