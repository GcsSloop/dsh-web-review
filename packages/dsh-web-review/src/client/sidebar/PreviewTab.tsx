/**
 * Right-sidebar home for the preview surface.
 *
 * The right Sidebar is a host package: this plugin registers a tab type and its
 * body and the strip's guide then opens it. The host services are probed at
 * apply and never injected — an unsatisfied inject leaves the client fiber
 * pending, which fails the whole shell boot.
 */
import { useEffect, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PreviewSessionDescriptor, PreviewSessionMode } from '../../preview-contract.ts'
import type { WebviewKey } from '../locales.ts'
import { normalizePreviewUrl } from '../navigation-url.ts'
import { BrowserPreviewSurface } from '../browser-surface.ts'
import { createPreviewSession, releasePreviewSessions } from '../preview-session.ts'
import css from './PreviewTab.module.css'

/** Registry identity of this plugin's tab type. */
export const PREVIEW_TAB_ID = 'dsh-web-review/preview'
/** The kind `openTab` names to open this page type. */
export const PREVIEW_TAB_KIND = 'web-review-preview'
/** Locale namespace the host binds for this tab body. */
const PREVIEW_TAB_NS = 'webview'

interface GuideEntry {
  order: number
  title: () => string
  description?: () => string
}

interface TabDefinition {
  id: string
  kind: string
  title: () => string
  guide?: readonly GuideEntry[]
}

interface TabRegistryFace {
  register: (definition: TabDefinition) => () => void
}

interface SidebarRightFace {
  openTab: (kind: string, options?: { params?: Record<string, unknown> }) => void
}

interface PreviewTabInfo {
  tab: { navigation: { params: unknown } }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Right Sidebar tab-type registry; absent when the host package is unmounted. */
    sidebarRightTabs?: TabRegistryFace
    /** Right Sidebar navigation controller; absent when the host package is unmounted. */
    sidebarRight?: SidebarRightFace
  }
}

function paramUrl(params: unknown): string {
  if (typeof params !== 'object' || params === null) return ''
  const value = (params as { url?: unknown }).url
  return typeof value === 'string' ? value : ''
}

/**
 * Register the preview tab type and its body when the right Sidebar is mounted.
 * @param ctx - the client plugin context.
 * @param t - the bound translate function.
 * @returns the opener for this tab, or undefined when the host is absent.
 */
export function registerSidebarPreviewTab(
  ctx: ClientContext,
  t: (key: WebviewKey) => string,
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
    title: () => t('panel.frame'),
    guide: [{
      order: 40,
      title: () => t('panel.frame'),
      description: () => t('panel.noUrl'),
    }],
  }), 'dsh-web-review: sidebar preview tab type')
  ctx.effect(() => seats.inject('sidebar.right.pane.tab', () => seats.register({
    name: 'sidebar.right.pane.tab',
    key: PREVIEW_TAB_ID,
    locale: PREVIEW_TAB_NS,
  }, PreviewTabBody)), 'dsh-web-review: sidebar preview tab body')
}

/**
 * The tab body: a URL row over the live preview surface.
 *
 * `useTabInfo` arrives through the seat's declared inject; `t` comes from the
 * locale namespace the registration names.
 */
export function PreviewTabBody({
  useTabInfo,
  t,
}: {
  useTabInfo: () => PreviewTabInfo
  t: (key: WebviewKey) => string
}) {
  const info = useTabInfo()
  const requestedUrl = paramUrl(info.tab.navigation.params)
  const [draft, setDraft] = useState(requestedUrl)
  const [descriptor, setDescriptor] = useState<PreviewSessionDescriptor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [proxyFallback, setProxyFallback] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const surfaceRef = useRef<BrowserPreviewSurface | null>(null)
  const sessionRef = useRef<PreviewSessionDescriptor | null>(null)
  sessionRef.current = descriptor

  const open = async (value: string, mode: PreviewSessionMode): Promise<void> => {
    const normalized = normalizePreviewUrl(value)
    if (normalized === undefined) {
      setError(t('panel.urlInvalid'))
      return
    }
    setError(null)
    setLoading(true)
    try {
      const next = await createPreviewSession(normalized, mode)
      const previous = sessionRef.current
      sessionRef.current = next
      setDescriptor(next)
      setDraft(normalized)
      setProxyFallback(mode === 'proxy')
      if (previous !== null) void releasePreviewSessions([previous.sessionId]).catch(() => undefined)
    } catch (thrown) {
      if (mode === 'browser' && (thrown as { status?: number }).status === 503) {
        setProxyFallback(true)
        return await open(value, 'proxy')
      }
      setError(t('panel.previewUnavailable'))
    } finally {
      setLoading(false)
    }
  }

  // The tab records the URL it was opened with; a later navigation re-opens it.
  useEffect(() => {
    if (requestedUrl === '') return
    setDraft(requestedUrl)
    void open(requestedUrl, proxyFallback ? 'proxy' : 'browser')
    // `open` re-reads the live session through a ref, so the URL is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedUrl])

  useEffect(() => () => {
    const current = sessionRef.current
    sessionRef.current = null
    if (current !== null) void releasePreviewSessions([current.sessionId]).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (descriptor === null) return
    if (descriptor.mode === 'browser') {
      const canvas = canvasRef.current
      if (canvas === null) return
      const surface = new BrowserPreviewSurface(descriptor, {
        onState: (state) => {
          setLoading(state.loading)
          if (state.url !== '') setDraft(state.url)
        },
        onError: (message) => { setError(message) },
      })
      surfaceRef.current = surface
      const detach = surface.attach(canvas)
      return () => {
        detach()
        surface.dispose()
        surfaceRef.current = null
      }
    }
    const frame = frameRef.current
    if (frame === null) return
    frame.src = descriptor.frameUrl
  }, [descriptor])

  return (
    <div className={css.root} data-webview-sidebar-preview="">
      <form
        className={css.bar}
        onSubmit={(event) => {
          event.preventDefault()
          void open(draft, proxyFallback ? 'proxy' : 'browser')
        }}
      >
        <input
          className={css.input}
          value={draft}
          placeholder={t('panel.noUrl')}
          spellCheck={false}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button className={css.button} type="submit">↻</button>
      </form>
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      <div className={css.stage}>
        {descriptor === null
          ? <div className={css.notice}>{loading ? t('panel.loading') : t('panel.noUrl')}</div>
          : descriptor.mode === 'browser'
            ? <canvas ref={canvasRef} className={css.browserSurface} tabIndex={0} />
            : <iframe ref={frameRef} className={css.frame} src="about:blank" title={t('panel.frame')} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation" referrerPolicy="no-referrer" />}
      </div>
    </div>
  )
}
