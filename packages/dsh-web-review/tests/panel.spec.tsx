// @vitest-environment jsdom
/** Component behavior for the acknowledged annotation capsule. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotSelectorHook, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { WebviewDockProps } from '../src/client/DraftOverlayBar.tsx'
import {
  AnnotationSnapshotId,
  type AnnotationDraft,
  type AnnotationSyncReceipt,
} from '../src/annotation-contract.ts'
import { DraftOverlayBar, type WebviewDockInjected } from '../src/client/DraftOverlayBar.tsx'
import type { PickItem } from '../src/client/contract.ts'
import { zh, type WebviewKey } from '../src/client/locales.ts'
import { createWebviewStore, type WebviewState, type WebviewStore } from '../src/client/stores.ts'

const t: Translate<WebviewKey> = (key, params) => {
  const template = zh[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] as string | undefined) ?? match)
}

function hookFor(store: ReturnType<WebviewStore['create']>): SnapshotSelectorHook<WebviewState> {
  return (selector) => useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
}

/** Session lifecycle source (alpha.5 SessionSnapshot shape). */
function chatSource() {
  let order: string[] = []
  const nodes = new Map<string, { kind?: string; data?: { source?: unknown } }>()
  const listeners = new Set<() => void>()
  const snapshot = () => ({
    order,
    nodes: { get: (key: string) => nodes.get(key) },
  })
  const useChat: (selector: (chat: unknown) => unknown) => unknown = (selector) =>
    useSyncExternalStore(
      (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      () => selector(snapshot()),
    )
  return {
    useChat,
    appendHuman(seq: number) {
      const key = 'user-' + seq
      order = [...order, key]
      nodes.set(key, { kind: 'user', data: { source: { kind: 'user' } } })
      for (const listener of listeners) listener()
    },
    appendAnnotationContext(seq: number, snapshotId: string) {
      const key = 'context-' + seq
      order = [...order, key]
      nodes.set(key, {
        kind: 'context',
        data: { source: { kind: 'plugin', plugin: 'dsh-web-review', snapshotId } },
      })
      for (const listener of listeners) listener()
    },
  }
}

function pick(id = 'p1', comment = ''): PickItem {
  return {
    id,
    snapshot: {
      tagName: 'h1', id: '', className: 'hero-title', cssPath: 'h1.hero-title',
      fullPath: 'html > body > main > h1.hero-title',
      label: 'Example Domain', role: 'heading', stableClasses: ['hero-title'], anchor: null,
      inToolChrome: false,
      outerHTML: '<h1 class="hero-title">Example Domain</h1>', textContent: 'Example Domain',
      rect: { x: 0, y: 0, width: 100, height: 50 },
      computed: {
        display: 'block', position: 'static', fontSize: '32px', color: '#000',
        backgroundColor: '#fff', margin: '0px', padding: '8px', width: '100px', height: '50px',
      },
    },
    comment,
    changes: [], textChange: null, viewport: { width: 1280, height: 720 },
  }
}

function receipt(id: string): AnnotationSyncReceipt {
  return { kind: 'ready', snapshotId: AnnotationSnapshotId(id) }
}

function successfulSync(): WebviewDockInjected['syncAnnotations'] {
  let sequence = 0
  return async (draft) => draft.comments.length === 0
    ? { kind: 'empty' }
    : receipt(`snapshot-${String(++sequence)}`)
}

function deferredReceipt(): {
  promise: Promise<AnnotationSyncReceipt>
  resolve: (receipt: AnnotationSyncReceipt) => void
  reject: () => void
} {
  let resolve!: (receipt: AnnotationSyncReceipt) => void
  let reject!: () => void
  const promise = new Promise<AnnotationSyncReceipt>((yes, no) => {
    resolve = yes
    reject = () => { no(new Error('sync failed')) }
  })
  return { promise, resolve, reject }
}

/** Observe whether the plugin prevented a link while suppressing jsdom navigation afterward. */
function dispatchLink(link: HTMLAnchorElement, event: MouseEvent): boolean {
  let intercepted = false
  link.addEventListener('click', (candidate) => {
    intercepted = candidate.defaultPrevented
    candidate.preventDefault()
  }, { once: true })
  link.dispatchEvent(event)
  return intercepted
}

const storageValues = new Map<string, string>()
beforeEach(() => {
  storageValues.clear()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value) },
      removeItem: (key: string) => { storageValues.delete(key) },
      clear: () => { storageValues.clear() },
    },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })


function renderDock(
  sync: WebviewDockInjected['syncAnnotations'] = successfulSync(),
  useChat: (selector: (chat: unknown) => unknown) => unknown = chatSource().useChat,
  openPreview: WebviewDockInjected['openPreview'] = vi.fn(),
) {
  const store = createWebviewStore().create()
  render(
    <DraftOverlayBar
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({} as any)}
      useStore={hookFor(store)}
      actions={store.actions}
      useChat={useChat as unknown as WebviewDockProps['useChat']}
      syncAnnotations={sync}
      openPreview={openPreview}
      awaitAnnotationAdmission={async () => false}
      t={t}
    />,
  )
  return store
}

