import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INSTALL_ANCHOR, resolveProductVersionPatch } from '../src/profile-boot.ts'

describe('product version launcher overlay', () => {
  it('reads the CLI manifest version without freezing any user-owned gateway config', () => {
    const manifest = JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8')) as { version: string }

    expect(resolveProductVersionPatch(true)).toEqual({
      id: 'api-gateway',
      config: { productVersion: manifest.version },
    })
  })

  it('does not add a gateway to profiles that do not carry one', () => {
    expect(resolveProductVersionPatch(false)).toBeUndefined()
  })
})
