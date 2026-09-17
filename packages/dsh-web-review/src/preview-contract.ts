/**
 * Cross-origin preview-session and frame-bridge contracts.
 *
 * Values received from a preview frame are untrusted page evidence. The
 * channel routes messages to the correct iframe; it is not an authenticity
 * boundary because scripts in the isolated page can inspect their own DOM.
 */
import type {
  AnnotationStyleChange,
  AnnotationTextChange,
  AnnotationViewport,
} from './annotation-contract.ts'
import {
  EDITABLE_STYLE_PROPERTIES,
  isEditableStyleProperty,
  type EditableStyleProperty,
} from './annotation-properties.ts'
import { decodeTarget, isPreviewableUrl } from './proxy-url.ts'

export type PreviewElementNavigationAction = 'child' | 'parent' | 'previous-sibling' | 'next-sibling'
export type PreviewElementTreeDetail =
  | { kind: 'children'; count: number }
  | { kind: 'empty' }
  | { kind: 'text'; text: string }

/** DOM evidence shape kept independent of browser DOM library types. */
export interface PreviewElementSnapshot {
  tagName: string
  id: string
  className: string
  cssPath: string
  fullPath: string
  label: string
  role: string
  stableClasses: string[]
  anchor: import('./annotation-contract.ts').AnnotationAnchor | null
  /** True when the element sits inside this plugin's own `[data-webview-ui]` chrome. */
  inToolChrome: boolean
  outerHTML: string
  textContent: string
  rect: { x: number; y: number; width: number; height: number }
  computed: {
    display: string
    position: string
    fontSize: string
    color: string
    backgroundColor: string
    margin: string
    padding: string
    width: string
    height: string
  }
}

/** Bounds for untrusted page evidence crossing the isolated-frame bridge. */
export const PREVIEW_ELEMENT_LIMITS = {
  tagName: 64,
  id: 512,
  className: 2_000,
  cssPath: 2_000,
  fullPath: 4_000,
  label: 500,
  role: 100,
  stableClass: 100,
  stableClasses: 20,
  anchorFile: 1_000,
  anchorComponent: 500,
  outerHTML: 1_500,
  textContent: 300,
  computedValue: 500,
  styleValue: 500,
  stylePriority: 32,
  textValue: 2_000,
} as const

/** Bounds for one serialized hierarchy response from the isolated frame. */
export const PREVIEW_TREE_LIMITS = {
  nodes: 2_000,
  depth: 100,
  key: 2_000,
} as const

export const PREVIEW_SESSIONS_PATH = '/webview-preview-sessions'
export const PREVIEW_CLIENT_HEADER = 'x-dsh-web-review-client'
export const PREVIEW_CLIENT_HEADER_VALUE = '1'
export const PREVIEW_BRIDGE_PROTOCOL = 'dsh-web-review/bridge'
export const PREVIEW_BRIDGE_VERSION = 1
export const PREVIEW_RESERVED_PREFIX = '/.dsh-web-review'
export const PREVIEW_BRIDGE_PATH = `${PREVIEW_RESERVED_PREFIX}/bridge.js`
export const PREVIEW_ENTRY_PREFIX = `${PREVIEW_RESERVED_PREFIX}/entry/`
export const PREVIEW_PROXY_PREFIX = `${PREVIEW_RESERVED_PREFIX}/proxy/`
export const PREVIEW_NAVIGATE_PREFIX = `${PREVIEW_RESERVED_PREFIX}/navigate/`
/** Server-sent frame/state stream of one browser-backed preview session. */
export const PREVIEW_BROWSER_STREAM_PATH = '/webview-browser-stream'
/** Input and command channel of one browser-backed preview session. */
export const PREVIEW_BROWSER_INPUT_PATH = '/webview-browser-input'

declare const previewSessionIdBrand: unique symbol
declare const previewChannelBrand: unique symbol
declare const previewElementHandleBrand: unique symbol

