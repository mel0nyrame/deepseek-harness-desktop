/**
 * Credential-bearing environment names consumed by electron-builder for
 * Developer ID signing and notarization. They are re-admitted to the build
 * environment only when release signing is enabled; the default packaging
 * scrub strips them.
 */
const SIGNING_CREDENTIAL_NAMES = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
] as const

/** The identity-name environment variable that turns on release signing. */
export const RELEASE_SIGNING_IDENTITY_ENV = 'DSH_DESKTOP_SIGN_IDENTITY'

/** Release signing overrides applied to the committed electron-builder config. */
export interface ReleaseSigning {
  readonly identity: string
  readonly buildEnvironment: Partial<Record<(typeof SIGNING_CREDENTIAL_NAMES)[number], string>>
}

function definedCredential(environment: NodeJS.ProcessEnv, name: (typeof SIGNING_CREDENTIAL_NAMES)[number]): string | undefined {
  const value = environment[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Resolves the explicit release-signing mode from `DSH_DESKTOP_SIGN_IDENTITY`.
 * Returns `null` when unset, so default packaging stays ad-hoc exactly as
 * committed. A release build refuses the ad-hoc marker and malformed identity
 * names; credential values are carried opaquely and never logged.
 */
export function resolveReleaseSigning(environment: NodeJS.ProcessEnv): ReleaseSigning | null {
  const identity = environment[RELEASE_SIGNING_IDENTITY_ENV]
  if (identity === undefined || identity.trim() === '') return null
  const trimmed = identity.trim()
  if (trimmed === '-') {
    throw new Error(`${RELEASE_SIGNING_IDENTITY_ENV} refuses the ad-hoc marker; unset it for ad-hoc packaging`)
  }
  if (trimmed.length > 256 || /[\p{Cc}]/u.test(trimmed)) {
    throw new Error(`${RELEASE_SIGNING_IDENTITY_ENV} is not a valid signing identity name`)
  }
  const buildEnvironment: ReleaseSigning['buildEnvironment'] = {}
  for (const name of SIGNING_CREDENTIAL_NAMES) {
    const value = definedCredential(environment, name)
    if (value !== undefined) buildEnvironment[name] = value
  }
  return { identity: trimmed, buildEnvironment }
}

/**
 * Applies release signing overrides to the parsed electron-builder
 * configuration: the explicit Developer ID identity and the hardened runtime
 * that Developer ID distribution and notarization require.
 */
export function applyReleaseSigning<T extends { mac?: { identity?: unknown; hardenedRuntime?: unknown } | null }>(
  config: T,
  signing: ReleaseSigning,
): void {
  config.mac = { ...config.mac, identity: signing.identity, hardenedRuntime: true }
}