/**
 * The plugin's own icons.
 *
 * The host's icon set is not a stable surface: the alpha.5 baseline exports
 * `IconCloseOutline16`-style names while the 0.2.x desktop client exports
 * `IconCloseOutlineRegular`, and rendering a missing name is a React "element
 * type is invalid" crash that takes the whole slot entry with it. These are the
 * handful of glyphs this plugin draws, inline and version-independent.
 */

export interface IconProps {
  /** Square edge in CSS pixels. */
  size?: number
  className?: string | undefined
}

function iconPath(size: number, className: string | undefined, children: JSX.Element): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  )
}

/** Dismiss / close a mode. */
export function IconClose({ size = 16, className }: IconProps): JSX.Element {
  return iconPath(size, className, <path d="M4 4l8 8M12 4l-8 8" />)
}

/** Start annotating (a pencil). */
export function IconAnnotate({ size = 16, className }: IconProps): JSX.Element {
  return iconPath(size, className, (
    <>
      <path d="M10.6 2.4l3 3-7.3 7.3-3.7.7.7-3.7 7.3-7.3z" />
      <path d="M9.2 3.8l3 3" />
    </>
  ))
}

/** Send the acknowledged annotations. */
export function IconSend({ size = 16, className }: IconProps): JSX.Element {
  return iconPath(size, className, (
    <>
      <path d="M2.5 8l11-5-3.2 10-3.1-3.6-2.9 1.4.6-2.8L2.5 8z" />
      <path d="M6.9 10.4L10.5 6" />
    </>
  ))
}

/** Clear every annotation. */
export function IconTrash({ size = 16, className }: IconProps): JSX.Element {
  return iconPath(size, className, (
    <>
      <path d="M2.8 4.4h10.4M6.2 4.4V2.9h3.6v1.5" />
      <path d="M4.3 4.4l.7 8.4h5.9l.7-8.4" />
      <path d="M6.7 6.6v4.4M9.3 6.6v4.4" />
    </>
  ))
}

/** A failure that the user may retry. */
export function IconWarning({ size = 16, className }: IconProps): JSX.Element {
  return iconPath(size, className, (
    <>
      <path d="M8 2.3l6 10.8H2L8 2.3z" />
      <path d="M8 6.4v3.2M8 11.5v.1" />
    </>
  ))
}

/** Confirm an annotation. */
export function IconCheck({ size = 16, className }: IconProps): JSX.Element {
  return iconPath(size, className, <path d="M3 8.6l3.2 3.2L13 5.2" />)
}

/** Link two box-model sides. */
export function IconLink({ size = 14, className }: IconProps): JSX.Element {
  return iconPath(size, className, (
    <>
      <path d="M6.4 9.6l3.2-3.2" />
      <path d="M7.2 5.2l1.2-1.2a2.5 2.5 0 013.6 3.6l-1.2 1.2" />
      <path d="M8.8 10.8l-1.2 1.2a2.5 2.5 0 01-3.6-3.6l1.2-1.2" />
    </>
  ))
}

/** Pending host acknowledgement. */
export function IconLoading({ size = 16, className }: IconProps): JSX.Element {
  return iconPath(size, className, <path d="M8 2.2a5.8 5.8 0 105.8 5.8" />)
}

/** A queued annotation list. */
export function IconQueue({ size = 14, className }: IconProps): JSX.Element {
  return iconPath(size, className, (
    <>
      <path d="M6 4.2h7.2M6 8h7.2M6 11.8h7.2" />
      <path d="M3 4.2h.1M3 8h.1M3 11.8h.1" />
    </>
  ))
}

/** Expand a disclosure. */
export function IconChevronDown({ size = 14, className }: IconProps): JSX.Element {
  return iconPath(size, className, <path d="M4 6l4 4 4-4" />)
}

/** Open a collapsed subtree. */
export function IconChevronRight({ size = 14, className }: IconProps): JSX.Element {
  return iconPath(size, className, <path d="M6 4l4 4-4 4" />)
}

/** Re-read the page-side value. */
export function IconRefresh({ size = 14, className }: IconProps): JSX.Element {
  return iconPath(size, className, (
    <>
      <path d="M13 8a5 5 0 11-1.6-3.7" />
      <path d="M13.2 2.6v3.1h-3.1" />
    </>
  ))
}
