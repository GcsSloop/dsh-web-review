/**
 * Preview session transport calls shared by the preview view and the optional
 * right-sidebar tab, kept out of the registration module so neither imports the
 * other in a cycle.
 */
import {
  PREVIEW_CLIENT_HEADER,
  PREVIEW_CLIENT_HEADER_VALUE,
  PREVIEW_SESSIONS_PATH,
  previewSessionDescriptorOf,
  type PreviewSessionDescriptor,
  type PreviewSessionId,
  type PreviewSessionMode,
} from '../preview-contract.ts'

/**
 * Create one node-owned preview session for a requested page.
 * @param target - absolute HTTP(S) URL to preview.
 * @param mode - `browser` opens a real Chromium page; `proxy` uses the isolated
 * HTTP transport. A `503` carries the status so the caller can fall back.
 */
export async function createPreviewSession(
  target: string,
  mode: PreviewSessionMode = 'browser',
): Promise<PreviewSessionDescriptor> {
  const response = await fetch(PREVIEW_SESSIONS_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
    },
    body: JSON.stringify({ target, mode }),
  })
  if (!response.ok) {
    throw Object.assign(new Error(`preview session creation failed (${String(response.status)})`), {
      status: response.status,
    })
  }
  const descriptor = previewSessionDescriptorOf(await response.json() as unknown)
  if (descriptor === undefined) throw new Error('preview session creation returned an invalid descriptor')
  return descriptor
}

/** Release every Origin minted during one iframe's navigation chain. */
export async function releasePreviewSessions(sessionIds: readonly PreviewSessionId[]): Promise<void> {
  if (sessionIds.length === 0) return
  const response = await fetch(PREVIEW_SESSIONS_PATH, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
    },
    body: JSON.stringify({ sessionIds }),
    keepalive: true,
  })
  if (!response.ok) throw new Error(`preview session release failed (${String(response.status)})`)
}
