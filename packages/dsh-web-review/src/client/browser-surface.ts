/**
 * Real-browser preview surface: a canvas fed by the session's frame stream.
 *
 * The page runs in a real Chromium on the host, so this surface owns only what
 * a viewer must: draw JPEG frames, forward pointer/keyboard input in page
 * coordinates, keep the emulated viewport in step with the panel, and expose
 * the host side of the bridge channel.
 */
import {
  PREVIEW_BROWSER_INPUT_PATH,
  PREVIEW_BROWSER_STREAM_PATH,
  PREVIEW_CLIENT_HEADER,
  PREVIEW_CLIENT_HEADER_VALUE,
  type PreviewBrowserCommand,
  type PreviewBrowserInput,
  type PreviewSessionDescriptor,
} from '../preview-contract.ts'
import type { PreviewCarrier } from './preview-bridge.ts'

/** Stream callback fan-out owned by the view. */
export interface BrowserSurfaceEvents {
  onState: (state: { url: string; title: string; loading: boolean }) => void
  onError: (message: string) => void
}

interface FrameMetadata {
  deviceWidth: number
  deviceHeight: number
}

function modifiersOf(event: MouseEvent | KeyboardEvent | WheelEvent): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

function buttonOf(button: number): 'left' | 'right' | 'middle' {
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'left'
}

/** One live browser session rendered into a canvas. */
export class BrowserPreviewSurface {
  private readonly descriptor: PreviewSessionDescriptor
  private readonly events: BrowserSurfaceEvents
  private stream: EventSource | null = null
  private canvas: HTMLCanvasElement | null = null
  private detachInput: (() => void) | null = null
  private observer: ResizeObserver | null = null
  private readonly bridgeHandlers = new Set<(message: unknown, origin: string) => void>()
  private stillTimer: ReturnType<typeof setTimeout> | undefined
  private stillPending = false
  private disposed = false
  private frameSequence = 0
  private drawnSequence = 0
  private metadata: FrameMetadata = { deviceWidth: 1280, deviceHeight: 800 }

  constructor(descriptor: PreviewSessionDescriptor, events: BrowserSurfaceEvents) {
    this.descriptor = descriptor
    this.events = events
  }

