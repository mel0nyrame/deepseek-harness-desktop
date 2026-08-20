import type { Context } from '@deepseek-ai/cordis'

/**
 * @dsh-desktop/ui — role declaration.
 *
 * enters UI contributions through documented client extension points; implementation lands with the UI slices (decoupling 7-8/10).
 */
export const name = '@dsh-desktop/ui'

export function apply(_ctx: Context): void {
  // No composition yet: this package declares its role and boundary only.
}
