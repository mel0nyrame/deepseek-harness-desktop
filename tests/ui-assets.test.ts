import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopUiAssets } from '../packages/ui/src/assets.ts'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function createFixture(): {
  readonly frontend: string
  readonly plugin: string
  readonly graph: {
    rev: string
    entries: Array<{
      id: string
      url: string
      rev: string
      immediately: boolean
    }>
  }
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ui-assets-'))
  fixtures.push(root)
  const frontend = join(root, 'frontend')
  const assets = join(frontend, 'assets')
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(frontend, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>')
  writeFileSync(join(assets, 'app.js'), 'window.DSH_APP = true\n')
  writeFileSync(join(frontend, 'favicon.svg'), '<svg/>\n')
  const plugin = join(root, 'client.js')
  writeFileSync(plugin, 'window.__ModuleLoader__.load({ id: "@dsh-desktop/ui", factory: () => ({}) })\n')
  return {
    frontend,
    plugin,
    graph: {
      rev: 'graph-rev',
      entries: [{
        id: '@dsh-desktop/ui',
        url: '/plugins/%40dsh-desktop%2Fui/client.js?rev=plugin-rev',
        rev: 'plugin-rev',
        immediately: true,
      }],
    },
  }
}

describe('desktop UI asset boundary', () => {
  it('injects the official Client boot graph into the frontend document', async () => {
    const value = createFixture()
    const assets = new DesktopUiAssets({
      graph: () => value.graph,
      clientPath: id => id === '@dsh-desktop/ui' ? value.plugin : undefined,
    }, value.frontend)

    const response = await assets.read('/index.html')

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('text/html; charset=utf-8')
    const html = Buffer.from(response.body, 'base64').toString('utf8')
    expect(html).toContain('window.__ModuleLoader__')
    expect(html).toContain('window.__DSH_BOOT__')
    expect(html).toContain('"rev":"graph-rev"')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    expect(html).not.toContain('frame-ancestors')
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('window.__ModuleLoader__'))
    expect(html).toContain('<div id="root"></div>')
  })

  it('serves frontend and plugin artifacts while rejecting unknown or traversing paths', async () => {
    const value = createFixture()
    const assets = new DesktopUiAssets({
      graph: () => value.graph,
      clientPath: id => id === '@dsh-desktop/ui' ? value.plugin : undefined,
    }, value.frontend)

    await expect(assets.read('/assets/app.js')).resolves.toMatchObject({
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
    })
    const plugin = await assets.read('/plugins/%40dsh-desktop%2Fui/client.js')
    expect(Buffer.from(plugin.body, 'base64').toString('utf8')).toContain('@dsh-desktop/ui')
    await expect(assets.read('/plugins/unknown/client.js')).resolves.toMatchObject({ status: 404 })
    await expect(assets.read('/assets/../index.html')).resolves.toMatchObject({ status: 404 })
    await expect(assets.read('/missing.js')).resolves.toMatchObject({ status: 404 })
  })
})