export type PreviewSessionId = string & { readonly [previewSessionIdBrand]: true }
export type PreviewChannel = string & { readonly [previewChannelBrand]: true }
export type PreviewElementHandle = string & { readonly [previewElementHandleBrand]: true }

/**
 * `proxy` renders the target through the isolated loopback HTTP proxy;
 * `browser` drives a real Chromium page, so the page keeps its true Origin,
 * cookies, service workers, and WebSockets; `native` renders it in the desktop
 * shell's own WKWebView panel, which needs no stream and no input forwarding.
 */
export type PreviewSessionMode = 'proxy' | 'browser' | 'native'

export interface PreviewSessionDescriptor {
  sessionId: PreviewSessionId
  mode: PreviewSessionMode
  frameUrl: string
  frameOrigin: string
  /** Server-bound target Origin used to reject page-forged address changes. */
  targetOrigin: string
  channel: PreviewChannel
}

export interface PreviewInlineDeclaration {
  value: string
  priority: string
}

export interface PreviewElementTarget {
  handle: PreviewElementHandle
  snapshot: PreviewElementSnapshot
  rect: { x: number; y: number; width: number; height: number }
  viewport: AnnotationViewport
  baselines: Record<EditableStyleProperty, string>
  inlineStyles: Partial<Record<EditableStyleProperty, PreviewInlineDeclaration>>
  originalText: string | null
  detail: PreviewElementTreeDetail
  navigation: Record<PreviewElementNavigationAction, boolean>
}

export interface PreviewTreeNode {
  handle: PreviewElementHandle
  key: string
  tagName: string
  detail: PreviewElementTreeDetail
  current: boolean
  children: PreviewTreeNode[]
}

export interface PreviewMarker {
  id: string
  index: number
  cssPath: string
  changes: AnnotationStyleChange[]
  textChange: AnnotationTextChange | null
}

export type PreviewBridgeCommand =
  | { name: 'request-ready'; payload: null }
  | { name: 'activate'; payload: null }
  | { name: 'deactivate'; payload: null }
  | { name: 'clear-selection'; payload: null }
  | { name: 'sync-markers'; payload: { markers: PreviewMarker[] } }
  | { name: 'open-pick'; payload: { pickId: string; cssPath: string } }
  | { name: 'navigate-element'; payload: { handle: PreviewElementHandle; action: PreviewElementNavigationAction } }
  | { name: 'select-element'; payload: { handle: PreviewElementHandle } }
  | { name: 'read-tree'; payload: { handle: PreviewElementHandle } }
  | { name: 'preview-style'; payload: { handle: PreviewElementHandle; property: EditableStyleProperty; value: string } }
  | { name: 'restore-style'; payload: { handle: PreviewElementHandle; property: EditableStyleProperty } }
  | { name: 'preview-text'; payload: { handle: PreviewElementHandle; value: string } }
  | { name: 'restore-text'; payload: { handle: PreviewElementHandle } }
  | { name: 'cancel-edit'; payload: null }
  | { name: 'commit-edit'; payload: {
      pickId: string
      handle: PreviewElementHandle
      changes: AnnotationStyleChange[]
      textChange: AnnotationTextChange | null
    } }
  | { name: 'history-back'; payload: null }
  | { name: 'history-forward'; payload: null }
  | { name: 'reload'; payload: null }

export interface PreviewHostMessage {
  protocol: typeof PREVIEW_BRIDGE_PROTOCOL
  version: typeof PREVIEW_BRIDGE_VERSION
  channel: PreviewChannel
  direction: 'host-to-frame'
  requestId: string
  command: PreviewBridgeCommand
}

