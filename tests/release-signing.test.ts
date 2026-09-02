import { describe, expect, it } from 'vitest'
import {
  RELEASE_SIGNING_IDENTITY_ENV,
  applyReleaseSigning,
  resolveReleaseSigning,
  scrubReleaseSigningEnvironment,
} from '../scripts/release-signing.js'

describe('release signing mode', () => {
  it('keeps default packaging ad-hoc when the identity variable is absent or blank', () => {
    expect(resolveReleaseSigning({})).toBeNull()
    expect(resolveReleaseSigning({ [RELEASE_SIGNING_IDENTITY_ENV]: '' })).toBeNull()
    expect(resolveReleaseSigning({ [RELEASE_SIGNING_IDENTITY_ENV]: '   ' })).toBeNull()
  })

  it('refuses the ad-hoc marker and malformed identity names in release mode', () => {
    expect(() => resolveReleaseSigning({ [RELEASE_SIGNING_IDENTITY_ENV]: '-' })).toThrow('ad-hoc')
    expect(() => resolveReleaseSigning({ [RELEASE_SIGNING_IDENTITY_ENV]: 'identity\nname' })).toThrow()
    expect(() => resolveReleaseSigning({ [RELEASE_SIGNING_IDENTITY_ENV]: `x`.repeat(257) })).toThrow()
  })

  it('carries only the declared signing credential names', () => {
    const signing = resolveReleaseSigning({
      [RELEASE_SIGNING_IDENTITY_ENV]: 'Developer ID Application: Example (TEAM)',
      CSC_LINK: 'p12-bytes',
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'opaque-app-password',
      APPLE_TEAM_ID: 'TEAM',
      CSC_KEY_PASSWORD: '',
      DEEPSEEK_API_KEY: 'secret',
      SOME_TOKEN: 'secret',
      PATH: '/usr/bin',
    })
    expect(signing).toEqual({
      identity: 'Developer ID Application: Example (TEAM)',
      buildEnvironment: {
        CSC_LINK: 'p12-bytes',
        APPLE_ID: 'release@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'opaque-app-password',
        APPLE_TEAM_ID: 'TEAM',
      },
    })
  })

  it('strips every signing credential from the default packaging environment', () => {
    expect(scrubReleaseSigningEnvironment({
      CSC_LINK: 'p12-bytes',
      CSC_KEY_PASSWORD: 'password',
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'opaque-app-password',
      APPLE_TEAM_ID: 'TEAM',
      PATH: '/usr/bin',
    })).toEqual({ PATH: '/usr/bin' })
  })

  it('hardens the runtime and overrides the identity without touching other mac settings', () => {
    const config = {
      appId: 'ai.deepseek.dsh-desktop',
      mac: { identity: '-', hardenedRuntime: false, icon: 'build/icon.png' },
    }
    applyReleaseSigning(config, {
      identity: 'Developer ID Application: Example (TEAM)',
      buildEnvironment: {},
    })
    expect(config.mac).toEqual({
      identity: 'Developer ID Application: Example (TEAM)',
      hardenedRuntime: true,
      icon: 'build/icon.png',
    })
  })
})
