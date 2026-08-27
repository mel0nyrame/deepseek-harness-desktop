/** Desktop native backend for the published `ctx.directoryPicker` seam. */

import type { Context } from '@deepseek-ai/cordis'
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerNativeCapability } from '@deepseek-ai/dsh-host-directory-picker'
import { createNativeActionChannel } from './channel.js'

/**
 * @dsh-desktop/native — desktop-owned native capability providers.
 *
 * The default export implements the official DirectoryPicker Service
 * Definition with the `native` interaction: each pick is one reverse request
 * through the DSH child boundary, and Electron main remains the
 * operating-system adapter. `./gateway` provides `ctx.apiProxy` over the same
 * seam with the path-opening handoff injected. Exported names mirror the
 * official `-native` backend package exactly (default class only): the Cordis
 * loader attaches every export surface it recognizes, and an additional
 * named binding re-applies the row's service registration.
 */
/** The `ctx.directoryPicker` native implementation (stable capability per service life). */
export default class DesktopDirectoryPicker extends DirectoryPicker {
  private readonly desktopCapability: DirectoryPickerNativeCapability
  private readonly lifetime = new AbortController()
  private disposed = false

  constructor(ctx: Context) {
    super(ctx)
    const channel = createNativeActionChannel()
    ctx.effect(() => {
      const release = channel.acquire()
      return () => {
        this.disposed = true
        this.lifetime.abort(new Error('desktop directory picker is disposed'))
        release()
      }
    }, 'desktop-native: shell action channel')
    this.desktopCapability = Object.freeze({
      kind: 'native',
      pick: async (signal: AbortSignal): Promise<string | null> => {
        if (this.disposed) throw new Error('desktop directory picker is disposed')
        const value = await channel.request({ action: 'pick-directory' }, AbortSignal.any([signal, this.lifetime.signal]))
        if (value.kind !== 'path') {
          throw new Error('desktop directory picker received a mismatched settlement')
        }
        return value.path
      },
    })
  }

  /** The native interaction capability. */
  capability(): DirectoryPickerNativeCapability {
    return this.desktopCapability
  }
}
