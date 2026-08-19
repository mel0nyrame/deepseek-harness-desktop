import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INSTALL_ANCHOR, resolveProductVersionPatch } from '../src/profile-boot.ts'

describe('product version launcher overlay', () => {
  it('reads the CLI manifest version and replaces a user-provided placeholder', () => {
    const manifest = JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8')) as { version: string }

    expect(resolveProductVersionPatch({
      id: 'api-gateway',
      config: { productVersion: '0.0.0', coldBlankProbeMaxBytes: 2048 },
    })).toEqual({
      id: 'api-gateway',
      config: { productVersion: manifest.version, coldBlankProbeMaxBytes: 2048 },
    })
  })

  it('does not add a gateway to profiles that do not carry one', () => {
    expect(resolveProductVersionPatch(undefined)).toBeUndefined()
  })
})