export type PreviewFrameEvent =
  | { name: 'ready'; payload: {
      pageUrl: string
      title: string
      viewport: AnnotationViewport
      canGoBack: boolean
      canGoForward: boolean
    } }
  | { name: 'pick'; payload: { target: PreviewElementTarget } }
  | { name: 'cancel-pick'; payload: null }
  | { name: 'mark-click'; payload: { pickId: string } }
  | { name: 'target-geometry'; payload: {
      handle: PreviewElementHandle
      rect: PreviewElementTarget['rect']
      viewport: AnnotationViewport
    } }
  | { name: 'shortcut'; payload: { action: PreviewElementNavigationAction } }
  | { name: 'handoff'; payload: PreviewSessionDescriptor }

export interface PreviewFrameEventMessage {
  protocol: typeof PREVIEW_BRIDGE_PROTOCOL
  version: typeof PREVIEW_BRIDGE_VERSION
  channel: PreviewChannel
  direction: 'frame-to-host'
  event: PreviewFrameEvent
}

export interface PreviewFrameResponseMessage {
  protocol: typeof PREVIEW_BRIDGE_PROTOCOL
  version: typeof PREVIEW_BRIDGE_VERSION
  channel: PreviewChannel
  direction: 'frame-to-host'
  requestId: string
  response: { ok: true; value: unknown } | { ok: false; error: string }
}

export type PreviewFrameMessage = PreviewFrameEventMessage | PreviewFrameResponseMessage

type UnknownRecord = Record<string, unknown>

function recordOf(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function exactKeys(record: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key))
}

function boundedString(value: unknown, cap: number, allowEmpty = true): string | undefined {
  return typeof value === 'string' && value.length <= cap && (allowEmpty || value.length > 0)
    ? value
    : undefined
}

function finiteDimension(value: unknown, cap = 100_000): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= cap ? value : undefined
}

function viewportOf(value: unknown): AnnotationViewport | undefined {
  const record = recordOf(value)
  if (record === undefined || !exactKeys(record, ['width', 'height'])) return undefined
  const width = finiteDimension(record.width)
  const height = finiteDimension(record.height)
  return width === undefined || height === undefined || width < 0 || height < 0
    ? undefined
    : { width: Math.round(width), height: Math.round(height) }
}

function rectOf(value: unknown): PreviewElementTarget['rect'] | undefined {
  const record = recordOf(value)
  if (record === undefined || !exactKeys(record, ['x', 'y', 'width', 'height'])) return undefined
  const x = finiteDimension(record.x)
  const y = finiteDimension(record.y)
  const width = finiteDimension(record.width)
  const height = finiteDimension(record.height)
  return x === undefined || y === undefined || width === undefined || height === undefined || width < 0 || height < 0
    ? undefined
    : { x, y, width, height }
}

function sessionIdOf(value: unknown): PreviewSessionId | undefined {
  return typeof value === 'string' && /^[a-f\d]{32}$/u.test(value) ? value as PreviewSessionId : undefined
}

function channelOf(value: unknown): PreviewChannel | undefined {
  return typeof value === 'string' && /^[a-f\d]{32}$/u.test(value) ? value as PreviewChannel : undefined
}

function elementHandleOf(value: unknown): PreviewElementHandle | undefined {
  return typeof value === 'string' && /^[a-f\d]{16,32}$/u.test(value) ? value as PreviewElementHandle : undefined
}

