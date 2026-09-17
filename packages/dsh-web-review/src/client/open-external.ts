/**
 * Ask the host to open one link outside the app.
 *
 * The desktop shell renders the interface in its own webview, so a
 * `target="_blank"` click has no browser tab to land in. The plugin's node half
 * relays such a request to the shell's control API, which launches the user's
 * default browser; a host without that shell answers `{ ok: false }` and the
 * caller keeps its ordinary new-tab behavior.
 */
import { PREVIEW_CLIENT_HEADER, PREVIEW_CLIENT_HEADER_VALUE } from '../preview-contract.ts'

/** Open `url` in the host's system browser; false when no shell can do it. */
export async function openExternalLink(url: string): Promise<boolean> {
  try {
    const response = await fetch('/webview-open-external', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
      },
      body: JSON.stringify({ url }),
    })
    if (!response.ok) return false
    const value = await response.json() as { ok?: unknown }
    return value.ok === true
  } catch {
    return false
  }
}
