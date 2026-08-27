/** Desktop API gateway: the official ApiProxy implementation with the shell-owned path opener injected. */

import type { Context } from '@deepseek-ai/cordis'
// Imported for its Context augmentation: the gateway reuses the official
// default-model closures verbatim when delegating to createApiProxy.
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import { ApiProxyService, createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { createNativeActionChannel } from './channel.js'

/** Stable Cordis plugin name shared with the desktop bundle row. */
export const name = '@dsh-desktop/native/gateway'

/** Mirror the official gateway's prerequisites so Loader orders rows identically. */
export const inject: string[] = [...ApiProxyService.inject]

/** Provide `ctx.apiProxy` over the official factory; only the native opener is desktop-owned. */
export function apply(ctx: Context): void {
  const defaultModel: AgentDefaultModelConfig = ctx.agentDefaultModel
  const channel = createNativeActionChannel()
  const lifetime = new AbortController()
  let disposed = false
  ctx.effect(() => {
    const release = channel.acquire()
    return () => {
      disposed = true
      lifetime.abort(new Error('desktop native gateway is disposed'))
      release()
    }
  }, 'desktop-native/gateway: shell action channel')
  ctx.provide('apiProxy', createApiProxy(ctx, {
    cwd: process.cwd(),
    defaultModelSelection: () => defaultModel.currentSelection(),
    saveDefaultModelSelection: selection => defaultModel.saveSelection(selection),
    openPath: async (path, signal) => {
      if (disposed) throw new Error('desktop native gateway is disposed')
      const value = await channel.request({ action: 'open-path', path }, AbortSignal.any([signal, lifetime.signal]))
      if (value.kind !== 'opened') {
        throw new Error('desktop path opener received a mismatched settlement')
      }
    },
  }))
}
