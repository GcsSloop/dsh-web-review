/**
 * Right-Sidebar home for the preview surface and its annotation loop.
 *
 * The right Sidebar is a host package: this plugin registers a tab type and its
 * body and the strip's guide then opens it. The host services are probed at
 * apply and never injected — an unsatisfied inject leaves the client fiber
 * pending, which fails the whole shell boot.
 *
 * The body owns the whole loop the conversation view used to own: transport
 * ladder (the shell's native panel, then a real Chromium over CDP, then the
 * isolated proxy), the exact-Origin bridge with its picker and markers, the
 * host annotation editor, and the URL row. It shares the plugin's per-session
 * store with the annotation dock, so the dock's capsule keeps committing the
 * structured snapshot and the stock composer keeps sending it.
 *
 * The editor is a bottom sheet rather than a floating card: a native shell panel
 * is a separate view the host DOM cannot paint over, and the pane is narrow, so
 * the pane splits into the page area and the sheet instead.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconNewChatOutline16,
  IconRefreshOutline16,
  IconRightUpOutline16,
  IconSendOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionSnapshotSelector } from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsStore, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { ANNOTATION_LIMITS, MAX_ANNOTATIONS } from '../../annotation-contract.ts'
import type {
  PreviewElementHandle,
  PreviewElementNavigationAction,
  PreviewElementTarget,
  PreviewSessionDescriptor,
  PreviewSessionId,
  PreviewSessionMode,
  PreviewTreeNode,
} from '../../preview-contract.ts'
import type { PickItem } from '../contract.ts'
import {
  AnnotationEditor,
  type AnnotationEditorMode,
  type AnnotationEditorValue,
  type ElementNavigationFeedback,
} from '../AnnotationEditor.tsx'
import { normalizePreviewUrl } from '../navigation-url.ts'
import { openExternalLink } from '../open-external.ts'
import type { WebviewStore } from '../stores.ts'
import type { FloatingEditorPosition, FloatingEditorSize } from '../floating-position.ts'
import { readEditorSize, writeEditorSize } from '../editor-size-memory.ts'
import {
  PreviewBridgeClient,
  iframeCarrier,
  type PreviewReadyState,
} from '../preview-bridge.ts'
import { BrowserPreviewSurface } from '../browser-surface.ts'
import { NativeBrowserSurface } from '../native-surface.ts'
import type { WebviewKey } from '../locales.ts'
import css from './PreviewTab.module.css'

/** Registry identity of this plugin's tab type. */
export const PREVIEW_TAB_ID = 'dsh-web-review/preview'
/** The kind `openTab` names to open this page type. */
export const PREVIEW_TAB_KIND = 'web-review-preview'
/**
 * Resource address prefix: one preview tab per page, like a browser's tabs.
 *
 * A *page* type deduplicates per pane — the host keeps exactly one tab for a
 * kind — so the preview is registered as a resource type instead, addressed by
 * the page it shows. Two different addresses are two tabs the user switches
 * between, and the same address reveals the tab already showing it.
 */
export const PREVIEW_ADDRESS_PREFIX = 'dsh-resource://web-review/'
/** Pages live in the address; the query keeps the readable part out of the path. */
export function previewAddressOf(url: string): string {
  return `${PREVIEW_ADDRESS_PREFIX}${encodeURIComponent(url)}`
}

/** The page a tab address names, when it is one of ours. */
export function previewUrlOfAddress(address: string): string {
  if (!address.startsWith(PREVIEW_ADDRESS_PREFIX)) return ''
  try {
    return decodeURIComponent(address.slice(PREVIEW_ADDRESS_PREFIX.length))
  } catch {
    return ''
  }
}

/** Chip label for one preview tab: what a browser tab would show. */
function previewTabTitle(address: string): string {
  const url = previewUrlOfAddress(address)
  if (url === '') return ''
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    const label = `${parsed.host}${path}`
    return label.length > 42 ? `${label.slice(0, 41)}…` : label
  } catch {
    return url.slice(0, 42)
  }
}
/** Locale namespace the host binds for this tab body. */
const PREVIEW_TAB_NS = 'webview'
/** The page keeps at least this much of the pane while the annotation sheet is open. */
const MIN_PAGE_HEIGHT = 140
/**
 * Attempts one address may spend on transport fallback.
 *
 * The ladder itself is bounded (three transports), and a page reload or a new
 * address resets the count; this only stops a failing chain from retrying
 * forever if some new trigger appears.
 */
const MAX_PREVIEW_ATTEMPTS = 6

/**
 * One live preview session per tab, held outside React.
 *
 * A tab body is unmounted whenever another tab becomes active, so releasing on
 * unmount would reload the page every time the user switched away and back. The
 * session (and, for the shell's panel, the page itself) stays alive here and a
 * remount re-attaches to it instead of opening a new one.
 */
const tabSessions = new Map<string, { descriptor: PreviewSessionDescriptor; url: string }>()

/**
 * Annotation lists per tab, and which tab currently owns the shared store's.
 *
 * Every preview tab of a session shares one store, so the visible tab lends its
 * picks to it and takes them back on the way out: comments made on one page
 * never appear on another page's markers, and the dock always describes the page
 * the user is actually looking at.
 */
const tabPicks = new Map<string, PickItem[]>()
let picksOwnerTab: string | null = null

/** Test-only hook: drop every cached tab session and annotation list. */
export function resetPreviewTabStateForTest(): void {
  tabSessions.clear()
  tabPicks.clear()
  picksOwnerTab = null
}

interface GuideEntry {
  order: number
  title: () => string
  description?: () => string
}

interface TabDefinition {
  id: string
  kind: string
  title: (address: string) => string
  patterns?: readonly string[]
  guide?: readonly GuideEntry[]
}

interface TabRegistryFace {
  register: (definition: TabDefinition) => () => void
}