/** Strictly decode the main-host or handoff session descriptor. */
export function previewSessionDescriptorOf(value: unknown): PreviewSessionDescriptor | undefined {
  const record = recordOf(value)
  if (record === undefined || !exactKeys(record, [
    'sessionId', 'mode', 'frameUrl', 'frameOrigin', 'targetOrigin', 'channel',
  ])) return undefined
  const sessionId = sessionIdOf(record.sessionId)
  const channel = channelOf(record.channel)
  const mode = record.mode === 'proxy' || record.mode === 'browser' || record.mode === 'native'
    ? record.mode
    : undefined
  const frameUrl = boundedString(record.frameUrl, 32_768, false)
  const frameOrigin = boundedString(record.frameOrigin, 2_048, false)
  const targetOrigin = boundedString(record.targetOrigin, 2_048, false)
  if (sessionId === undefined || channel === undefined || mode === undefined || frameUrl === undefined
    || frameOrigin === undefined || targetOrigin === undefined) return undefined
  try {
    if (new URL(targetOrigin).origin !== targetOrigin) return undefined
    const url = new URL(frameUrl)
    if (url.username !== '' || url.password !== '') return undefined
    if (mode === 'browser' || mode === 'native') {
      // A browser session serves nothing itself: `frameUrl` is the live page
      // address and `frameOrigin` is the DSH host Origin that owns the stream.
      if (!isPreviewableUrl(url.href) || url.origin !== targetOrigin) return undefined
      if (new URL(frameOrigin).origin !== frameOrigin) return undefined
    } else {
      const target = new URL(decodeTarget(url.pathname.slice(PREVIEW_ENTRY_PREFIX.length)))
      if (url.protocol !== 'http:' || url.origin !== frameOrigin
        || url.hostname !== `${sessionId}.localhost`
        || !url.pathname.startsWith(PREVIEW_ENTRY_PREFIX)
        || !isPreviewableUrl(target.href) || target.origin !== targetOrigin) return undefined
    }
  } catch {
    return undefined
  }
  return { sessionId, mode, frameUrl, frameOrigin, targetOrigin, channel }
}

/** Bounds for the browser input/command channel. */
export const PREVIEW_BROWSER_LIMITS = {
  text: 4_000,
  url: 4_096,
  coordinate: 200_000,
  delta: 40_000,
  bridge: 64 * 1024,
} as const

/** One pointer event forwarded into the browser page. */
export interface PreviewBrowserMouseInput {
  kind: 'mouse'
  type: 'move' | 'down' | 'up'
  x: number
  y: number
  button: 'left' | 'right' | 'middle'
  clickCount: number
  modifiers: number
}

/** One wheel event forwarded into the browser page. */
export interface PreviewBrowserWheelInput {
  kind: 'wheel'
  x: number
  y: number
  deltaX: number
  deltaY: number
  modifiers: number
}

/** One keyboard event forwarded into the browser page. */
export interface PreviewBrowserKeyInput {
  kind: 'key'
  type: 'down' | 'up' | 'char'
  key: string
  code: string
  text: string
  windowsVirtualKeyCode: number
  modifiers: number
}

/** Inserted text, used instead of per-character keys for IME-safe input. */
export interface PreviewBrowserTextInput {
  kind: 'text'
  text: string
}

/** Place the native panel over the surface element it stands for. */
export interface PreviewBrowserBoundsInput {
  kind: 'bounds'
  x: number
  y: number
  width: number
  height: number
  /** False hides the panel without destroying it (a hidden tab, or scrolled away). */
  visible: boolean
}

/** Resize the emulated viewport to the panel surface. */
export interface PreviewBrowserViewportInput {
  kind: 'viewport'
  width: number
  height: number
  deviceScaleFactor: number
}

export type PreviewBrowserInput =
  | PreviewBrowserMouseInput
  | PreviewBrowserWheelInput
  | PreviewBrowserKeyInput
  | PreviewBrowserTextInput
  | PreviewBrowserViewportInput
  | PreviewBrowserBoundsInput

/** Commands the panel can issue against one browser session. */
export interface PreviewBrowserCommand {
  name: 'reload' | 'navigate' | 'back' | 'forward' | 'screenshot' | 'bridge' | 'close'
  url?: string
  /** JSON-encoded host bridge message, used by the `bridge` command. */
  payload?: string
}

/** Body of one `POST /webview-browser-input` request. */
export interface PreviewBrowserRequest {
  sessionId: PreviewSessionId
  channel: PreviewChannel
  input?: PreviewBrowserInput
  command?: PreviewBrowserCommand
}

function boundedNumber(value: unknown, limit: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined
}

function modifiersOf(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 15
    ? value as number
    : undefined
}

