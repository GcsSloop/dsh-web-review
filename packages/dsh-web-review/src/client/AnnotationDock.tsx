/**
 * Composer dock for annotating the desktop client's built-in Browser.
 *
 * The plugin owns no preview surface any more: the user browses in the host's
 * Browser tab, and this dock row is the whole annotation UI — an entry that arms
 * the picker on the visible Browser page, the acknowledged annotation capsule,
 * the Send action, and the host annotation editor as a sheet above the row.
 *
 * The page side runs the same bridge artifact the isolated transports use; the
 * controller in `browser-annotation.ts` owns that bridge and this component only
 * mirrors its events into store state and one editor transaction.
 */
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconCloseOutline16,
  IconNewChatOutline16,
  IconSendOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { MAX_ANNOTATIONS } from '../annotation-contract.ts'
import type {
  PreviewElementHandle,
  PreviewElementNavigationAction,
  PreviewElementTarget,
  PreviewTreeNode,
} from '../preview-contract.ts'
import { AnnotationEditor, type AnnotationEditorMode, type AnnotationEditorValue, type ElementNavigationFeedback } from './AnnotationEditor.tsx'
import {
  BrowserAnnotationSession,
  type BrowserIdleReason,
  type BrowserPage,
} from './browser-annotation.ts'
import type { BrowserGuestScan } from './webview-guest.ts'
import type { PickItem } from './contract.ts'
import { DraftOverlayBar, type WebviewDockProps } from './DraftOverlayBar.tsx'
import type { FloatingEditorSize } from './floating-position.ts'
import css from './AnnotationDock.module.css'

/** The sheet's smallest usable height. */
const MIN_SHEET_HEIGHT = 260
/** Height the sheet opens with before the user drags its top edge. */
const DEFAULT_SHEET_HEIGHT = 380
/** The sheet never covers more of the window than this. */
const MAX_SHEET_RATIO = 0.62

/** One open host editor transaction. */
interface EditorTransaction {
  id: string
  target: PreviewElementTarget
  existing: PickItem | null
  initialFocus: 'editor' | 'comment'
  originalHandle: PreviewElementHandle | null
  tree: PreviewTreeNode | null
  comment: string
  mode: AnnotationEditorMode
  navigationFeedback: ElementNavigationFeedback | null
  size: FloatingEditorSize | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** Stable pick id without depending on crypto.randomUUID availability. */
function pickId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function maxSheetHeight(): number {
  return typeof window === 'undefined'
    ? DEFAULT_SHEET_HEIGHT
    : Math.max(MIN_SHEET_HEIGHT, Math.round(window.innerHeight * MAX_SHEET_RATIO))
}

/**
 * Keep a broken dock visible.
 *
 * A throw inside the dock would otherwise unmount the whole cell without a trace
 * (this plugin has no console the user can inspect in the desktop shell), so the
 * row reports the failure in place and the composer keeps working.
 */
class DockBoundary extends Component<{ children: ReactNode; t: WebviewDockProps['t'] }, { message: string | null }> {
  override state = { message: null as string | null }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override render(): ReactNode {
    const { message } = this.state
    if (message === null) return this.props.children
    return (
      <div className={css.dock} data-webview-ui data-webview-browser-dock="" data-webview-dock-error="">
        <div className={css.error} role="alert">
          <IconWarningOutline16 size={14} className={css.errorIcon} />
          <span>{this.props.t('dock.dockError')}: {message}</span>
        </div>
      </div>
    )
  }
}

/**
 * The annotation dock: Browser entry, capsule, Send, and the editor sheet.
 *
 * The body sits inside {@link DockBoundary} so a render failure is reported in
 * the composer row instead of disappearing.
 */
export function AnnotationDock(props: WebviewDockProps): JSX.Element {
  return (
    <DockBoundary t={props.t}>
      <AnnotationDockBody {...props} />
    </DockBoundary>
  )
}

/** The dock's own render; see {@link AnnotationDock}. */
function AnnotationDockBody(props: WebviewDockProps) {
  const { useStore, actions, t, useInput, useSession, inputActions, sendAnnotationsWithoutDraft } = props
  const state = useStore(s => s)
  const input = useInput(s => s)
  const promptError = useSession(session => session.promptError)
  const [page, setPage] = useState<BrowserPage | null>(null)
  const [idleReason, setIdleReason] = useState<BrowserIdleReason>('no-guest')
  const [scanInfo, setScanInfo] = useState<{
    ticks: number
    guests: number
    webviews: number
    framed: number
    iframes: number
  }>({ ticks: 0, guests: 0, webviews: 0, framed: 0, iframes: 0 })
  const [failure, setFailure] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorTransaction | null>(null)
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null)
  const [sheetHeight, setSheetHeight] = useState(DEFAULT_SHEET_HEIGHT)
  const [sending, setSending] = useState(false)

