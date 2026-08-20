import type { Context } from '@deepseek-ai/cordis'

/**
 * @dsh-desktop/native — role declaration.
 *
 * exposes directory selection, path opening, and similar macOS actions as Cordis capability providers; implementation lands with the native-provider slice (decoupling 6/10).
 */
export const name = '@dsh-desktop/native'

export function apply(_ctx: Context): void {
  // No composition yet: this package declares its role and boundary only.
}
