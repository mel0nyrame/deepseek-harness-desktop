import { describe, expect, it } from 'vitest'
import { resolveSidebarMaterial, type SidebarMaterialFacts } from '../src/client/sidebar-material.ts'

describe('resolveSidebarMaterial', () => {
  it.each([
    [{ enabled: true, reducedTransparency: false, colorScheme: 'light', platform: 'darwin' }, 'glass-light'],
    [{ enabled: true, reducedTransparency: false, colorScheme: 'dark', platform: 'darwin' }, 'glass-dark'],
    [{ enabled: false, reducedTransparency: false, colorScheme: 'light', platform: 'darwin' }, 'opaque-light'],
    [{ enabled: false, reducedTransparency: false, colorScheme: 'dark', platform: 'darwin' }, 'opaque-dark'],
    [{ enabled: true, reducedTransparency: true, colorScheme: 'light', platform: 'darwin' }, 'opaque-light'],
    [{ enabled: true, reducedTransparency: true, colorScheme: 'dark', platform: 'darwin' }, 'opaque-dark'],
    [{ enabled: true, reducedTransparency: false, colorScheme: 'light', platform: 'win32' }, 'opaque-light'],
    [{ enabled: true, reducedTransparency: false, colorScheme: 'dark', platform: 'linux' }, 'opaque-dark'],
  ] satisfies Array<[SidebarMaterialFacts, string]>)('%o resolves to %s', (facts, expected) => {
    expect(resolveSidebarMaterial(facts)).toBe(expected)
  })
})