  /**
   * Attach the frame stream and input forwarding to one canvas.
   * @param canvas - the surface element owned by the view.
   * @returns the detach function.
   */
  attach(canvas: HTMLCanvasElement): () => void {
    this.canvas = canvas
    this.openStream()
    this.detachInput = this.wireInput(canvas)
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => { this.reportViewport() })
      this.observer.observe(canvas)
    }
    this.reportViewport()
    this.scheduleStill()
    return () => {
      this.observer?.disconnect()
      this.observer = null
      this.detachInput?.()
      this.detachInput = null
      this.canvas = null
    }
  }

  /** Host side of the bridge: commands go out, page messages come in. */
  carrier(): PreviewCarrier {
    return {
      post: (message) => {
        if (this.disposed) return false
        void this.command({ name: 'bridge', payload: JSON.stringify(message) }).catch(() => undefined)
        return true
      },
      subscribe: (handler) => {
        this.bridgeHandlers.add(handler)
        return () => { this.bridgeHandlers.delete(handler) }
      },
    }
  }

  private openStream(): void {
    const query = `?sessionId=${encodeURIComponent(this.descriptor.sessionId)}&channel=${encodeURIComponent(this.descriptor.channel)}`
    const stream = new EventSource(`${PREVIEW_BROWSER_STREAM_PATH}${query}`)
    stream.onmessage = (event: MessageEvent<string>) => { this.handleEvent(event.data) }
    stream.onerror = () => {
      if (!this.disposed && stream.readyState === EventSource.CLOSED) {
        this.events.onError('preview stream closed')
      }
    }
    this.stream = stream
  }

  private handleEvent(raw: string): void {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (payload.type === 'state') {
      this.events.onState({
        url: typeof payload.url === 'string' ? payload.url : '',
        title: typeof payload.title === 'string' ? payload.title : '',
        loading: payload.loading === true,
      })
      return
    }
    if (payload.type === 'frame') {
      this.metadata = {
        deviceWidth: Number(payload.deviceWidth) || this.metadata.deviceWidth,
        deviceHeight: Number(payload.deviceHeight) || this.metadata.deviceHeight,
      }
      this.draw(String(payload.data))
      this.scheduleStill()
      return
    }
    if (payload.type === 'bridge') {
      let message: unknown
      try {
        message = JSON.parse(String(payload.payload)) as unknown
      } catch {
        return
      }
      for (const handler of this.bridgeHandlers) handler(message, this.descriptor.frameOrigin)
      return
    }
    if (payload.type === 'error') this.events.onError(String(payload.message))
  }

  /**
   * The motion stream carries CSS-sized frames, which a retina canvas upscales.
   * Once motion settles, ask for one device-resolution still and draw it 1:1.
   */
  private scheduleStill(): void {
    if (this.stillTimer !== undefined) clearTimeout(this.stillTimer)
    this.stillTimer = setTimeout(() => {
      this.stillTimer = undefined
      if (this.disposed || this.stillPending) return
      this.stillPending = true
      void this.command({ name: 'screenshot' })
        .then((result) => {
          if (this.disposed || result.screenshot === undefined) return
          this.draw(String(result.screenshot), false)
        })
        .catch(() => undefined)
        .finally(() => { this.stillPending = false })
    }, 220)
  }

  private draw(data: string, isStreamFrame = true): void {
    const canvas = this.canvas
    if (canvas === null) return
    const sequence = (this.frameSequence += 1)
    const image = new Image()
    image.onload = () => {
      // Frames can decode out of order; never let an older one overwrite a newer,
      // and let a sharp still win over a stream frame decoded after it.
      if (this.disposed || (isStreamFrame && sequence < this.drawnSequence)) return
      this.drawnSequence = isStreamFrame ? sequence : this.frameSequence
      const context = canvas.getContext('2d')
      if (context === null) return
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
    }
    image.src = `data:image/jpeg;base64,${data}`
  }

  private reportViewport(): void {
    const canvas = this.canvas
    if (canvas === null || this.disposed) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    const scale = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(rect.width * scale)
    canvas.height = Math.round(rect.height * scale)
    void this.send({
      kind: 'viewport',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      deviceScaleFactor: scale,
    })
  }

  /**
   * Wire pointer input on the canvas and keyboard input through a hidden sink.
   *
   * The canvas never holds keyboard focus itself: a 1px textarea beside it takes
   * focus on press, so the browser's own IME composition and paste produce the
   * text that `Input.insertText` forwards. Direct keys travel as key events, and
   * a printable key is swallowed locally so the two paths cannot double-send.
   */
  private wireInput(canvas: HTMLCanvasElement): () => void {
    const sink = document.createElement('textarea')
    sink.setAttribute('aria-hidden', 'true')
    sink.tabIndex = -1
    sink.autocomplete = 'off'
    sink.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;'
      + 'border:0;padding:0;margin:0;resize:none;pointer-events:none;'
    const host = canvas.parentElement ?? canvas
    host.appendChild(sink)

    const point = (event: MouseEvent | WheelEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect()
      const scaleX = this.metadata.deviceWidth / Math.max(1, rect.width)
      const scaleY = this.metadata.deviceHeight / Math.max(1, rect.height)
      return {
        x: Math.round((event.clientX - rect.left) * scaleX),
        y: Math.round((event.clientY - rect.top) * scaleY),
      }
    }
    const mouse = (type: 'move' | 'down' | 'up') => (event: MouseEvent) => {
      const { x, y } = point(event)
      event.preventDefault()
      // The page's own focused control only receives keys once the sink has
      // focus, which is what a real browser does when the user clicks.
      if (type !== 'move') sink.focus({ preventScroll: true })
      void this.send({
        kind: 'mouse',
        type,
        x,
        y,
        button: buttonOf(event.button),
        clickCount: 1,
        modifiers: modifiersOf(event),
      })
    }
    const onMove = mouse('move')
    const onDown = mouse('down')
    const onUp = mouse('up')
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const { x, y } = point(event)
      void this.send({
        kind: 'wheel',
        x,
        y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifiersOf(event),
      })
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey
      if (printable || event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Tab') {
        event.preventDefault()
      }
      void this.send({
        kind: 'key',
        type: 'down',
        key: event.key,
        code: event.code,
        text: printable ? event.key : '',
        windowsVirtualKeyCode: event.keyCode,
        modifiers: modifiersOf(event),
      })
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      void this.send({
        kind: 'key',
        type: 'up',
        key: event.key,
        code: event.code,
        text: '',
        windowsVirtualKeyCode: event.keyCode,
        modifiers: modifiersOf(event),
      })
    }
    // IME commits and pastes arrive as value changes without a forwarded key.
    const onInput = (event: Event): void => {
      if ((event as InputEvent).isComposing === true) return
      const text = sink.value
      sink.value = ''
      if (text !== '') void this.send({ kind: 'text', text })
    }
    const onCanvasPointer = (): void => { sink.focus({ preventScroll: true }) }

    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mouseup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onCanvasPointer)
    sink.addEventListener('keydown', onKeyDown)
    sink.addEventListener('keyup', onKeyUp)
    sink.addEventListener('input', onInput)
    return () => {
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onCanvasPointer)
      sink.removeEventListener('keydown', onKeyDown)
      sink.removeEventListener('keyup', onKeyUp)
      sink.removeEventListener('input', onInput)
      sink.remove()
    }
  }

  private send(input: PreviewBrowserInput): Promise<{ screenshot?: string }> {
    return this.request({ input })
  }

  /** Issue one browser command (reload/screenshot/navigation/bridge). */
  command(command: PreviewBrowserCommand): Promise<{ screenshot?: string }> {
    return this.request({ command })
  }

  private async request(body: Record<string, unknown>): Promise<{ screenshot?: string }> {
    const response = await fetch(PREVIEW_BROWSER_INPUT_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PREVIEW_CLIENT_HEADER]: PREVIEW_CLIENT_HEADER_VALUE,
      },
      body: JSON.stringify({
        sessionId: this.descriptor.sessionId,
        channel: this.descriptor.channel,
        ...body,
      }),
    })
    if (!response.ok) throw new Error(`preview input rejected (${String(response.status)})`)
    return await response.json() as { screenshot?: string }
  }

  /** Close the stream and drop every listener. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.stillTimer !== undefined) clearTimeout(this.stillTimer)
    this.stillTimer = undefined
    this.stream?.close()
    this.stream = null
    this.observer?.disconnect()
    this.observer = null
    this.detachInput?.()
    this.detachInput = null
    this.canvas = null
  }
}