function buttonOf(value: unknown): PreviewBrowserMouseInput['button'] | undefined {
  return value === 'left' || value === 'right' || value === 'middle' ? value : undefined
}

function inputOf(value: unknown): PreviewBrowserInput | undefined {
  const record = recordOf(value)
  if (record === undefined || typeof record.kind !== 'string') return undefined
  const modifiers = record.modifiers === undefined ? 0 : modifiersOf(record.modifiers)
  if (modifiers === undefined) return undefined
  if (record.kind === 'mouse') {
    const x = boundedNumber(record.x, PREVIEW_BROWSER_LIMITS.coordinate)
    const y = boundedNumber(record.y, PREVIEW_BROWSER_LIMITS.coordinate)
    const button = buttonOf(record.button)
    const type = record.type === 'move' || record.type === 'down' || record.type === 'up' ? record.type : undefined
    const clickCount = Number.isSafeInteger(record.clickCount) && (record.clickCount as number) >= 1
      && (record.clickCount as number) <= 3 ? record.clickCount as number : undefined
    return x === undefined || y === undefined || button === undefined || type === undefined || clickCount === undefined
      ? undefined
      : { kind: 'mouse', type, x, y, button, clickCount, modifiers }
  }
  if (record.kind === 'wheel') {
    const x = boundedNumber(record.x, PREVIEW_BROWSER_LIMITS.coordinate)
    const y = boundedNumber(record.y, PREVIEW_BROWSER_LIMITS.coordinate)
    const deltaX = boundedNumber(record.deltaX, PREVIEW_BROWSER_LIMITS.delta)
    const deltaY = boundedNumber(record.deltaY, PREVIEW_BROWSER_LIMITS.delta)
    return x === undefined || y === undefined || deltaX === undefined || deltaY === undefined
      ? undefined
      : { kind: 'wheel', x, y, deltaX, deltaY, modifiers }
  }
  if (record.kind === 'key') {
    const type = record.type === 'down' || record.type === 'up' || record.type === 'char' ? record.type : undefined
    const key = boundedString(record.key, 64)
    const code = boundedString(record.code, 64)
    const text = record.text === undefined ? '' : boundedString(record.text, 64)
    const windowsVirtualKeyCode = Number.isSafeInteger(record.windowsVirtualKeyCode)
      ? record.windowsVirtualKeyCode as number : undefined
    return type === undefined || key === undefined || code === undefined || text === undefined
      || windowsVirtualKeyCode === undefined || windowsVirtualKeyCode < 0 || windowsVirtualKeyCode > 1_000
      ? undefined
      : { kind: 'key', type, key, code, text, windowsVirtualKeyCode, modifiers }
  }
  if (record.kind === 'text') {
    const text = boundedString(record.text, PREVIEW_BROWSER_LIMITS.text, false)
    return text === undefined ? undefined : { kind: 'text', text }
  }
  if (record.kind === 'bounds') {
    const x = boundedNumber(record.x, PREVIEW_BROWSER_LIMITS.coordinate)
    const y = boundedNumber(record.y, PREVIEW_BROWSER_LIMITS.coordinate)
    const width = boundedNumber(record.width, 20_000)
    const height = boundedNumber(record.height, 20_000)
    if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
    if (typeof record.visible !== 'boolean' || width < 0 || height < 0) return undefined
    return { kind: 'bounds', x, y, width, height, visible: record.visible }
  }
  if (record.kind === 'viewport') {
    const width = boundedNumber(record.width, 20_000)
    const height = boundedNumber(record.height, 20_000)
    const deviceScaleFactor = record.deviceScaleFactor === undefined
      ? 1
      : boundedNumber(record.deviceScaleFactor, 8)
    return width === undefined || height === undefined || deviceScaleFactor === undefined || width < 1 || height < 1
      ? undefined
      : { kind: 'viewport', width, height, deviceScaleFactor }
  }
  return undefined
}

