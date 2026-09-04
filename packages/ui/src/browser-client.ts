/** Browser adapter for the desktop Client contribution. */

import { BrandWordmark, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { applyWithEnvironment, type DesktopUiClientContext } from './client.js'

export * from './client.js'

/**
 * Apply the desktop Client contribution against the context-isolated preload bridge.
 * @throws When the native theme bridge or browser document is unavailable.
 */
export function apply(ctx: DesktopUiClientContext): void {
  const nativeTheme = globalThis.dshNativeTheme
  if (nativeTheme === undefined || typeof document === 'undefined') {
    throw new Error('desktop UI: native theme preload bridge is unavailable')
  }
  applyWithEnvironment(ctx, {
    nativeTheme,
    primitives: { BrandWordmark, PanelIcon: IconPanelLeftOutline16 },
    document: {
      body: document.body,
      createElement: () => document.createElement('style'),
      head: { append: style => { document.head.append(style as HTMLStyleElement) } },
    },
  })
}