interface SidebarRightFace {
  openTab: (kind: string, options?: { params?: Record<string, unknown> }) => void
  /** Present on hosts that own the right column's resource navigation. */
  openResource?: (address: string, options?: { revealIfOpened?: boolean }) => void
}

interface SidebarTabInfo {
  tab: {
    id?: unknown
    visible?: boolean
    navigation: { address?: unknown; params: unknown; revision: number }
  }
}

/** Session-bound actions the registration supplies to the tab body. */
export interface PreviewTabInjected {
  createPreviewSession: (target: string, mode?: PreviewSessionMode) => Promise<PreviewSessionDescriptor>
  releasePreviewSessions: (sessionIds: readonly PreviewSessionId[]) => Promise<void>
  sendAnnotationsWithoutDraft: () => Promise<void>
}

/** Store handle and inject face the tab type is registered with. */
export interface PreviewTabSeat {
  store: WebviewStore
  inject: (sessionId: SessionId) => PreviewTabInjected
}

/**
 * The framework's standard session seats, which every session-scope slot
 * receives at runtime. They are spelled out here rather than read from the
 * right Sidebar's own SlotMap entry: this plugin never imports the host package
 * that declares that seat.
 */
interface PreviewTabStandardProps {
  useInput: SnapshotSelectorHook<InputState>
  inputActions: InputActions
  useSession: SessionSnapshotSelector
}

/** Full composed props: standard seats + shared store + locale + tab hooks + inject. */
export type PreviewTabProps =
  & PreviewTabStandardProps
  & PropsStore<WebviewStore>
  & PropsLocale<'webview'>
  & PreviewTabInjected
  & { useTabInfo: () => SidebarTabInfo }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Right Sidebar tab-type registry; absent when the host package is unmounted. */
    sidebarRightTabs?: TabRegistryFace
    /** Right Sidebar navigation controller; absent when the host package is unmounted. */
    sidebarRight?: SidebarRightFace
  }
}

interface EditorSession {
  id: string
  target: PreviewElementTarget
  existing: PickItem | null
  initialFocus: 'editor' | 'comment'
  originalHandle: PreviewElementHandle | null
  tree: PreviewTreeNode | null
  comment: string
  mode: AnnotationEditorMode
  navigationFeedback: ElementNavigationFeedback | null
  position: FloatingEditorPosition | null
  size: FloatingEditorSize | null
}

function paramUrl(params: unknown): string {
  if (typeof params !== 'object' || params === null) return ''
  const value = (params as { url?: unknown }).url
  return typeof value === 'string' ? value : ''
}

function loadPreferredEditorSize(): FloatingEditorSize | null {
  try {
    return typeof window === 'undefined' ? null : readEditorSize(window.localStorage)
  } catch {
    return null
  }
}

function persistPreferredEditorSize(size: FloatingEditorSize): void {
  try {
    writeEditorSize(window.localStorage, size)
  } catch {
    // Access to profile storage can be disabled; in-memory memory still works.
  }
}

/** Stable pick id without depending on crypto.randomUUID availability. */
function pickId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** The sheet's height for one editor transaction: the pane's own, or the user's. */
function sheetHeight(editor: EditorSession, dockMaxHeight: number | undefined): number | null {
  if (editor.size === null || editor.mode === 'collapsed') return null
  const minimum = editor.mode === 'select' ? 240 : 300
  return clamp(editor.size.height, minimum, dockMaxHeight ?? Number.MAX_SAFE_INTEGER)
}

/** Track one element's rendered height without subscribing to layout thrash. */
function useMeasuredHeight(ref: { current: HTMLElement | null }): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (element === null || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => { setHeight(element.getBoundingClientRect().height) })
    observer.observe(element)
    setHeight(element.getBoundingClientRect().height)
    return () => { observer.disconnect() }
  }, [ref])
  return height
}

/**
 * Register the preview tab type and its body when the right Sidebar is mounted.
 * @param ctx - the client plugin context.
 * @param t - the bound translate function.
 * @param seat - the shared store handle and the session-bound inject face.
 * @returns the opener for this tab, or undefined when the host is absent.
 */
export function registerSidebarPreviewTab(
  ctx: ClientContext,
  t: (key: WebviewKey) => string,
  seat: PreviewTabSeat,
): void {
  try {
    registerPreviewTab(ctx, t, seat)
  } catch {
    // The right Sidebar is optional: a host that answers differently must never
    // take the preview view, dock, or shell boot down with it.
  }
}