/** Strictly decode one browser input/command request body. */
export function previewBrowserRequestOf(value: unknown): PreviewBrowserRequest | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const sessionId = sessionIdOf(record.sessionId)
  const channel = channelOf(record.channel)
  if (sessionId === undefined || channel === undefined) return undefined
  const hasInput = Object.hasOwn(record, 'input')
  const hasCommand = Object.hasOwn(record, 'command')
  if (hasInput === hasCommand) return undefined
  if (hasInput) {
    const input = inputOf(record.input)
    return input === undefined || !exactKeys(record, ['sessionId', 'channel', 'input'])
      ? undefined
      : { sessionId, channel, input }
  }
  const commandRecord = recordOf(record.command)
  if (commandRecord === undefined) return undefined
  const name = commandRecord.name
  if (name !== 'reload' && name !== 'navigate' && name !== 'back' && name !== 'forward'
    && name !== 'screenshot' && name !== 'bridge' && name !== 'close') {
    return undefined
  }
  if (name === 'bridge') {
    const payload = boundedString(commandRecord.payload, PREVIEW_BROWSER_LIMITS.bridge, false)
    if (payload === undefined || !exactKeys(commandRecord, ['name', 'payload'])) return undefined
    return exactKeys(record, ['sessionId', 'channel', 'command'])
      ? { sessionId, channel, command: { name, payload } }
      : undefined
  }
  if (name === 'navigate') {
    const url = boundedString(commandRecord.url, PREVIEW_BROWSER_LIMITS.url, false)
    if (url === undefined || !isPreviewableUrl(url) || !exactKeys(commandRecord, ['name', 'url'])) return undefined
    return exactKeys(record, ['sessionId', 'channel', 'command'])
      ? { sessionId, channel, command: { name, url } }
      : undefined
  }
  return exactKeys(commandRecord, ['name']) && exactKeys(record, ['sessionId', 'channel', 'command'])
    ? { sessionId, channel, command: { name } }
    : undefined
}

function treeDetailOf(value: unknown): PreviewElementTreeDetail | undefined {
  const record = recordOf(value)
  if (record === undefined || typeof record.kind !== 'string') return undefined
  if (record.kind === 'empty' && exactKeys(record, ['kind'])) return { kind: 'empty' }
  if (record.kind === 'children' && exactKeys(record, ['kind', 'count']) && Number.isSafeInteger(record.count)
    && (record.count as number) >= 0 && (record.count as number) <= 100_000) {
    return { kind: 'children', count: record.count as number }
  }
  const text = boundedString(record.text, 48)
  return record.kind === 'text' && exactKeys(record, ['kind', 'text']) && text !== undefined
    ? { kind: 'text', text }
    : undefined
}

