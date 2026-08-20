import type { Context } from '@deepseek-ai/cordis'

export { DESKTOP_COMPONENTS, DESKTOP_PROFILE_BUNDLES, bootstrapDesktopProfile, composeDesktopEntries } from './profile-bootstrap.js'

export const name = '@dsh-desktop/bundle'

/** Desktop bundle marker; profile composition is declared by the bundle patch. */
export function apply(_ctx: Context): void {}
