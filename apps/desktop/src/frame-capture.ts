/** Settled-frame screenshot capture shared by the desktop evidence journeys. */

/** Structural subset of `BrowserWindow` needed to capture one rendered frame. */
export interface FrameCaptureWindow<Frame extends CapturedImage> {
  readonly webContents: {
    executeJavaScript(script: string): Promise<unknown>
    capturePage(): Promise<Frame>
  }
}

/** The part of a captured image the evidence journeys consume. */
export interface CapturedImage {
  toPNG(): Buffer
}

export interface FrameCaptureOptions {
  /** Minimum accepted PNG size in bytes; smaller images are treated as unpainted. */
  readonly minBytes?: number
  /** Total budget for retrying unpainted frames. */
  readonly timeoutMs?: number
  /** Delay between retry attempts. */
  readonly delayMs?: number
}

const SETTLE_PAINT_SCRIPT = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'

/**
 * Captures one rendered frame, retrying while the compositor still reports an
 * unpainted (too-small) image; software-rendered hosts can return blank frames
 * for the first composites after the window is shown.
 */
export async function captureStableFrame<Frame extends CapturedImage>(
  window: FrameCaptureWindow<Frame>,
  scope: string,
  name: string,
  options: FrameCaptureOptions = {},
): Promise<Frame> {
  const minBytes = options.minBytes ?? 20_000
  const delayMs = options.delayMs ?? 250
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  for (;;) {
    await window.webContents.executeJavaScript(SETTLE_PAINT_SCRIPT)
    const image = await window.webContents.capturePage()
    if (image.toPNG().length >= minBytes) return image
    if (Date.now() > deadline) {
      throw new Error(`desktop ${scope} evidence frame ${name} is unexpectedly empty`)
    }
    await new Promise(done => setTimeout(done, delayMs))
  }
}
