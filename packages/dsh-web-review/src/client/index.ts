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
import { en, zh, type WebviewKey } from './locales.ts'
import { createWebviewStore } from './stores.ts'
import { AnnotationDock } from './AnnotationDock.tsx'
import { installSelfCheck, reportDiagnostics } from './self-check.ts'
import { type WebviewDockInjected } from './DraftOverlayBar.tsx'
import { normalizePreviewUrl } from './navigation-url.ts'
import { isUiSkillName, UI_SKILLS, type UiSkillName } from '../ui-skills.ts'

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

export { createPreviewSession, releasePreviewSessions } from './preview-session.ts'

/** The plugin body: dictionaries and the two shared-store registrations. */
export function apply(ctx: ClientContext): void {
  reportDiagnostics({ kind: 'apply', event: 'client-apply-start' })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-review: dictionaries')
  // TEMPORARY: a self-check badge outside React, until the Browser attachment is
  // verified on the real client. Remove with self-check.ts. Diagnostics must
  // never take the plugin down with them.
  ctx.effect(() => {
    try {
      return installSelfCheck()
    } catch (error) {
      console.error('[dsh-web-review] self-check unavailable', error)
      return () => undefined
    }
  }, 'dsh-web-review: self-check badge')

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
    scope.effect(() => scope.commandUi.register({
      name: 'skills',
      description: t('command.skills.description'),
      available: () => true,
      ui: {
        kind: 'popupSelect',
        options: () => Promise.resolve(UI_SKILLS.map(skill => ({
          id: skill.name,
          label: skill.name,
          detail: t(SKILL_DESCRIPTION_KEYS[skill.name]),
        }))),
        onSelect: (option, session) => {
          setUiSkillDraft(scope, session.sessionId, option.id)
        },
      },
    }), 'dsh-web-review: /skills contribution')
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
        ctx.layout.closeDetails()
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
      sendAnnotationsWithoutDraft: (prompt) => scopedConversation(ctx, sessionId).send(
        prompt.trim() === '' ? t('panel.pick.defaultPrompt') : prompt,
      ),
    }),
  }, AnnotationDock))
}
