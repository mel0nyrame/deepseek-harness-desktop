import type { Context } from '@deepseek-ai/cordis'

/**
 * @dsh-desktop/connection — role declaration.
 *
 * implements the existing Client/Host connection contracts over a validated preload bridge; implementation lands with the IPC carrier slice (decoupling 4/10).
 */
export const name = '@dsh-desktop/connection'

export function apply(_ctx: Context): void {
  // No composition yet: this package declares its role and boundary only.
}
