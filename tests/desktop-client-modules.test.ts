import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const bundleRequire = createRequire(new URL('../packages/bundle/package.json', import.meta.url))
const { ClientModuleRegistry } = bundleRequire('@deepseek-ai/dsh-client-modules') as {
  ClientModuleRegistry: { inject: readonly string[] }
}

describe('desktop client-module composition seam', () => {
  it('composes the official client graph without requiring a WebServer transport', () => {
    expect(ClientModuleRegistry.inject).toEqual(['loader'])
  })

  it.each(['packages/connection/lib/client.js', 'packages/ui/lib/client.js'])(
    'ships %s as a lazy Client-module factory without privileged imports',
    (file) => {
      const source = readFileSync(resolve(file), 'utf8')
      expect(source).toContain('window.__ModuleLoader__.load({')
      expect(source).toContain('factory: (require) => {')
      expect(source).toContain('var module = { exports: {} };')
      expect(source).toContain('var exports = module.exports;')
      expect(source).not.toMatch(/(?:from\s+|require\()["'](?:electron|node:)/)
    },
  )

  it('registers the official connection factory before its desktop transport consumer', () => {
    const source = readFileSync(resolve('packages/connection/lib/client.js'), 'utf8')
    const official = source.indexOf('id: "@deepseek-ai/dsh-client-connection"')
    const desktop = source.indexOf('id: "@dsh-desktop/connection"')
    expect(official).toBeGreaterThanOrEqual(0)
    expect(official).toBeLessThan(desktop)
  })
})