  const sessionRef = useRef<BrowserAnnotationSession | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const pageRef = useRef(page)
  pageRef.current = page
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const tRef = useRef(t)
  tRef.current = t
  const editorRef = useRef(editor)
  editorRef.current = editor
  const navigationSequence = useRef(0)
  const handledPickResetRevision = useRef(state.pickResetRevision)
  const promptErrorAtSend = useRef(promptError)
  const onPickRef = useRef<(target: PreviewElementTarget) => void>(() => undefined)
  const onMarkClickRef = useRef<(id: string) => void>(() => undefined)
  const onShortcutRef = useRef<(action: PreviewElementNavigationAction) => void>(() => undefined)

  const closeEditor = (restore: boolean): void => {
    if (editorRef.current !== null && restore) sessionRef.current?.cancelEdit()
    setEditor(null)
  }

  const loadTree = (id: string, handle: PreviewElementHandle): void => {
    const session = sessionRef.current
    if (session === null) return
    void session.readTree(handle).then((tree) => {
      setEditor(current => current === null || current.id !== id || current.target.handle !== handle
        ? current
        : { ...current, tree })
    }).catch(() => undefined)
  }

  const openEditor = (
    id: string,
    target: PreviewElementTarget,
    existing: PickItem | null,
    initialFocus: EditorTransaction['initialFocus'] = 'editor',
  ): void => {
    const current = editorRef.current
    if (current !== null && current.id !== id) sessionRef.current?.cancelEdit()
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
      size: null,
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
    const session = sessionRef.current
    if (current === null || session === null) return
    const sequence = ++navigationSequence.current
    void session.navigateElement(current.target.handle, action).then((target) => {
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
    const session = sessionRef.current
    if (current === null || session === null) return
    const sequence = ++navigationSequence.current
    void session.selectElement(handle).then((target) => {
      if (target === null || sequence !== navigationSequence.current) return
      selectEditorTarget(target, comment, mode)
    }).catch(() => undefined)
  }

  const onMarkClick = (id: string): void => {
    const pick = stateRef.current.picks.find(current => current.id === id)
    const session = sessionRef.current
    if (pick === undefined || session === null) return
    void session.openPick(id, pick.snapshot.cssPath).then((target) => {
      if (target !== null) openEditor(id, target, pick)
    }).catch(() => undefined)
  }

  onPickRef.current = (target) => {
    if (stateRef.current.picks.length >= MAX_ANNOTATIONS) {
      actionsRef.current.setError(tRef.current('panel.pick.limit', { count: String(MAX_ANNOTATIONS) }))
      sessionRef.current?.cancelEdit()
      return
    }
    openEditor(pickId(), target, null, 'comment')
  }
  onMarkClickRef.current = onMarkClick
  onShortcutRef.current = (action) => {
    const current = editorRef.current
    if (current !== null) navigateEditorTarget(action, current.comment, current.mode)
  }

  // One session per mounted dock: it scans for a Browser page and, once armed,
  // owns that guest's bridge until the component unmounts.
  useEffect(() => {
    const session = new BrowserAnnotationSession({
      onPage: (next) => {
        setPage(next)
        if (next === null) {
          if (stateRef.current.pickMode) actionsRef.current.togglePickMode()
          return
        }
        setFailure(null)
        if (stateRef.current.url !== next.url) actionsRef.current.setUrl(next.url)
      },
      onIdle: (reason) => { setIdleReason(reason) },
      onScan: (scan: BrowserGuestScan) => {
        setScanInfo(current => ({
          ticks: current.ticks + 1,
          guests: scan.guests.length,
          webviews: scan.webviews,
          framed: scan.framed,
          iframes: scan.iframes,
        }))
      },
      onReady: (ready) => {
        setFailure(null)
        actionsRef.current.setError(null)
        if (ready.title !== '' && stateRef.current.title !== ready.title) {
          actionsRef.current.setTitle(ready.title)
        }
      },
      onPick: (target) => { onPickRef.current(target) },
      onCancelPick: () => {
        if (stateRef.current.pickMode) actionsRef.current.togglePickMode()
      },
      onMarkClick: (id) => { onMarkClickRef.current(id) },
      onTargetGeometry: (handle, rect, viewport) => {
        setEditor(current => current === null || current.target.handle !== handle
          ? current
          : { ...current, target: { ...current.target, rect, viewport } })
      },
      onShortcut: (action) => { onShortcutRef.current(action) },
      onHandoff: (next) => {
        // Page-side element handles belong to the document that just went away.
        // A reload of the same address keeps the picks (their markers re-anchor
        // by cssPath); navigating anywhere else retires them with the page.
        setEditor(null)
        if (next === null || pageRef.current === null || next.url !== pageRef.current.url) {
          actionsRef.current.clearPicks()
        }
      },
      onUnavailable: () => { setFailure(tRef.current('dock.bridge.unavailable')) },
      onFailure: (reason) => {
        setFailure(tRef.current(reason === 'no-page' ? 'dock.page.missing' : 'dock.bridge.injectFailed'))
        if (stateRef.current.pickMode) actionsRef.current.togglePickMode()
      },
    })
    sessionRef.current = session
    session.start()
    return () => {
      session.stop()
      sessionRef.current = null
    }
  }, [])

  // Arming the picker is what attaches the bridge; leaving the mode disarms the
  // page but keeps the bridge so the next arm is instant.
  useEffect(() => {
    const session = sessionRef.current
    if (session === null) return
    if (!state.pickMode) {
      session.deactivate()
      if (editorRef.current !== null) setEditor(null)
      return
    }
    setFailure(null)
    void session.activate().then(() => {
      if (!session.attached && stateRef.current.pickMode) actionsRef.current.togglePickMode()
    })
  }, [state.pickMode])

  // Numbered markers mirror the shared pick list; a reset or a removed pick also
  // discards the editor transaction that produced it.
  useEffect(() => {
    const ids = new Set(state.picks.map(pick => pick.id))
    const reset = handledPickResetRevision.current !== state.pickResetRevision
    handledPickResetRevision.current = state.pickResetRevision
    const current = editorRef.current
    if (current !== null && (reset || (current.existing !== null && !ids.has(current.id)))) {
      sessionRef.current?.cancelEdit()
      setEditor(null)
    }
    sessionRef.current?.setPicks(state.picks)
  }, [state.pickResetRevision, state.picks])

  // A dock detail row asks the page to select that pick again.
  useEffect(() => {
    const id = state.focusPickId
    if (id === null) return
    onMarkClick(id)
    actionsRef.current.setFocusPickId(null)
  }, [state.focusPickId])

  // The acknowledged drop of every pick is this dock's send-success edge.
  useEffect(() => {
    if (!sending || state.picks.length !== 0) return
    setSending(false)
    if (stateRef.current.pickMode) actionsRef.current.togglePickMode()
  }, [sending, state.picks.length])

  useEffect(() => {
    if (!sending || promptError === null || promptError === promptErrorAtSend.current) return
    setSending(false)
    actionsRef.current.setError(tRef.current('panel.pick.sendError'))
  }, [promptError, sending])

  const confirmEditor = (value: AnnotationEditorValue): void => {
    const current = editorRef.current
    if (current === null) return
    if (current.existing !== null && !stateRef.current.picks.some(pick => pick.id === current.id)) {
      sessionRef.current?.cancelEdit()
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
    sessionRef.current?.commitEdit(current.id, current.target.handle, value.changes, value.textChange)
    if (current.existing === null) actions.addPick(pick)
    else actions.updatePick(current.id, pick)
    setEditor(null)
  }

  const inputBusy = input.phase === 'adjudicating' || input.phase === 'submitting'
  const canSend = state.picks.length > 0
    && state.annotationSync.status === 'ready'
    && !sending
    && !inputBusy

  const submitAnnotations = async (): Promise<void> => {
    if (!canSend) return
    if (input.draft.trim().startsWith('/')) {
      actions.setError(t('panel.pick.slashDraft'))
      return
    }
    setSending(true)
    actions.setError(null)
    if (input.draft.trim() !== '') {
      // The stock input machine stays authoritative for drafts: submitting it
      // queues the user's own words, and the acknowledged snapshot rides the
      // same step.
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
      setSending(false)
    }
  }

  const syncError = state.annotationSync.status === 'error' ? state.annotationSync.message : null
  const visibleError = failure ?? syncError ?? state.error
  const annotateLabel = state.pickMode
    ? t('dock.annotate.off')
    : state.picks.length > 0 ? t('dock.annotate.resume') : t('dock.annotate')
  const resolvedSheetHeight = clamp(sheetHeight, MIN_SHEET_HEIGHT, maxSheetHeight())

  const showHint = page === null && state.picks.length === 0
  const hintText = idleReason === 'no-guest'
    ? t('dock.page.hint')
    : idleReason === 'not-visible' ? t('dock.page.hidden') : t('dock.page.unsupported')
  // Diagnostics for a dock that cannot find the Browser's page: the three
  // element counts separate "no guest element" from "guest marked differently"
  // from "the Web platform's cross-origin iframe".
  const scanLabel = `${t('dock.page.scan')} ${String(scanInfo.ticks)} · guest ${String(scanInfo.guests)}`
    + ` · webview ${String(scanInfo.webviews)} · frame ${String(scanInfo.framed)}`
    + ` · iframe ${String(scanInfo.iframes)}`

  return (
    <div
      className={css.dock}
      data-webview-ui
      data-webview-browser-dock=""
      data-webview-dock-state={showHint ? 'idle' : 'page'}
    >
      {visibleError !== null && (
        <div className={css.error} role="alert" title={visibleError} data-webview-error="">
          <IconWarningOutline16 size={14} className={css.errorIcon} />
          <span>{visibleError}</span>
        </div>
      )}
      <div className={css.row}>
        {page !== null && (
          <button
            type="button"
            className={clsx(css.entry, state.pickMode && css.entryActive)}
            aria-label={annotateLabel}
            aria-pressed={state.pickMode}
            title={annotateLabel}
            data-webview-annotate=""
            onClick={() => {
              setFailure(null)
              actions.setError(null)
              actions.togglePickMode()
            }}
          >
            {state.pickMode ? <IconCloseOutline16 size={14} /> : <IconNewChatOutline16 size={14} />}
            <span>{annotateLabel}</span>
          </button>
        )}
        {showHint && (
          <>
            <span
              className={css.hint}
            data-webview-annotation-hint=""
              data-idle-reason={idleReason}
              data-scan-ticks={scanInfo.ticks}
              data-scan-guests={scanInfo.guests}
              data-scan-webviews={scanInfo.webviews}
              data-scan-framed={scanInfo.framed}
              data-scan-iframes={scanInfo.iframes}
              title={hintText}
            >
              {hintText}
            </span>
          </>
        )}
        {state.pickMode && page !== null && (
          <span className={css.url} title={page.url} data-webview-annotation-page="">{page.url}</span>
        )}
        {state.pickMode && (
          <button
            type="button"
            className={css.icon}
            aria-label={t('panel.pick.clear')}
            title={t('panel.pick.clear')}
            disabled={state.picks.length === 0 || sending}
            onClick={() => { actions.clearPicks() }}
          >
            <IconTrashOutline16 size={14} />
          </button>
        )}
        <DraftOverlayBar {...props} inline />
        <span className={css.scan} data-webview-annotation-scan="">{scanLabel}</span>
        {state.picks.length > 0 && (
          <button
            type="button"
            className={css.send}
            disabled={!canSend}
            aria-label={`${t('panel.pick.send')} ${String(state.picks.length)}`}
            data-webview-annotation-send=""
            onClick={() => { void submitAnnotations() }}
          >
            <IconSendOutline16 size={14} />
            <span>{sending ? t('panel.pick.sending') : t('panel.pick.send')}</span>
            <span className={css.count} aria-hidden>{state.picks.length}</span>
          </button>
        )}
      </div>
      {editor !== null && (
        <div
          className={css.sheet}
          ref={setSheet}
          data-webview-annotation-sheet=""
          data-mode={editor.mode}
          style={{ height: `${String(resolvedSheetHeight)}px` }}
        >
          {sheet !== null && (
            <AnnotationEditor
              key={`${editor.id}:${editor.target.handle}`}
              id={editor.id}
              target={editor.target}
              tree={editor.tree}
              frame={sheet}
              comment={editor.comment}
              changes={editor.originalHandle === editor.target.handle ? editor.existing?.changes ?? [] : []}
              textChange={editor.originalHandle === editor.target.handle ? editor.existing?.textChange ?? null : null}
              initialMode={editor.mode}
              initialFocus={editor.initialFocus}
              navigationFeedback={editor.navigationFeedback}
              selectedSkills={state.selectedSkills}
              position={null}
              size={editor.size}
              docked
              dockMaxHeight={maxSheetHeight()}
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
                sessionRef.current?.previewStyle(editor.target.handle, property, value)
              }}
              onRestoreStyle={(property) => {
                sessionRef.current?.restoreStyle(editor.target.handle, property)
              }}
              onPreviewText={(value) => {
                sessionRef.current?.previewText(editor.target.handle, value)
              }}
              onRestoreText={() => {
                sessionRef.current?.restoreText(editor.target.handle)
              }}
              onSizeChange={(size) => {
                if (size !== null) setSheetHeight(size.height)
                setEditor(current => current === null ? null : { ...current, size })
              }}
              onModeChange={(mode) => {
                setEditor(current => current === null ? null : { ...current, mode })
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
