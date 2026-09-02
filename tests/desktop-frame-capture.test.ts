import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureStableFrame, type CapturedImage, type FrameCaptureWindow } from '../apps/desktop/src/frame-capture.js'

afterEach(() => {
  vi.useRealTimers()
})

type FakeImage = CapturedImage

function fakeWindow(pngSizes: readonly number[]): {
  window: FrameCaptureWindow<FakeImage>
  captures: () => number
  settleScripts: () => number
} {
  let index = 0
  let captures = 0
  let settleScripts = 0
  const window: FrameCaptureWindow<FakeImage> = {
    webContents: {
      executeJavaScript: async script => {
        if (script.includes('requestAnimationFrame')) settleScripts += 1
        return undefined
      },
      capturePage: async () => {
        captures += 1
        const size = pngSizes[Math.min(index, pngSizes.length - 1)] ?? 0
        index += 1
        return { toPNG: () => Buffer.alloc(Math.max(size, 0)) }
      },
    },
  }
  return { window, captures: () => captures, settleScripts: () => settleScripts }
}

describe('desktop frame capture', () => {
  it('returns the first painted frame without retrying', async () => {
    const { window, captures, settleScripts } = fakeWindow([30_000])

    const image = await captureStableFrame(window, 'UI', '01-workspace-picker')

    expect(image.toPNG().length).toBe(30_000)
    expect(captures()).toBe(1)
    expect(settleScripts()).toBe(1)
  })

  it('retries unpainted frames until the compositor delivers one', async () => {
    vi.useFakeTimers()
    const { window, captures, settleScripts } = fakeWindow([100, 4_000, 30_000])

    const pending = captureStableFrame(window, 'UI', '01-workspace-picker')
    await vi.advanceTimersByTimeAsync(1_000)

    const image = await pending
    expect(image.toPNG().length).toBe(30_000)
    expect(captures()).toBe(3)
    expect(settleScripts()).toBe(3)
  })

  it('fails loudly with the journey-scoped error after the retry budget', async () => {
    vi.useFakeTimers()
    const { window, captures } = fakeWindow([100])

    const pending = captureStableFrame(window, 'UI', '01-workspace-picker')
    const rejection = expect(pending).rejects.toThrow('desktop UI evidence frame 01-workspace-picker is unexpectedly empty')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejection
    expect(captures()).toBeGreaterThan(1)
  })

  it('honors a custom minimum frame size', async () => {
    const { window, captures } = fakeWindow([500])

    const image = await captureStableFrame(window, 'native', 'native-dark', { minBytes: 200 })

    expect(image.toPNG().length).toBe(500)
    expect(captures()).toBe(1)
  })
})