function registerPreviewTab(
  ctx: ClientContext,
  t: (key: WebviewKey) => string,
  seat: PreviewTabSeat,
): void {
  const tabs = ctx.get('sidebarRightTabs')
  if (tabs === undefined || ctx.get('sidebarRight') === undefined) return
  // The keyed tab seat is declared by the host package, which this plugin does
  // not depend on: register through its runtime shape instead of importing it.
  const seats = ctx.slots as unknown as {
    inject: (name: string, callback: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  ctx.effect(() => tabs.register({
    id: PREVIEW_TAB_ID,
    kind: PREVIEW_TAB_KIND,
    // A resource type: the page lives in the address, so each page gets its own
    // tab and the strip behaves like a browser's.
    patterns: [`${PREVIEW_ADDRESS_PREFIX}**`],
    title: (address: string) => {
      const label = previewTabTitle(address)
      return label === '' ? t('panel.frame') : label
    },
    guide: [{
      order: 40,
      title: () => t('panel.frame'),
      description: () => t('panel.noUrl'),
    }],
  }), 'dsh-web-review: sidebar preview tab type')
  // One shared store handle across the tab, the dock, and (on a host that still
  // has it) any other preview home resolves to one instance per session: they
  // annotate one pick list.
  ctx.effect(() => seats.inject('sidebar.right.pane.tab', () => seats.register({
    name: 'sidebar.right.pane.tab',
    key: PREVIEW_TAB_ID,
    locale: PREVIEW_TAB_NS,
    store: seat.store,
    inject: seat.inject,
  }, PreviewTabBody)), 'dsh-web-review: sidebar preview tab body')
}

/**
 * The tab body: the URL row or annotation toolbar over the live preview surface
 * and its annotation sheet.
 *
 * `useTabInfo` arrives through the seat's declared inject; `t` comes from the
 * locale namespace the registration names.
 */
export function PreviewTabBody({
  useTabInfo,
  useStore,
  useInput,
  useSession,
  inputActions,
  actions,
  sendAnnotationsWithoutDraft,
  createPreviewSession,
  releasePreviewSessions,
  t,
}: PreviewTabProps) {
  const info = useTabInfo()
  const state = useStore((s) => s)
  const input = useInput(s => s)
  const promptError = useSession(session => session.promptError)
  const tabVisible = info.tab.visible !== false
  const tabAddress = typeof info.tab.navigation.address === 'string' ? info.tab.navigation.address : ''
  const requestedUrl = paramUrl(info.tab.navigation.params)
    || previewUrlOfAddress(tabAddress)
    // A tab opened before previews were addressed per page keeps the legacy page
    // address; it adopts the session's current page instead of going blank.
    || (tabAddress === `sidebar://${PREVIEW_TAB_KIND}` ? state.url : '')
  const tabKey = String(info.tab.id ?? 'preview')
  const mountedSession = tabSessions.get(tabKey)
  /** The page this body is showing; it also guards the store's own URL echo. */
  const loadedPageUrl = useRef<string | null>(mountedSession?.url ?? null)
  const [descriptor, setDescriptor] = useState<PreviewSessionDescriptor | null>(
    loadedPageUrl.current === null ? null : mountedSession?.descriptor ?? null,
  )
  /**
   * The address the current session was created for.
   *
   * `localUrl` is the tab's target; `loadedPageUrl` is whatever the page reports
   * (a login redirect moves it). Session creation keys on `localUrl` alone, so a
   * redirect must never touch it — otherwise the two race and the pane recreates
   * its session forever, flickering on "starting preview".
   */
  const targetRef = useRef('')
  /** The session the live surface belongs to; stale surfaces are ignored. */
  const activeSessionRef = useRef<string | null>(null)
  /**
   * The page this tab owns.
   *
   * Preview tabs of one session share a store, so its `url` can only describe
   * one tab at a time. Each tab therefore keeps its own address here and only
   * mirrors it into the store while it is the visible tab.
   */
  const [localUrl, setLocalUrl] = useState<string>(() => requestedUrl || loadedPageUrl.current || '')
  /** The address bar's own text; follows the page but not the shared store. */
  const [draft, setDraft] = useState<string>(() => requestedUrl || loadedPageUrl.current || '')
  const [error, setError] = useState<string | null>(null)
  /** Why the last attempt failed, shown as the error strip's tooltip. */
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** The transport and attempt in flight, shown next to the starting notice. */
  const [attemptLabel, setAttemptLabel] = useState('')
  /**
   * Transport preference: the shell's native panel first, then a real Chromium
   * over CDP, then the isolated proxy. Each 503 downgrades one step, so a
   * deployment missing either capability still previews.
   */
  const [preferredMode, setPreferredMode] = useState<PreviewSessionMode>('native')
  const [previewRequestRevision, setPreviewRequestRevision] = useState(0)
  const sessionRequest = useRef(0)
  const mounted = useRef(true)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const nativeRef = useRef<HTMLDivElement | null>(null)
  const nativeSurfaceRef = useRef<NativeBrowserSurface | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const surfaceRef = useRef<BrowserPreviewSurface | null>(null)
  const bridgeRef = useRef<PreviewBridgeClient | null>(null)
  /** Host-owned annotation editor transaction. */
  const [editor, setEditor] = useState<EditorSession | null>(null)
  const editorRef = useRef(editor)
  editorRef.current = editor
  const navigationSequence = useRef(0)
  const preferredEditorSize = useRef<FloatingEditorSize | null>(loadPreferredEditorSize())
  const handledPickResetRevision = useRef(state.pickResetRevision)
  /** The bridge has completed its exact-Origin handshake. */
  const [pickerReady, setPickerReady] = useState(false)
  const [historyState, setHistoryState] = useState({ canGoBack: false, canGoForward: false })
  /** Dedicated annotation submission state; the stock composer stays untouched. */
  const [sendingAnnotations, setSendingAnnotations] = useState(false)
  const promptErrorAtSend = useRef(promptError)
  const stateRef = useRef(state)
  stateRef.current = state
  /**
   * The injected create call and the translate seat arrive as fresh closures on
   * every render. Depending on them directly made the creation effect re-run
   * after each render — invalidating the attempt it had just started — so a
   * failing transport flickered "starting preview" forever without ever
   * adopting a session. The effect depends on the address and the mode only.
   */
  const createSessionRef = useRef(createPreviewSession)
  createSessionRef.current = createPreviewSession
  const translateRef = useRef(t)
  translateRef.current = t
  /** Attempts spent on the current address, so no failure can loop. */
  const attemptsRef = useRef({ key: '', count: 0 })
  const tabVisibleRef = useRef(true)
  tabVisibleRef.current = tabVisible
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const onPickRef = useRef<(target: PreviewElementTarget) => void>(() => undefined)
  const onMarkClickRef = useRef<(id: string) => void>(() => undefined)
  const onShortcutRef = useRef<(action: PreviewElementNavigationAction) => void>(() => undefined)
  /** Sessions this body already tried to replace once; a repeated failure is real. */
  const recoveredSessions = useRef(new Set<string>())

  const stageHeight = useMeasuredHeight(stageRef)
  const dockMaxHeight = stageHeight > 0
    ? Math.max(200, stageHeight - MIN_PAGE_HEIGHT)
    : undefined

  const release = (ids: readonly PreviewSessionId[]): void => {
    if (ids.length === 0) return
    void releasePreviewSessions(ids).catch(() => undefined)
  }

  /**
   * Forget one dead session and open a fresh one for the address it held.
   *
   * The host closes a panel whose client vanished, and a hard-killed shell leaves
   * sessions behind entirely; either way this body's cached descriptor is a
   * promise the host will not keep. Recovery is attempted once per session id so
   * a genuinely broken address fails visibly instead of reloading forever.
   */
  const replaceSession = (sessionId: string): void => {
    if (recoveredSessions.current.has(sessionId)) return
    recoveredSessions.current.add(sessionId)
    if (tabSessions.get(tabKey)?.descriptor.sessionId === sessionId) tabSessions.delete(tabKey)
    // Clearing the target is what lets the creation effect run again.
    targetRef.current = ''
    loadedPageUrl.current = null
    setDescriptor(null)
    setPreviewRequestRevision(value => value + 1)
  }

  const closeEditor = (restore: boolean): void => {
    if (editorRef.current !== null && restore) bridgeRef.current?.cancelEdit()
    else bridgeRef.current?.clearSelection()
    setEditor(null)
  }

  const loadTree = (id: string, handle: PreviewElementHandle): void => {
    const bridge = bridgeRef.current
    if (bridge === null) return
    void bridge.readTree(handle).then((tree) => {
      setEditor(current => current === null || current.id !== id || current.target.handle !== handle
        ? current
        : { ...current, tree })
    }).catch(() => undefined)
  }

  const openEditor = (
    id: string,
    target: PreviewElementTarget,
    existing: PickItem | null,
    initialFocus: EditorSession['initialFocus'] = 'editor',
  ): void => {
    const current = editorRef.current
    if (current !== null && current.id !== id) bridgeRef.current?.cancelEdit()
    setEditor({
      id,
      target,
      existing,
      initialFocus,
      originalHandle: existing === null ? null : target.handle,
      tree: null,
      comment: existing?.comment ?? '',
      mode: 'collapsed',
      navigationFeedback: null,
      position: null,
      size: preferredEditorSize.current,
    })
    loadTree(id, target.handle)
  }

  const selectEditorTarget = (
    target: PreviewElementTarget,
    comment: string,
    mode: AnnotationEditorMode,
    action?: PreviewElementNavigationAction,
  ): void => {
    const current = editorRef.current
    if (current === null || current.target.handle === target.handle) return
    if (action !== undefined) navigationSequence.current += 1
    setEditor({
      ...current,
      target,
      initialFocus: 'editor',
      tree: null,
      comment,
      mode,
      navigationFeedback: mode !== 'select' && action !== undefined
        ? { action, sequence: navigationSequence.current }
        : null,
    })
    loadTree(current.id, target.handle)
  }

  const navigateEditorTarget = (
    action: PreviewElementNavigationAction,
    comment: string,
    mode: AnnotationEditorMode,
  ): void => {
    const current = editorRef.current
    const bridge = bridgeRef.current
    if (current === null || bridge === null) return
    const sequence = ++navigationSequence.current
    void bridge.navigateElement(current.target.handle, action).then((target) => {
      if (target === null || sequence !== navigationSequence.current) return
      selectEditorTarget(target, comment, mode, action)
    }).catch(() => undefined)
  }

  const selectTreeTarget = (
    handle: PreviewElementHandle,
    comment: string,
    mode: AnnotationEditorMode,
  ): void => {
    const current = editorRef.current
    const bridge = bridgeRef.current
    if (current === null || bridge === null) return
    const sequence = ++navigationSequence.current
    void bridge.selectElement(handle).then((target) => {
      if (target === null || sequence !== navigationSequence.current) return
      selectEditorTarget(target, comment, mode)
    }).catch(() => undefined)
  }

  const onMarkClick = (id: string): void => {
    const pick = stateRef.current.picks.find((p) => p.id === id)
    const bridge = bridgeRef.current
    if (pick === undefined || bridge === null) return
    void bridge.openPick(id, pick.snapshot.cssPath).then((target) => {
      if (target !== null) openEditor(id, target, pick)
    }).catch(() => undefined)
  }

  onPickRef.current = (target) => {
    if (stateRef.current.picks.length >= MAX_ANNOTATIONS) {
      actionsRef.current.setError(t('panel.pick.limit', { count: String(MAX_ANNOTATIONS) }))
      bridgeRef.current?.cancelEdit()
      return
    }
    openEditor(pickId(), target, null, 'comment')
  }
  onMarkClickRef.current = onMarkClick
  onShortcutRef.current = (action) => {
    const current = editorRef.current
    if (current !== null) navigateEditorTarget(action, current.comment, current.mode)
  }

  // The dock records the address it wants opened before a tab has a page of its
  // own; a visible tab without one adopts that request. A tab already showing a
  // page keeps it, so one preview never steals another's address.
  useEffect(() => {
    if (!tabVisible || state.url === '' || localUrl !== '') return
    const normalized = normalizePreviewUrl(state.url)
    if (normalized === undefined) return
    setLocalUrl(normalized)
    setDraft(normalized)
  }, [state.url, tabVisible])

  // An opener that names a URL (the assistant-link delegation, the dock, the
  // guide) navigates this tab; the store URL is then the session's trigger, so
  // the tab and every other surface of this session agree on one address.
  useEffect(() => {
    if (requestedUrl === '') return
    const normalized = normalizePreviewUrl(requestedUrl)
    if (normalized === undefined || normalized === localUrl) return
    setLocalUrl(normalized)
    // Only the tab the user is looking at describes the session; a hidden tab
    // prepares its address and opens the session when it is shown.
    if (!tabVisible) return
    actions.setError(null)
    actions.setTitle('')
    actions.clearPicks()
    setErrorDetail(null)
    actions.setUrl(normalized)
  }, [requestedUrl, info.tab.navigation.revision, tabVisible])

  // Every tab prepares its own session up front; the surface reports invisible
  // bounds while the tab is hidden, which is what keeps one preview from
  // fighting another for the shell's single panel.
  useEffect(() => {
    if (localUrl === targetRef.current) return
    sessionRequest.current += 1
    const request = sessionRequest.current
    setPickerReady(false)
    setHistoryState({ canGoBack: false, canGoForward: false })
    setDescriptor(null)
    if (localUrl === '') {
      targetRef.current = ''
      loadedPageUrl.current = null
      setLoading(false)
      return
    }
    targetRef.current = localUrl
    const mode = preferredMode
    const attemptKey = `${localUrl}|${String(previewRequestRevision)}`
    if (attemptsRef.current.key !== attemptKey) attemptsRef.current = { key: attemptKey, count: 0 }
    attemptsRef.current.count += 1
    if (attemptsRef.current.count > MAX_PREVIEW_ATTEMPTS) {
      setLoading(false)
      setAttemptLabel('')
      setErrorDetail(`${mode} gave up after ${String(MAX_PREVIEW_ATTEMPTS)} attempts`)
      actionsRef.current.setError(translateRef.current('panel.previewUnavailable'))
      return
    }
    setAttemptLabel(`${mode} ${String(attemptsRef.current.count)}/${String(MAX_PREVIEW_ATTEMPTS)}`)
    setLoading(true)
    void createSessionRef.current(localUrl, mode).then((next) => {
      if (!mounted.current || request !== sessionRequest.current) {
        release([next.sessionId])
        return
      }
      setErrorDetail(null)
      const previous = tabSessions.get(tabKey)
      tabSessions.set(tabKey, { descriptor: next, url: localUrl })
      // A replaced session would otherwise linger as an idle panel until it expires.
      if (previous !== undefined && previous.descriptor.sessionId !== next.sessionId) {
        release([previous.descriptor.sessionId])
      }
      setDescriptor(next)
      setLoading(false)
      setAttemptLabel('')
    }).catch((thrown: unknown) => {
      setLoading(false)
      if (!mounted.current || request !== sessionRequest.current) return
      const status = (thrown as { status?: number }).status
      const timedOut = (thrown as { timedOut?: boolean }).timedOut === true
      if (status === 503 || timedOut) {
        // native -> browser -> proxy, one step per unavailable transport. The
        // target must be released here or the re-run this triggers would return
        // early and the pane would sit on "starting preview" forever.
        targetRef.current = ''
        loadedPageUrl.current = null
        if (mode === 'native') { setPreferredMode('browser'); setErrorDetail('native unavailable → browser'); return }
        if (mode === 'browser') { setPreferredMode('proxy'); setErrorDetail('browser unavailable → proxy'); return }
      }
      targetRef.current = ''
      loadedPageUrl.current = null
      const detail = `${mode} ${timedOut ? 'timed out' : String(status ?? 'failed')}`
      setErrorDetail(detail)
      actionsRef.current.setError(`${translateRef.current('panel.previewUnavailable')}（${detail}）`)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs above exist
    // exactly so the fresh closures of `createPreviewSession` and `t` cannot
    // re-run this effect.
  }, [localUrl, previewRequestRevision, preferredMode, tabKey])

  useEffect(() => {
    if (descriptor === null) return
    let bridge: PreviewBridgeClient | null = null
    const callbacks = {
      onReady: (ready: PreviewReadyState) => {
        // A page that redirects fires ready once per document; those are all the
        // same session, so they update the bar and never count as a navigation.
        if (activeSessionRef.current !== descriptor.sessionId) return
        setPickerReady(true)
        setHistoryState({ canGoBack: ready.canGoBack, canGoForward: ready.canGoForward })
        loadedPageUrl.current = ready.pageUrl
        setDraft(ready.pageUrl)
        // Only the tab the user is looking at describes the session: another
        // preview tab's page must not rewrite the dock's context.
        if (!tabVisibleRef.current) return
        actionsRef.current.setTitle(ready.title)
        if (stateRef.current.url !== ready.pageUrl) actionsRef.current.setUrl(ready.pageUrl)
        if (editorRef.current !== null) setEditor(null)
        bridge?.syncMarkers(stateRef.current.picks)
        if (stateRef.current.pickMode) bridge?.activate()
      },
      onPick: (target: PreviewElementTarget) => { onPickRef.current(target) },
      onCancelPick: () => {
        if (stateRef.current.pickMode) actionsRef.current.togglePickMode()
      },
      onMarkClick: (id: string) => { onMarkClickRef.current(id) },
      onTargetGeometry: (
        handle: PreviewElementHandle,
        rect: PreviewElementTarget['rect'],
        viewport: PreviewElementTarget['viewport'],
      ) => {
        setEditor(current => current === null || current.target.handle !== handle
          ? current
          : { ...current, target: { ...current.target, rect, viewport } })
      },
      onShortcut: (action: PreviewElementNavigationAction) => { onShortcutRef.current(action) },
      onHandoff: () => {
        setPickerReady(false)
        setHistoryState({ canGoBack: false, canGoForward: false })
        actionsRef.current.setTitle('')
        actionsRef.current.clearPicks()
        setEditor(null)
      },
      onUnavailable: () => {
        setPickerReady(false)
        actionsRef.current.setError(t('panel.previewUnavailable'))
      },
    }
    if (descriptor.mode === 'native') {
      const placeholder = nativeRef.current
      if (placeholder === null) return
      activeSessionRef.current = descriptor.sessionId
      const surface = new NativeBrowserSurface(descriptor, {
        onState: (nativeState) => {
          if (activeSessionRef.current !== descriptor.sessionId) return
          setHistoryState({ canGoBack: false, canGoForward: false })
          loadedPageUrl.current = nativeState.url
          if (nativeState.url !== '') setDraft(nativeState.url)
          if (tabVisibleRef.current) {
            actionsRef.current.setTitle(nativeState.title)
            if (stateRef.current.url !== nativeState.url) actionsRef.current.setUrl(nativeState.url)
          }
          if (!nativeState.loading) bridge?.frameLoaded()
        },
        onError: (message) => { setError(message) },
        // The host refused a request because this session is gone: rebuild it,
        // once per session id, so a parked or expired panel comes back instead
        // of leaving an empty rectangle behind.
        onSessionLost: () => { replaceSession(descriptor.sessionId) },
      })
      nativeSurfaceRef.current = surface
      surface.setVisible(tabVisibleRef.current)
      bridge = new PreviewBridgeClient(surface.carrier(), descriptor, callbacks)
      bridgeRef.current = bridge
      const detach = surface.attach(placeholder)
      bridge.frameLoaded()
      return () => {
        if (bridgeRef.current === bridge) bridgeRef.current = null
        if (activeSessionRef.current === descriptor.sessionId) activeSessionRef.current = null
        release(bridge?.dispose() ?? [])
        detach()
        surface.dispose()
        if (nativeSurfaceRef.current === surface) nativeSurfaceRef.current = null
      }
    }
    if (descriptor.mode === 'browser') {
      const canvas = canvasRef.current
      if (canvas === null) return
      activeSessionRef.current = descriptor.sessionId
      const surface = new BrowserPreviewSurface(descriptor, {
        onState: (browserState) => {
          if (activeSessionRef.current !== descriptor.sessionId) return
          // The real browser reports its own address and title, so the toolbar
          // follows the page without a bridge hop.
          setHistoryState({ canGoBack: false, canGoForward: false })
          loadedPageUrl.current = browserState.url
          if (browserState.url !== '') setDraft(browserState.url)
          if (tabVisibleRef.current) {
            actionsRef.current.setTitle(browserState.title)
            if (stateRef.current.url !== browserState.url) actionsRef.current.setUrl(browserState.url)
          }
          // A finished load may be the injected bridge's first chance to answer.
          if (!browserState.loading) bridge?.frameLoaded()
        },
        onError: (message) => { setError(message) },
      })
      surfaceRef.current = surface
      bridge = new PreviewBridgeClient(surface.carrier(), descriptor, callbacks)
      bridgeRef.current = bridge
      const detach = surface.attach(canvas)
      bridge.frameLoaded()
      return () => {
        if (bridgeRef.current === bridge) bridgeRef.current = null
        if (activeSessionRef.current === descriptor.sessionId) activeSessionRef.current = null
        release(bridge?.dispose() ?? [])
        detach()
        surface.dispose()
        if (surfaceRef.current === surface) surfaceRef.current = null
      }
    }
    const frame = frameRef.current
    if (frame === null) return
    activeSessionRef.current = descriptor.sessionId
    bridge = new PreviewBridgeClient(iframeCarrier(frame), descriptor, callbacks)
    bridgeRef.current = bridge
    // Arm the exact-source/exact-Origin listener before starting navigation:
    // an initial response that immediately crosses target Origins must not post
    // its short-lived handoff before the parent knows the next descriptor.
    frame.src = descriptor.frameUrl
    return () => {
      if (bridgeRef.current === bridge) bridgeRef.current = null
      if (activeSessionRef.current === descriptor.sessionId) activeSessionRef.current = null
      release(bridge?.dispose() ?? [])
    }
    // `tabKey` and the surfaces' refs are read through refs and stable ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descriptor, releasePreviewSessions, t])

  useEffect(() => () => {
    mounted.current = false
    sessionRequest.current += 1
  }, [])

  // A tab body stays mounted while another tab is active: keep the native panel
  // in step with this tab so it never floats over the tab the user switched to.
  useEffect(() => {
    nativeSurfaceRef.current?.setVisible(tabVisible)
  }, [tabVisible])

  // Hand the shared annotation list over on a tab change, and take it back on
  // return: each preview tab keeps its own comments.
  useEffect(() => {
    if (!tabVisible) {
      if (picksOwnerTab === tabKey) {
        tabPicks.set(tabKey, stateRef.current.picks)
        picksOwnerTab = null
      }
      return
    }
    if (picksOwnerTab !== tabKey) {
      if (picksOwnerTab !== null) tabPicks.set(picksOwnerTab, stateRef.current.picks)
      picksOwnerTab = tabKey
      actionsRef.current.setPicks(tabPicks.get(tabKey) ?? [])
      // The dock must describe the page this tab shows, not the one it replaced.
      const pageUrl = loadedPageUrl.current ?? (localUrl !== '' ? localUrl : null)
      if (pageUrl !== null && pageUrl !== '' && stateRef.current.url !== pageUrl) {
        actionsRef.current.setUrl(pageUrl)
      }
    }
  }, [tabVisible, tabKey])

  // A hidden tab keeps its page alive but owns no markers on screen.
  useEffect(() => {
    bridgeRef.current?.syncMarkers(tabVisible ? stateRef.current.picks : [])
  }, [tabVisible])

  const onFrameLoad = (): void => { bridgeRef.current?.frameLoaded() }

  useEffect(() => {
    const bridge = bridgeRef.current
    if (bridge === null) return
    if (state.pickMode && tabVisibleRef.current) bridge.activate()
    if (!state.pickMode) {
      bridge.deactivate()
      if (editorRef.current !== null) closeEditor(true)
    }
  }, [state.pickMode])

  useEffect(() => {
    const ids = new Set(state.picks.map(pick => pick.id))
    const reset = handledPickResetRevision.current !== state.pickResetRevision
    handledPickResetRevision.current = state.pickResetRevision
    const current = editorRef.current
    if (current !== null && (reset || (current.existing !== null && !ids.has(current.id)))) {
      bridgeRef.current?.cancelEdit()
      setEditor(null)
    }
    if (tabVisibleRef.current) bridgeRef.current?.syncMarkers(state.picks)
  }, [state.pickResetRevision, state.picks])

  useEffect(() => {
    const id = state.focusPickId
    if (id === null) return
    onMarkClick(id)
    actionsRef.current.setFocusPickId(null)
  }, [state.focusPickId])

  // The dock consumes only a matching durable plugin-context id and then
  // clears the picks. That exact store transition is this body's success edge.
  useEffect(() => {
    if (!sendingAnnotations || state.picks.length !== 0) return
    setSendingAnnotations(false)
    if (stateRef.current.pickMode) actionsRef.current.togglePickMode()
  }, [sendingAnnotations, state.picks.length])

  // Prompt failures stay on the stock session surface; mirror a concise
  // Preview error and keep the annotation state retryable.
  useEffect(() => {
    if (!sendingAnnotations || promptError === null || promptError === promptErrorAtSend.current) return
    setSendingAnnotations(false)
    actionsRef.current.setError(t('panel.pick.sendError'))
  }, [promptError, sendingAnnotations, t])

  /** Navigate to `url`; a new page invalidates the previous picks. */
  const navigate = (url: string): void => {
    const normalized = normalizePreviewUrl(url)
    if (normalized === undefined || normalized.length > ANNOTATION_LIMITS.pageUrl) {
      actions.setError(t('panel.urlInvalid'))
      return
    }
    if (normalized === targetRef.current) {
      // The same address is a reload, not a new session.
      bridgeRef.current?.reload()
      return
    }
    setLocalUrl(normalized)
    setDraft(normalized)
    setHistoryState({ canGoBack: false, canGoForward: false })
    setPreviewRequestRevision(value => value + 1)
    if (tabVisible) {
      actions.setError(null)
      actions.setTitle('')
      actions.clearPicks()
      actions.setUrl(normalized)
    }
  }

  const surfaceElement: HTMLElement | null = descriptor?.mode === 'native'
    ? nativeRef.current
    : descriptor?.mode === 'browser' ? canvasRef.current : frameRef.current
  /** The desktop shell renders this preview in its own panel. */
  const shellHosted = descriptor?.mode === 'native'
  const pickDisabled = !pickerReady || localUrl === ''
  const visibleError = state.annotationSync.status === 'error' ? state.annotationSync.message : state.error ?? error
  const inputBusy = input.phase === 'adjudicating' || input.phase === 'submitting'
  const canSendAnnotations = state.picks.length > 0
    && state.annotationSync.status === 'ready'
    && !sendingAnnotations
    && !inputBusy
  const editorFrame = surfaceElement ?? stageRef.current
  const resolvedSheetHeight = editor === null ? null : sheetHeight(editor, dockMaxHeight)

  const submitAnnotations = async (): Promise<void> => {
    if (!canSendAnnotations) return
    if (input.draft.trim().startsWith('/')) {
      actions.setError(t('panel.pick.slashDraft'))
      return
    }
    setSendingAnnotations(true)
    actions.setError(null)
    if (input.draft.trim() !== '') {
      // The stock input machine stays authoritative for drafts: submitting it
      // is what queues the user's own words, and the dock's acknowledged
      // snapshot rides the same step.
      promptErrorAtSend.current = promptError
      inputActions.submit()
      return
    }
    try {
      await sendAnnotationsWithoutDraft()
      if (stateRef.current.pickMode) actionsRef.current.togglePickMode()
    } catch {
      actions.setError(t('panel.pick.sendError'))
    } finally {
      setSendingAnnotations(false)
    }
  }

  const confirmEditor = (value: AnnotationEditorValue): void => {
    const current = editorRef.current
    if (current === null) return
    if (current.existing !== null && !stateRef.current.picks.some(pick => pick.id === current.id)) {
      bridgeRef.current?.cancelEdit()
      setEditor(null)
      return
    }
    const pick: PickItem = {
      id: current.id,
      snapshot: current.originalHandle === current.target.handle && current.existing !== null
        ? current.existing.snapshot
        : current.target.snapshot,
      comment: value.comment,
      changes: value.changes,
      textChange: value.textChange,
      viewport: value.viewport,
    }
    bridgeRef.current?.commitEdit(current.id, current.target.handle, value.changes, value.textChange)
    if (current.existing === null) actions.addPick(pick)
    else actions.updatePick(current.id, pick)
    setEditor(null)
  }

  return (
    <div className={css.panel} data-webview-ui data-webview-sidebar-preview="">
      {state.pickMode
        ? (
          <div className={css.annotationBar} data-webview-annotation-toolbar="">
            <button
              type="button"
              className={css.annotationIcon}
              aria-label={t('panel.pick.off')}
              title={t('panel.pick.off')}
              onClick={() => { actions.togglePickMode() }}
            >
              <IconCloseOutline16 size={16} />
            </button>
            <button
              type="button"
              className={css.annotationIcon}
              aria-label={t('panel.pick.clear')}
              title={t('panel.pick.clear')}
              disabled={state.picks.length === 0 || sendingAnnotations}
              onClick={() => { actions.clearPicks() }}
            >
              <IconTrashOutline16 size={16} />
            </button>
            <div className={css.annotationTitle} title={localUrl || state.url}>
              {t('panel.pick.active', { url: localUrl || state.url })}
            </div>
            <button
              type="button"
              className={css.annotationSend}
              disabled={!canSendAnnotations}
              aria-label={`${t('panel.pick.send')} ${String(state.picks.length)}`}
              onClick={() => { void submitAnnotations() }}
            >
              <IconSendOutline16 size={14} />
              <span>{sendingAnnotations ? t('panel.pick.sending') : t('panel.pick.send')}</span>
              <span className={css.annotationCount} aria-hidden>({state.picks.length})</span>
            </button>
          </div>
        )
        : (
          <div className={css.urlRow}>
            <button
              type="button"
              className={css.icon}
              aria-label={t('panel.back')}
              title={t('panel.back')}
              disabled={!historyState.canGoBack}
              onClick={() => { bridgeRef.current?.historyBack() }}
            >
              <IconChevronLeftOutline14 size={16} />
            </button>
            <button
              type="button"
              className={css.icon}
              aria-label={t('panel.forward')}
              title={t('panel.forward')}
              disabled={!historyState.canGoForward}
              onClick={() => { bridgeRef.current?.historyForward() }}
            >
              <IconChevronRightOutline14 size={16} />
            </button>
            <button
              type="button"
              className={css.icon}
              aria-label={t('panel.refresh')}
              title={t('panel.refresh')}
              disabled={localUrl === ''}
              onClick={() => { bridgeRef.current?.reload() }}
            >
              <IconRefreshOutline16 size={16} />
            </button>
            <div className={css.urlField}>
              <Input
                className={css.url ?? ''}
                value={draft}
                maxLength={ANNOTATION_LIMITS.pageUrl}
                placeholder={t('panel.urlPlaceholder')}
                onChange={(e) => { setDraft(e.target.value) }}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(draft) }}
                spellCheck={false}
              />
              {localUrl !== '' && (
                <a
                  className={css.inlineAction}
                  href={localUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('panel.external')}
                  title={t('panel.external')}
                  onClick={(event) => {
                    // The shell's panel has no browser tab to land in: ask the
                    // shell for the system browser, and keep the ordinary
                    // new-tab path anywhere else.
                    if (!shellHosted) return
                    event.preventDefault()
                    void openExternalLink(localUrl).then((opened) => {
                      if (!opened) window.open(localUrl, '_blank', 'noopener,noreferrer')
                    })
                  }}
                >
                  <IconRightUpOutline16 size={12} />
                </a>
              )}
            </div>
            <button
              type="button"
              className={clsx(css.icon, css.commentIcon)}
              aria-label={t('panel.pick')}
              title={t('panel.pick')}
              disabled={pickDisabled}
              onClick={() => { actions.togglePickMode() }}
            >
              <IconNewChatOutline16 size={16} />
            </button>
          </div>
        )}
      {visibleError !== null && (
        <div className={css.error} role="alert" title={errorDetail ?? visibleError} data-webview-error="">
          <IconWarningOutline16 size={14} className={css.errorIcon} />
          <span>{visibleError}</span>
        </div>
      )}
      <div className={css.stage} ref={stageRef}>
        <div className={css.page}>
          {descriptor === null
            ? (
              <>
                <div className={css.notice}>{loading ? `${t('panel.loading')}${attemptLabel === '' ? '' : `（${attemptLabel}）`}` : t('panel.noUrl')}</div>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#a0a4ab', padding: '0 12px' }}>
                  diag visible={String(tabVisible)} localUrl={JSON.stringify(localUrl)} draft={JSON.stringify(draft)} loading={String(loading)} attempt={attemptLabel || '—'}
                </div>
              </>
            )
            : descriptor.mode === 'native'
              ? <div ref={nativeRef} className={css.nativeSurface} data-webview-native-surface="" />
              : descriptor.mode === 'browser'
                ? <canvas ref={canvasRef} className={css.browserSurface} tabIndex={0} data-webview-browser-surface="" />
                : (
                  <iframe
                    ref={frameRef}
                    className={css.frame}
                    src="about:blank"
                    title={t('panel.frame')}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation"
                    referrerPolicy="no-referrer"
                    onLoad={onFrameLoad}
                  />
                )}
        </div>
        {editor !== null && editorFrame !== null && (
          <div
            className={css.sheet}
            data-webview-annotation-sheet=""
            data-mode={editor.mode}
            style={resolvedSheetHeight === null ? undefined : { height: `${String(resolvedSheetHeight)}px` }}
          >
            <AnnotationEditor
              key={`${editor.id}:${editor.target.handle}`}
              id={editor.id}
              target={editor.target}
              tree={editor.tree}
              frame={editorFrame}
              comment={editor.comment}
              changes={editor.originalHandle === editor.target.handle ? editor.existing?.changes ?? [] : []}
              textChange={editor.originalHandle === editor.target.handle ? editor.existing?.textChange ?? null : null}
              initialMode={editor.mode}
              initialFocus={editor.initialFocus}
              navigationFeedback={editor.navigationFeedback}
              selectedSkills={state.selectedSkills}
              position={editor.position}
              size={editor.size}
              docked
              {...(dockMaxHeight === undefined ? {} : { dockMaxHeight })}
              t={t}
              onCommentChange={(comment) => {
                setEditor(current => current === null ? null : { ...current, comment })
              }}
              onCancel={() => { closeEditor(true) }}
              onConfirm={confirmEditor}
              onToggleSkill={actions.toggleSelectedSkill}
              onNavigateTarget={navigateEditorTarget}
              onSelectTarget={selectTreeTarget}
              onPreviewStyle={(property, value) => {
                bridgeRef.current?.previewStyle(editor.target.handle, property, value)
              }}
              onRestoreStyle={(property) => {
                bridgeRef.current?.restoreStyle(editor.target.handle, property)
              }}
              onPreviewText={(value) => {
                bridgeRef.current?.previewText(editor.target.handle, value)
              }}
              onRestoreText={() => {
                bridgeRef.current?.restoreText(editor.target.handle)
              }}
              onPositionChange={(position) => {
                setEditor(current => current === null ? null : { ...current, position })
              }}
              onSizeChange={(size) => {
                setEditor(current => current === null ? null : { ...current, size })
              }}
              onModeChange={(mode) => {
                // The sheet's own height follows the mode until the user drags it.
                setEditor(current => current === null ? null : { ...current, mode })
              }}
              onSizeCommit={(size) => {
                preferredEditorSize.current = size
                persistPreferredEditorSize(size)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