function snapshotOf(value: unknown): PreviewElementSnapshot | undefined {
  const record = recordOf(value)
  if (record === undefined || !exactKeys(record, [
    'tagName', 'id', 'className', 'cssPath', 'fullPath', 'label', 'role',
    'stableClasses', 'anchor', 'inToolChrome', 'outerHTML', 'textContent', 'rect', 'computed',
  ])) return undefined
  if (typeof record.inToolChrome !== 'boolean') return undefined
  const stringCaps = {
    tagName: PREVIEW_ELEMENT_LIMITS.tagName,
    id: PREVIEW_ELEMENT_LIMITS.id,
    className: PREVIEW_ELEMENT_LIMITS.className,
    cssPath: PREVIEW_ELEMENT_LIMITS.cssPath,
    fullPath: PREVIEW_ELEMENT_LIMITS.fullPath,
    label: PREVIEW_ELEMENT_LIMITS.label,
    role: PREVIEW_ELEMENT_LIMITS.role,
    outerHTML: PREVIEW_ELEMENT_LIMITS.outerHTML,
    textContent: PREVIEW_ELEMENT_LIMITS.textContent,
  } as const
  for (const [key, cap] of Object.entries(stringCaps)) {
    if (boundedString(record[key], cap) === undefined) return undefined
  }
  if (!Array.isArray(record.stableClasses)
    || record.stableClasses.length > PREVIEW_ELEMENT_LIMITS.stableClasses
    || record.stableClasses.some(value => boundedString(
      value,
      PREVIEW_ELEMENT_LIMITS.stableClass,
      false,
    ) === undefined)) return undefined
  const rect = rectOf(record.rect)
  const computed = recordOf(record.computed)
  if (rect === undefined || computed === undefined || !exactKeys(computed, [
    'display', 'position', 'fontSize', 'color', 'backgroundColor', 'margin',
    'padding', 'width', 'height',
  ]) || Object.values(computed).some(item => boundedString(
    item,
    PREVIEW_ELEMENT_LIMITS.computedValue,
  ) === undefined)) return undefined
  const anchor = record.anchor
  if (anchor !== null) {
    const anchorRecord = recordOf(anchor)
    const anchorKeys = anchorRecord === undefined ? [] : Object.keys(anchorRecord)
    if (anchorRecord === undefined
      || !['react', 'vue', 'svelte'].includes(String(anchorRecord.framework))
      || boundedString(anchorRecord.component, PREVIEW_ELEMENT_LIMITS.anchorComponent) === undefined
      || boundedString(anchorRecord.file, PREVIEW_ELEMENT_LIMITS.anchorFile, false) === undefined
      || !['framework', 'component', 'file'].every(key => anchorKeys.includes(key))
      || anchorKeys.some(key => !['framework', 'component', 'file', 'line'].includes(key))
      || (anchorRecord.line !== undefined
        && (!Number.isSafeInteger(anchorRecord.line) || (anchorRecord.line as number) < 1))) return undefined
  }
  return { ...record, rect } as unknown as PreviewElementSnapshot
}

/** Strictly decode one serializable element target from an untrusted frame. */
export function previewElementTargetOf(value: unknown): PreviewElementTarget | undefined {
  const record = recordOf(value)
  if (record === undefined || !exactKeys(record, [
    'handle', 'snapshot', 'rect', 'viewport', 'baselines', 'inlineStyles',
    'originalText', 'detail', 'navigation',
  ])) return undefined
  const handle = elementHandleOf(record.handle)
  const snapshot = snapshotOf(record.snapshot)
  const rect = rectOf(record.rect)
  const viewport = viewportOf(record.viewport)
  const detail = treeDetailOf(record.detail)
  const baselines = recordOf(record.baselines)
  const inlineStyles = recordOf(record.inlineStyles)
  const navigation = recordOf(record.navigation)
  if (handle === undefined || snapshot === undefined || rect === undefined || viewport === undefined
    || detail === undefined || baselines === undefined || inlineStyles === undefined || navigation === undefined
    || !exactKeys(baselines, EDITABLE_STYLE_PROPERTIES)
    || EDITABLE_STYLE_PROPERTIES.some(property => boundedString(
      baselines[property],
      PREVIEW_ELEMENT_LIMITS.styleValue,
    ) === undefined)
    || Object.keys(inlineStyles).some(property => !isEditableStyleProperty(property))
    || !exactKeys(navigation, ['child', 'parent', 'previous-sibling', 'next-sibling'])
    || Object.values(navigation).some(item => typeof item !== 'boolean')) return undefined
  const parsedInline: PreviewElementTarget['inlineStyles'] = {}
  for (const property of EDITABLE_STYLE_PROPERTIES) {
    const raw = inlineStyles[property]
    if (raw === undefined) continue
    const declaration = recordOf(raw)
    if (declaration === undefined || !exactKeys(declaration, ['value', 'priority'])) return undefined
    const inlineValue = boundedString(declaration.value, PREVIEW_ELEMENT_LIMITS.styleValue)
    const priority = boundedString(declaration.priority, PREVIEW_ELEMENT_LIMITS.stylePriority)
    if (inlineValue === undefined || priority === undefined) return undefined
    parsedInline[property] = { value: inlineValue, priority }
  }
  const originalText = record.originalText
  if (originalText !== null
    && boundedString(originalText, PREVIEW_ELEMENT_LIMITS.textValue) === undefined) return undefined
  return {
    handle,
    snapshot,
    rect,
    viewport,
    baselines: baselines as Record<EditableStyleProperty, string>,
    inlineStyles: parsedInline,
    originalText: originalText as string | null,
    detail,
    navigation: navigation as Record<PreviewElementNavigationAction, boolean>,
  }
}

