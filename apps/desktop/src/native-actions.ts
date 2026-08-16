/** Electron-main adapter for the two system actions requested by the DSH child. */

import { isAbsolute } from 'node:path'
import type {
  DesktopNativeRequest,
  DesktopNativeResult,
} from '@deepseek-ai/dsh-desktop-app'
import type { DesktopNativeActionHandler } from './supervisor.ts'

/** Testable operating-system boundary; production binds Electron dialog and shell. */
export interface DesktopNativePlatform {
  /** Open the native single-directory chooser. */
  pickDirectory(): Promise<string | null>
  /** Whether one absolute target currently exists and can be handed off. */
  pathAvailable(path: string): Promise<boolean>
  /** Electron shell.openPath contract: empty string succeeds, text explains failure. */
  openPath(path: string): Promise<string>
  /** Present an actionable native error owned by the desktop shell. */
  reportFailure(path: string, message: string): Promise<void>
}

function cancelled(message = 'desktop native action was cancelled'): DesktopNativeResult {
  return { ok: false, error: { code: 'cancelled', message } }
}

class NativeActionCancelled extends Error {}

function waitFor<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new NativeActionCancelled())
  const operation = start()
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new NativeActionCancelled())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function report(platform: DesktopNativePlatform, path: string, message: string): Promise<void> {
  try {
    await platform.reportFailure(path, message)
  } catch (error: unknown) {
    // Shutdown may destroy the parent window while the diagnostic is opening;
    // the structured failure still returns to DSH.
    console.error('[desktop-main] native path failure dialog failed:', error)
  }
}

function validAbsolutePath(path: string): boolean {
  return path !== '' && !path.includes('\0') && isAbsolute(path)
}

/** Build the scoped child-request handler over Electron's native primitives. */
export function createNativeActionHandler(platform: DesktopNativePlatform): DesktopNativeActionHandler {
  return async (request: DesktopNativeRequest, signal: AbortSignal): Promise<DesktopNativeResult> => {
    if (signal.aborted) return cancelled()
    if (request.type === 'pick-directory') {
      try {
        const path = await waitFor(() => platform.pickDirectory(), signal)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- an abort can land between the dialog settlement and this check.
        if (signal.aborted) return cancelled()
        return { ok: true, value: { type: 'pick-directory', path } }
      } catch (error: unknown) {
        return error instanceof NativeActionCancelled
          ? cancelled()
          : { ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } }
      }
    }

    const path = request.path
    if (!validAbsolutePath(path)) {
      const message = 'path must be an absolute filesystem path'
      await report(platform, path, message)
      return { ok: false, error: { code: 'invalid-path', message } }
    }
    try {
      const available = await waitFor(() => platform.pathAvailable(path), signal)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- an abort can land between the availability check and this line.
      if (signal.aborted) return cancelled()
      if (!available) {
        const message = `path is unavailable: ${path}`
        await report(platform, path, message)
        return { ok: false, error: { code: 'unavailable', message } }
      }
      const failure = await waitFor(() => platform.openPath(path), signal)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- an abort can land between the handoff settlement and this line.
      if (signal.aborted) return cancelled()
      if (failure === '') return { ok: true, value: { type: 'open-path', opened: true } }
      await report(platform, path, failure)
      return { ok: false, error: { code: 'failed', message: failure } }
    } catch (error: unknown) {
      if (error instanceof NativeActionCancelled) return cancelled()
      const message = error instanceof Error ? error.message : String(error)
      await report(platform, path, message)
      return { ok: false, error: { code: 'failed', message } }
    }
  }
}
