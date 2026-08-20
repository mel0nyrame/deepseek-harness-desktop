import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INSTALL_ANCHOR, resolveProductVersionPatch, withProductVersion } from '../src/profile-boot.ts'

describe('product version launcher overlay', () => {
  it('reads the CLI manifest version while preserving the current gateway config', () => {
    const manifest = JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8')) as { version: string }

    expect(resolveProductVersionPatch({
      id: 'api-gateway',
      name: 'gateway',
      config: { productVersion: 'user-controlled', nativeOpen: false },
    })).toEqual({
      id: 'api-gateway',
      config: { productVersion: manifest.version, nativeOpen: false },
    })
  })

  it('does not add a gateway to profiles that do not carry one', () => {
    expect(resolveProductVersionPatch(undefined)).toBeUndefined()
  })

  it('recomposes reloadable gateway settings before each identity patch', () => {
    const generation = (nativeOpen: boolean) => withProductVersion([{
      insert: [{ id: 'api-gateway', name: 'gateway', config: { nativeOpen } }],
    }])

    expect(generation(false).at(-1)).toMatchObject({ config: { nativeOpen: false } })
    expect(generation(true).at(-1)).toMatchObject({ config: { nativeOpen: true } })
  })
})
