// @vitest-environment jsdom
/**
 * Composer dock against the built-in Browser.
 *
 * The plugin's annotation surface is the dock row plus a host editor sheet: this
 * suite drives the real store, a fake Browser guest, and the served bridge source
 * stand-in, so it covers the whole loop the desktop client runs.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotSelectorHook, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AnnotationSyncReceipt } from '../src/annotation-contract.ts'
import { AnnotationSnapshotId } from '../src/annotation-contract.ts'
import { AnnotationDock } from '../src/client/AnnotationDock.tsx'
import type { WebviewDockInjected, WebviewDockProps } from '../src/client/DraftOverlayBar.tsx'
import { createWebviewStore, type WebviewState, type WebviewStore } from '../src/client/stores.ts'
import { zh, type WebviewKey } from '../src/client/locales.ts'
import { fakeTargetPayload, installFakeGuest, type FakeGuest } from './browser-annotation-fixture.ts'

const t: Translate<WebviewKey> = (key, params) => {
  const template = zh[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] as string | undefined) ?? match)
}

const BRIDGE_SOURCE = ';(() => { /* the built bridge artifact */ })()'
const HANDLE = 'a1b2c3d4e5f60718293a4b5c'

function hookFor(store: ReturnType<WebviewStore['create']>): SnapshotSelectorHook<WebviewState> {
  return (selector) => useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))
}

function chatHook(): WebviewDockProps['useChat'] {
  const snapshot = () => ({ order: [] as string[], nodes: { get: () => undefined } })
  return ((selector: (chat: unknown) => unknown) => selector(snapshot())) as WebviewDockProps['useChat']
}

function inputHook(draft = '') {
  const state = { draft, phase: 'idle' } as unknown as InputState
  return (selector: (value: InputState) => unknown) => selector(state)
}

function sessionHook() {
  const snapshot = { promptError: null } as unknown as SessionSnapshot
  return (selector: (value: SessionSnapshot) => unknown) => selector(snapshot)
}

function receiptOf(id: string): AnnotationSyncReceipt {
  return { kind: 'ready', snapshotId: AnnotationSnapshotId(id) }
}

function renderDock(options: { sync?: WebviewDockInjected['syncAnnotations'] } = {}) {
  const store = createWebviewStore().create()
  const submit = vi.fn()
  const sendAnnotationsWithoutDraft = vi.fn(async () => undefined)
  let sequence = 0
  const sync = options.sync ?? (async (draft: { comments: unknown[] }) => (
    draft.comments.length === 0 ? { kind: 'empty' as const } : receiptOf(`snapshot-${String(++sequence)}`)
  ))
  render(
    <AnnotationDock
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({} as any)}
      useStore={hookFor(store)}
      actions={store.actions}
      useChat={chatHook()}
      useInput={inputHook()}
      useSession={sessionHook()}
      inputActions={{ setDraft: vi.fn(), submit }}
      syncAnnotations={sync}
      openPreview={vi.fn()}
      sendAnnotationsWithoutDraft={sendAnnotationsWithoutDraft}
      sessionId={'session-1' as never}
      t={t}
    />,
  )
  return { store, submit, sendAnnotationsWithoutDraft }
}

async function armPicker(guest: FakeGuest): Promise<void> {
  const entry = await screen.findByRole('button', { name: zh['dock.annotate'] })
  fireEvent.click(entry)
  await waitFor(() => {
    expect(guest.received.some(message => (message.command as { name?: string } | undefined)?.name === 'activate')).toBe(true)
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(BRIDGE_SOURCE, {
    status: 200,
    headers: { 'content-type': 'text/javascript' },
  }))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('AnnotationDock', () => {
  it('offers the annotation entry only while a Browser page is visible', async () => {
    renderDock()
    await waitFor(() => { expect(document.querySelector('[data-webview-browser-dock]')).not.toBeNull() })
    expect(document.querySelector('[data-webview-annotate]')).toBeNull()
  })

  it('arms the picker on the visible guest when the entry is used', async () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/', title: 'Demo' })
    const { store } = renderDock()
    await armPicker(guest)
    expect(store.getSnapshot().pickMode).toBe(true)
    expect(store.getSnapshot().url).toBe('http://localhost:5173/')
    expect(screen.getByRole('button', { name: zh['dock.annotate.off'] })).toBeTruthy()
  })

  it('opens the host editor on a page pick and commits the comment into the pick list', async () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/', title: 'Demo' })
    const { store } = renderDock()
    await armPicker(guest)

    act(() => { guest.emit('pick', { target: fakeTargetPayload(HANDLE) }) })
    const editor = await waitFor(() => {
      const element = document.querySelector('[data-webview-annotation-editor]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })
    expect(editor.getAttribute('data-docked')).not.toBeNull()

    const input = screen.getByPlaceholderText(zh['editor.comment'])
    fireEvent.change(input, { target: { value: 'Make this button larger' } })
    fireEvent.click(screen.getByLabelText(zh['editor.confirm']))

    await waitFor(() => { expect(store.getSnapshot().picks).toHaveLength(1) })
    const [pick] = store.getSnapshot().picks
    expect(pick?.comment).toBe('Make this button larger')
    expect(pick?.snapshot.cssPath).toBe('#go')
    expect(guest.received.some(message => (message.command as { name?: string } | undefined)?.name === 'commit-edit')).toBe(true)
    await waitFor(() => { expect(document.querySelector('[data-webview-annotation-editor]')).toBeNull() })
  })

  it('sends annotations without a draft once the host acknowledged the snapshot', async () => {
    const guest = installFakeGuest({ url: 'http://localhost:5173/', title: 'Demo' })
    const { store, sendAnnotationsWithoutDraft } = renderDock()
    await armPicker(guest)
    act(() => { guest.emit('pick', { target: fakeTargetPayload(HANDLE) }) })
    await waitFor(() => { expect(document.querySelector('[data-webview-annotation-editor]')).not.toBeNull() })
    fireEvent.change(screen.getByPlaceholderText(zh['editor.comment']), { target: { value: 'Tighten the spacing' } })
    fireEvent.click(screen.getByLabelText(zh['editor.confirm']))
    await waitFor(() => { expect(store.getSnapshot().picks).toHaveLength(1) })

    const send = await waitFor(() => {
      const button = document.querySelector('[data-webview-annotation-send]') as HTMLButtonElement | null
      expect(button).not.toBeNull()
      expect(button?.disabled).toBe(false)
      return button as HTMLButtonElement
    })
    fireEvent.click(send)
    await waitFor(() => { expect(sendAnnotationsWithoutDraft).toHaveBeenCalledTimes(1) })
  })

  it('reports a failure and leaves annotation mode when there is nothing to attach', async () => {
    const { store } = renderDock()
    await waitFor(() => { expect(document.querySelector('[data-webview-browser-dock]')).not.toBeNull() })
    // The entry stays hidden without a page, so drive the mode directly the way
    // an accidental double activation would.
    act(() => { store.actions.togglePickMode() })
    await waitFor(() => { expect(store.getSnapshot().pickMode).toBe(false) })
  })
})