describe('DraftOverlayBar', () => {
  it('delegates assistant HTTP links to Preview and preserves other link gestures', () => {
    const openPreview = vi.fn()
    renderDock(undefined, undefined, openPreview)
    const assistant = document.createElement('div')
    assistant.dataset.chatFlowKind = 'assistant-step'
    const link = document.createElement('a')
    link.href = 'http://127.0.0.1:5173/review'
    assistant.appendChild(link)
    document.body.appendChild(assistant)

    expect(dispatchLink(link, new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true)
    expect(openPreview).toHaveBeenCalledWith('http://127.0.0.1:5173/review')
    expect(dispatchLink(link, new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))).toBe(false)

    const remoteLink = document.createElement('a')
    remoteLink.href = 'https://example.com/review'
    assistant.appendChild(remoteLink)
    expect(dispatchLink(remoteLink, new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true)
    expect(openPreview).toHaveBeenLastCalledWith('https://example.com/review')
    expect(openPreview).toHaveBeenCalledTimes(2)

    const user = document.createElement('div')
    user.dataset.chatFlowKind = 'user'
    const userLink = link.cloneNode() as HTMLAnchorElement
    user.appendChild(userLink)
    document.body.appendChild(user)
    expect(dispatchLink(userLink, new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false)
    expect(openPreview).toHaveBeenCalledTimes(2)
    assistant.remove()
    user.remove()
  })

  it('renders nothing for an initial empty state', async () => {
    renderDock()
    await waitFor(() => expect(document.querySelector('[data-webview-annotations]')).toBeNull())
  })

  it('sends structured evidence and reports syncing only until host acknowledgement', async () => {
    const pending = deferredReceipt()
    const sync = vi.fn<(_draft: AnnotationDraft) => Promise<AnnotationSyncReceipt>>()
      .mockResolvedValueOnce({ kind: 'empty' })
      .mockImplementation(() => pending.promise)
    const store = renderDock(sync)
    act(() => {
      store.actions.setUrl('http://localhost:5173/')
      store.actions.setTitle('Example Domain')
      store.actions.addPick(pick('p1', 'Make it smaller'))
    })
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    const sent = sync.mock.calls[1]?.[0]
    expect(sent).toMatchObject({
      page: { url: 'http://localhost:5173/', title: 'Example Domain' },
      comments: [{
        id: 'p1', comment: 'Make it smaller', role: 'heading', label: 'Example Domain',
        cssPath: 'h1.hero-title', fullPath: 'html > body > main > h1.hero-title',
      }],
    })
    expect(JSON.stringify(sent)).not.toContain('<annotation')
    expect(document.querySelector('[data-webview-annotation-capsule]')?.getAttribute('data-sync-status')).toBe('syncing')
    await act(async () => { pending.resolve(receipt('snapshot-evidence')); await pending.promise })
    await waitFor(() => {
      expect(document.querySelector('[data-webview-annotation-capsule]')?.getAttribute('data-sync-status')).toBe('synced')
    })
  })

  it('ignores unrelated human messages and clears only the matching durable annotation context', async () => {
    const session = chatSource()
    const sync = vi.fn<(_draft: AnnotationDraft) => Promise<AnnotationSyncReceipt>>(successfulSync())
    const store = renderDock(sync, session.useChat)
    act(() => {
      store.actions.setUrl('http://localhost:5173/')
      store.actions.addPick(pick('p1', 'Apply this change'))
    })
    await waitFor(() => expect(store.getSnapshot().annotationSync).toMatchObject({ status: 'ready' }))
    const current = store.getSnapshot().annotationSync
    if (current.status !== 'ready') throw new Error('annotation snapshot was not ready')

    act(() => { session.appendHuman(8) })
    expect(store.getSnapshot().picks).toHaveLength(1)
    act(() => { session.appendAnnotationContext(9, current.snapshotId) })
    await waitFor(() => expect(store.getSnapshot().picks).toHaveLength(0))
    await waitFor(() => expect(document.querySelector('[data-webview-annotations]')).toBeNull())
    expect(sync.mock.calls.at(-1)?.[0].comments).toEqual([])
  })

  it('does not let an older A acknowledgement clear a newer ready B snapshot', async () => {
    const session = chatSource()
    const sync = vi.fn<(_draft: AnnotationDraft) => Promise<AnnotationSyncReceipt>>(async (draft) => {
      const comment = draft.comments[0]?.comment
      if (comment === undefined) return { kind: 'empty' }
      return receipt(comment === 'A' ? 'snapshot-a' : 'snapshot-b')
    })
    const store = renderDock(sync, session.useChat)
    act(() => {
      store.actions.setUrl('http://localhost:5173/')
      store.actions.addPick(pick('p1', 'A'))
    })
    await waitFor(() => expect(store.getSnapshot().annotationSync).toMatchObject({
      status: 'ready', snapshotId: 'snapshot-a',
    }))
    act(() => { store.actions.updateComment('p1', 'B') })
    await waitFor(() => expect(store.getSnapshot().annotationSync).toMatchObject({
      status: 'ready', snapshotId: 'snapshot-b',
    }))

    act(() => { session.appendAnnotationContext(10, 'snapshot-a') })
    expect(store.getSnapshot().picks[0]?.comment).toBe('B')
    act(() => { session.appendAnnotationContext(11, 'snapshot-b') })
    await waitFor(() => expect(store.getSnapshot().picks).toHaveLength(0))
  })

  it('opens a rich detail card on hover/focus and hands row clicks to the preview', async () => {
    const store = renderDock()
    act(() => {
      store.actions.setUrl('http://localhost:5173/')
      store.actions.addPick(pick('p1', 'Make this heading smaller'))
    })
    const dock = await waitFor(() => document.querySelector('[data-webview-annotations]') as HTMLDivElement)
    fireEvent.mouseEnter(dock.firstElementChild as Element)
    const details = await waitFor(() => document.querySelector('[data-webview-annotation-details]') as HTMLDivElement)
    expect(details.textContent).toContain('heading')
    expect(details.textContent).toContain('Example Domain')
    expect(details.textContent).toContain('Make this heading smaller')
    expect(details.textContent).toContain('h1.hero-title')
    fireEvent.click(details.querySelector('[data-webview-annotation-row] button') as HTMLButtonElement)
    expect(store.getSnapshot().focusPickId).toBe('p1')
    expect(document.querySelector('[data-webview-annotation-details]')).toBeNull()

    const summary = document.querySelector('[data-webview-annotation-capsule] button') as HTMLButtonElement
    act(() => { summary.focus() })
    expect(document.querySelector('[data-webview-annotation-details]')).toBeTruthy()
    fireEvent.mouseLeave(dock.firstElementChild as Element)
    expect(document.querySelector('[data-webview-annotation-details]')).toBeTruthy()
    fireEvent.keyDown(dock.firstElementChild as Element, { key: 'Escape' })
    expect(document.querySelector('[data-webview-annotation-details]')).toBeNull()
  })

  it('supports per-item removal and keeps a clearing capsule until clear is acknowledged', async () => {
    const active = deferredReceipt()
    const changed = deferredReceipt()
    const clearing = deferredReceipt()
    const sync = vi.fn<(_draft: AnnotationDraft) => Promise<AnnotationSyncReceipt>>()
      .mockResolvedValueOnce({ kind: 'empty' })
      .mockImplementationOnce(() => active.promise)
      .mockImplementationOnce(() => changed.promise)
      .mockImplementationOnce(() => clearing.promise)
    const store = renderDock(sync)
    act(() => {
      store.actions.setUrl('http://localhost:5173/')
      store.actions.addPick(pick('p1', 'one'))
      store.actions.addPick(pick('p2', 'two'))
    })
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    await act(async () => { active.resolve(receipt('snapshot-active')); await active.promise })
    const dock = document.querySelector('[data-webview-annotations]') as HTMLDivElement
    fireEvent.mouseEnter(dock.firstElementChild as Element)
    const remove = await waitFor(() => document.querySelector('[data-webview-annotation-remove]') as HTMLButtonElement)
    fireEvent.click(remove)
    expect(store.getSnapshot().picks).toHaveLength(1)

    // The changed one-item snapshot is a separate commit; resolve it before clear.
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(3))
    await act(async () => { changed.resolve(receipt('snapshot-changed')); await changed.promise })
    const clear = screen.getByRole('button', { name: zh['dock.clear'] })
    fireEvent.click(clear)
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(4))
    expect(sync.mock.calls[3]?.[0]).toMatchObject({ comments: [] })
    expect(screen.getByText(zh['dock.clearing'])).toBeTruthy()
    await act(async () => { clearing.resolve({ kind: 'empty' }); await clearing.promise })
    await waitFor(() => expect(document.querySelector('[data-webview-annotations]')).toBeNull())
  })

  it('shows failures and retries the same snapshot on capsule click', async () => {
    const sync = vi.fn<(_draft: AnnotationDraft) => Promise<AnnotationSyncReceipt>>()
      .mockResolvedValueOnce({ kind: 'empty' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(receipt('snapshot-retry'))
    const store = renderDock(sync)
    act(() => {
      store.actions.setUrl('http://localhost:5173/')
      store.actions.addPick(pick('p1', 'one'))
    })
    await waitFor(() => expect(screen.getByText(zh['dock.sync.failed'])).toBeTruthy())
    expect(store.getSnapshot()).toMatchObject({
      annotationSync: { status: 'error', message: zh['dock.sync.error'] },
    })
    fireEvent.click(document.querySelector('[data-webview-annotation-capsule] button') as HTMLButtonElement)
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(store.getSnapshot().annotationSync).toMatchObject({ status: 'ready' }))
  })
})
