import type { Context } from '@deepseek-ai/cordis'

/**
 * @dsh-desktop/bundle — role declaration.
 *
 * composes the desktop profile over the official base and Web bundles and mounts desktop-owned plugins; implementation lands with the profile-bootstrap slice (decoupling 3/10).
 */
export const name = '@dsh-desktop/bundle'

export function apply(_ctx: Context): void {
  // No composition yet: this package declares its role and boundary only.
}