/** Decode only the bridge envelope; event payloads are decoded by the consumer. */
export function previewFrameMessageOf(value: unknown): PreviewFrameMessage | undefined {
  const record = recordOf(value)
  if (record === undefined || record.protocol !== PREVIEW_BRIDGE_PROTOCOL
    || record.version !== PREVIEW_BRIDGE_VERSION || record.direction !== 'frame-to-host') return undefined
  const channel = channelOf(record.channel)
  if (channel === undefined) return undefined
  if (Object.hasOwn(record, 'event')) {
    if (!exactKeys(record, ['protocol', 'version', 'channel', 'direction', 'event'])) return undefined
    const event = recordOf(record.event)
    if (event === undefined || typeof event.name !== 'string' || !exactKeys(event, ['name', 'payload'])) return undefined
    return { protocol: PREVIEW_BRIDGE_PROTOCOL, version: PREVIEW_BRIDGE_VERSION, channel, direction: 'frame-to-host', event: event as unknown as PreviewFrameEvent }
  }
  if (!exactKeys(record, ['protocol', 'version', 'channel', 'direction', 'requestId', 'response'])) return undefined
  const requestId = boundedString(record.requestId, 64, false)
  const response = recordOf(record.response)
  if (requestId === undefined || response === undefined || typeof response.ok !== 'boolean') return undefined
  if (response.ok && exactKeys(response, ['ok', 'value'])) {
    return { protocol: PREVIEW_BRIDGE_PROTOCOL, version: PREVIEW_BRIDGE_VERSION, channel, direction: 'frame-to-host', requestId, response: { ok: true, value: response.value } }
  }
  const error = boundedString(response.error, 500, false)
  return !response.ok && exactKeys(response, ['ok', 'error']) && error !== undefined
    ? { protocol: PREVIEW_BRIDGE_PROTOCOL, version: PREVIEW_BRIDGE_VERSION, channel, direction: 'frame-to-host', requestId, response: { ok: false, error } }
    : undefined
}

/** Strictly decode one bounded serialized hierarchy. */
export function previewTreeOf(
  value: unknown,
  budget = PREVIEW_TREE_LIMITS.nodes,
): PreviewTreeNode | undefined {
  let remaining = budget
  const visit = (raw: unknown, depth: number): PreviewTreeNode | undefined => {
    if (remaining <= 0 || depth > PREVIEW_TREE_LIMITS.depth) return undefined
    remaining -= 1
    const record = recordOf(raw)
    if (record === undefined || !exactKeys(record, ['handle', 'key', 'tagName', 'detail', 'current', 'children'])) return undefined
    const handle = elementHandleOf(record.handle)
    const key = boundedString(record.key, PREVIEW_TREE_LIMITS.key, false)
    const tagName = boundedString(record.tagName, 64, false)
    const detail = treeDetailOf(record.detail)
    if (handle === undefined || key === undefined || tagName === undefined || detail === undefined
      || typeof record.current !== 'boolean' || !Array.isArray(record.children)
      || record.children.length > PREVIEW_TREE_LIMITS.nodes) return undefined
    const children: PreviewTreeNode[] = []
    for (const child of record.children) {
      const parsed = visit(child, depth + 1)
      if (parsed === undefined) return undefined
      children.push(parsed)
    }
    return { handle, key, tagName, detail, current: record.current, children }
  }
  return visit(value, 0)
}
