/**
 * dsh-web-review browser half: element annotation on the host's own Browser.
 *
 * The plugin owns no preview surface any more. The desktop client's built-in
 * Browser (an Electron `<webview>` guest) loads the page, and this plugin only
 * attaches its picker to that guest on demand, draws the host annotation
 * editor, and turns the picked elements into structured snapshots. The node
 * half still owns `/webview-annotations` (pending state) and serves the built
 * bridge artifact for injection; on the desktop it starts no preview session at
 * all for this path.
 *
 * Composition: one `conversation.input.dock` entry (id `webview-annotations`,
 * order 15) declaring the apply-constructed store handle. The dock row carries
 * the annotate entry, the acknowledged capsule, and Send; the editor opens as a
 * sheet above the composer. Admission of the acknowledged snapshot is unchanged:
 * the dock prepares it on the node face and `agent/pre-step` appends it to the
 * accepted message batch.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only service and standard-seat merges this plugin's client assembly uses.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the dock entry) without
// importing a value; the annotation surface rides the host's own Browser.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import {
  annotationSyncReceiptOf,
  type AnnotationSyncReceipt,
} from '../annotation-contract.ts'
import { PREVIEW_CLIENT_HEADER, PREVIEW_CLIENT_HEADER_VALUE } from '../preview-contract.ts'
import { en, zh, type WebviewKey } from './locales.ts'
import { createWebviewStore } from './stores.ts'
import { AnnotationDock } from './AnnotationDock.tsx'
import { type WebviewDockInjected } from './DraftOverlayBar.tsx'
import { normalizePreviewUrl } from './navigation-url.ts'
import { isUiSkillName, UI_SKILLS, type UiSkillName } from '../ui-skills.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Right Sidebar navigation controller; absent when the host package is unmounted. */
    sidebarRight?: { openTab: (kind: string, options?: { params?: Record<string, unknown> }) => void }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Browser annotation dock, capsule, and editor copy. */
    webview: WebviewKey
  }
  interface SlotMap {
    // rc.8 removed the conversation.chat.contextview chain slot; the
    // browser-comments context now declares the standard 'snapshot' form
    // (source.form + sections) rendered by the harness's ContextInjectionRow.
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'webview' as const

/** Required services (cordis fiber inject — activation waits on them). */
export const inject = ['slots', 'conversation', 'layout', 'locale', 'sessions', 'commandUi']

const SKILL_DESCRIPTION_KEYS: Record<UiSkillName, WebviewKey> = {
  'better-ui': 'editor.skills.betterUi',
  'better-typography': 'editor.skills.betterTypography',
  'better-layout': 'editor.skills.betterLayout',
  'better-writing': 'editor.skills.betterWriting',
  'better-accessibility': 'editor.skills.betterAccessibility',
  'better-colors': 'editor.skills.betterColors',
  'better-interface': 'editor.skills.betterInterface',
  'interface-review': 'editor.skills.interfaceReview',
}

function isClientSessions(value: unknown): value is ISessions {
  if (typeof value !== 'object' || value === null) return false
  try {
    return typeof Reflect.get(value, 'scope') === 'function'
  } catch {
    return false
  }
}

/** Resolve the public conversation face through one session scope. */
function scopedConversation(ctx: ClientContext, sessionId: SessionId): IConversation {
  // Harness declares a host SessionStore under the same Cordis service key;
  // verify the browser service shape before narrowing the merged type.
  const sessions: unknown = ctx.sessions
  if (!isClientSessions(sessions)) throw new Error('dsh-web-review: client sessions service unavailable')
  const scope = sessions.scope(sessionId)
  if (scope === undefined) throw new Error(`dsh-web-review: session "${sessionId}" resolved no scope`)
  const conversation = scope.get('conversation')
  if (conversation === undefined) throw new Error('dsh-web-review: conversation service unavailable through session scope')
  return conversation
}

/** Replace the active composer draft with one explicit Skill invocation. */
export function setUiSkillDraft(ctx: Pick<ClientContext, 'sessions'>, sessionId: SessionId, name: string): void {
  if (!isUiSkillName(name)) throw new Error(`unknown UI optimization Skill "${name}"`)
  const sessions = ctx.sessions as unknown as ISessions
  const sessionScope = sessions.scope(sessionId)
  if (sessionScope === undefined) throw new Error(`dsh-web-review: session "${sessionId}" resolved no scope`)
  const conversation = sessionScope.get('conversation')
  if (conversation === undefined) throw new Error('dsh-web-review: conversation service unavailable through session scope')
  conversation.input.for(sessionScope).setDraft(`/${name}`)
}
/**
 * Build one per-session annotation sync. Requests are queued in change order,
 * identical queued/acknowledged snapshots are deduplicated, and the returned
 * promise settles after the host has stored the pending snapshot.
 */
export function makeSyncAnnotations(sessionId: SessionId): WebviewDockInjected['syncAnnotations'] {
  let tail: Promise<void> = Promise.resolve()
  let lastAcknowledged: { body: string; receipt: AnnotationSyncReceipt } | undefined
  let lastScheduledBody: string | undefined
  let lastScheduledTask: Promise<AnnotationSyncReceipt> | undefined
  return (draft) => {
    const body = JSON.stringify({ sessionId, ...draft })
    const clearing = draft.comments.length === 0
    if (lastScheduledTask === undefined && body === lastAcknowledged?.body) {
      return Promise.resolve(lastAcknowledged.receipt)
    }
    if (body === lastScheduledBody && lastScheduledTask !== undefined) return lastScheduledTask
    const task = tail.catch(() => undefined).then(async () => {
      if (body === lastAcknowledged?.body) return lastAcknowledged.receipt
      const response = await fetch('/webview-annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      if (!response.ok) {
        // Clearing an absent live agent is already satisfied. The host keeps
        // returning 404 so this route cannot be used as a session-state oracle;
        // non-empty snapshots still surface the unavailable-agent failure.
        if (!(clearing && response.status === 404)) {
          throw new Error(`annotation context sync failed (${response.status})`)
        }
        const receipt = { kind: 'empty' as const }
        lastAcknowledged = { body, receipt }
        return receipt
      }
      const value: unknown = await response.json()
      const receipt = annotationSyncReceiptOf(value)
      if (receipt === undefined) throw new Error('annotation context sync returned an invalid receipt')
      lastAcknowledged = { body, receipt }
      return receipt
    })
    tail = task.then(() => undefined, () => undefined)
    lastScheduledBody = body
    lastScheduledTask = task
    task.then(
      () => {
        if (lastScheduledTask === task) {
          lastScheduledBody = undefined
          lastScheduledTask = undefined
        }
      },
      () => {
        if (lastScheduledTask === task) {
          lastScheduledBody = undefined
          lastScheduledTask = undefined
        }
      },
    )
    return task
  }
}

/**
 * Send one annotation message with its element captures attached.
 *
 * Images may only enter a user message through the composer's own draft-image
 * pipeline, so the captures are registered as draft images (`createDrafts`) and
 * handed to the public input actions, then submitted exactly like the composer
 * does. Returns false when this host does not expose that surface, so the caller
 * falls back to a text-only send (the captures still ride the plugin context).
 */
async function sendWithScreenshots(
  ctx: ClientContext,
  sessionId: SessionId,
  text: string,
  shots: readonly string[],
): Promise<boolean> {
  try {
    const scope = (ctx.sessions as unknown as { scope?: (id: SessionId) => { get(name: string): unknown } | undefined })
      .scope?.(sessionId)
    const conversation = scope?.get('conversation') as {
      createDrafts?: (id: SessionId, files: readonly File[]) => readonly { id: string }[]
    } | undefined
    if (conversation === undefined || typeof conversation.createDrafts !== 'function') return false
    const sessionInput = (scope?.get('conversation') as { input?: { for(scope: unknown): Record<string, unknown> } } | undefined)
      ?.input?.for(scope)
    const actions = sessionInput?.actions as
      | { setDraft(text: string): void; addAttachments(ids: readonly string[]): boolean; submit(): void }
      | undefined
    if (actions === undefined) return false
    const files = shots.map((shot, index) => {
      const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/u.exec(shot)
      const mediaType = match?.[1] ?? 'image/png'
      const payload = match?.[2] ?? shot
      const binary = atob(payload)
      const bytes = new Uint8Array(binary.length)
      for (let index2 = 0; index2 < binary.length; index2 += 1) bytes[index2] = binary.charCodeAt(index2)
      const extension = mediaType === 'image/jpeg' ? 'jpg' : 'png'
      return new File([bytes], `annotation-${String(index + 1)}.${extension}`, { type: mediaType })
    })
    const drafts = conversation.createDrafts(sessionId, files)
    if (drafts.length === 0) return false
    actions.setDraft(text)
    actions.addAttachments(drafts.map(draft => draft.id))
    actions.submit()
    return true
  } catch {
    return false
  }
}

/** The plugin body: dictionaries and the two shared-store registrations. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-review: dictionaries')

  // Registration-time text (the guide capsule) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration; components read the standard `t` seat instead.
  const t = ctx.locale.bind(NS)

  // Apply-time construction keeps store identity bound to this fiber; the dock
  // entry declares this one handle, so the shared pick list has one instance per
  // session.
  const webviewStore = createWebviewStore()

  // The right Sidebar's built-in Browser is the preview home now. This plugin
  // deliberately registers no page tab of its own: the annotation surface
  // attaches to the Browser's guest webview instead, and every entry point
  // (assistant links, the dock's open action) reveals that tab.
  void webviewStore

  ctx.inject(['commandUi'], (scope: ClientContext) => {
    // The reviewed alpha.5 types describe `description` as text and know nothing
    // of `label`/`searchMode`, while the 0.2.x menu builds its rows from `label`;
    // one contribution object carries both faces.
    const contribution = {
      name: 'skills',
      label: () => t('command.skills.label'),
      description: t('command.skills.description'),
      available: () => true,
      ui: {
        kind: 'popupSelect',
        searchMode: 'fuzzy-label',
        options: () => Promise.resolve(UI_SKILLS.map(skill => ({
          id: skill.name,
          label: skill.name,
          detail: t(SKILL_DESCRIPTION_KEYS[skill.name]),
        }))),
        onSelect: (option: { id: string }, context: unknown) => {
          // Hosts hand the popup either the session or a binding carrying it.
          const carrier = context as { sessionId?: SessionId; session?: { sessionId?: SessionId } } | undefined
          const sessionId = carrier?.sessionId ?? carrier?.session?.sessionId
          if (sessionId !== undefined) setUiSkillDraft(scope, sessionId, option.id)
        },
      },
    }
    scope.effect(
      () => scope.commandUi.register(contribution as Parameters<typeof scope.commandUi.register>[0]),
      'dsh-web-review: /skills contribution',
    )
  })

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'webview-annotations',
    order: 15,
    locale: NS,
    store: webviewStore,
    inject: (sessionId: SessionId, actions: BoundActions<typeof webviewStore>): WebviewDockInjected => ({
      syncAnnotations: makeSyncAnnotations(sessionId),
      openPreview: (url) => {
        const normalized = normalizePreviewUrl(url)
        if (normalized === undefined) return
        actions.setError(null)
        actions.setUrl(normalized)
        actions.setTitle('')
        actions.clearPicks()
        // 0.2.x no longer exposes the Details closer; a host without it must not
        // break the click that opened the page.
        ;(ctx.layout as { closeDetails?: () => void }).closeDetails?.()
        // The right Sidebar owns the preview: reveal (or open) the built-in
        // Browser tab, which navigates from the address recorded here.
        ctx.sidebarRight?.openTab('browser', { params: { url: normalized } })
      },
      // The stock input machine rejects an empty submit, so annotations without
      // a draft ask the session directly; a non-empty draft instead goes through
      // the composer's own submit action, which keeps serialization and queueing
      // stock behavior.
      // The dock composes the visible request from the annotations themselves; the
      // fixed sentence is only the fallback when it has nothing to say.
      sendAnnotationsWithoutDraft: async (prompt, shots) => {
        const text = prompt.trim() === '' ? t('panel.pick.defaultPrompt') : prompt
        if (shots.length > 0 && await sendWithScreenshots(ctx, sessionId, text, shots)) return
        await scopedConversation(ctx, sessionId).send(text)
      },
      // Poll the node's admitted-snapshot record: only a message the durable
      // session log actually kept may clear the annotations.
      awaitAnnotationAdmission: async (snapshotId) => {
        const query = `/webview-annotations?sessionId=${encodeURIComponent(String(sessionId))}`
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            const response = await fetch(query, {
              cache: 'no-store',
              headers: { [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE },
            })
            if (response.ok) {
              const value = await response.json() as { snapshotId?: unknown }
              if (value.snapshotId === snapshotId) return true
            }
          } catch { /* the next attempt retries */ }
          await new Promise(resolve => setTimeout(resolve, 400))
        }
        return false
      },
    }),
  }, AnnotationDock))
}
