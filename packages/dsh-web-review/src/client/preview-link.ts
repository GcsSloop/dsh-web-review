import { isPreviewableUrl } from '../proxy-url.ts'

/** Assistant message rows expose this semantic marker in Harness alpha.5. */
const ASSISTANT_ROW = '[data-chat-flow-kind="assistant-step"]'

/**
 * Resolve an assistant-authored absolute HTTP(S) link from an ordinary left click.
 * Modifier clicks keep the browser's external-link behavior.
 */
export function previewHrefFromClick(event: MouseEvent): string | undefined {
  if (event.defaultPrevented || event.button !== 0) return undefined
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined
  const target = event.target
  if (!(target instanceof Element)) return undefined
  if (target.closest('[data-webview-ui]') !== null) return undefined
  const anchor = target.closest('a[href]')
  if (anchor === null || anchor.closest(ASSISTANT_ROW) === null) return undefined
  const href = anchor.getAttribute('href') ?? ''
  if (!/^https?:\/\//i.test(href)) return undefined
  try {
    const normalized = new URL(href).href
    return isPreviewableUrl(normalized) ? normalized : undefined
  } catch {
    return undefined
  }
}
