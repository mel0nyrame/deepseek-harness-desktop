import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { DESKTOP_COMPONENTS, DESKTOP_PROFILE_BUNDLES, bootstrapDesktopProfile, composeDesktopProfile } from '../packages/bundle/src/profile-bootstrap.js'

const temporaryHomes = new Set<string>()
const externalLinks = new Set<string>()

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
  temporaryHomes.add(root)
  return root
}
function profilePath(root: string, file: string): string { return join(root, 'profiles', 'desktop', file) }
const resolveComponentVersion = (name: string): string | undefined => DESKTOP_COMPONENTS[name]

afterAll(() => {
  for (const link of externalLinks) unlinkSync(link)
  for (const root of temporaryHomes) rmSync(root, { recursive: true, force: true })
})

describe('desktop profile composition', () => {
  it('loads the bootstrapped bundles and dumps the ordered real Loader entry tree', () => {
    const root = home()
    bootstrapDesktopProfile({ home: root, resolveComponentVersion })
    const installation = join(root, 'embedded-installation')
    const anchor = join(installation, 'package.json')
    mkdirSync(installation, { recursive: true })
    writeFileSync(anchor, '{"name":"embedded-desktop"}\n')
    for (const name of DESKTOP_PROFILE_BUNDLES) {
      const link = join(installation, 'node_modules', name)
      mkdirSync(join(link, '..'), { recursive: true })
      const target = name === '@dsh-desktop/bundle'
        ? fileURLToPath(new URL('../packages/bundle/', import.meta.url))
        : fileURLToPath(new URL('../packages/bundle/node_modules/' + name + '/', import.meta.url))
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      externalLinks.add(link)
    }
    const { entries, dump } = composeDesktopProfile({ home: root, installAnchor: anchor })
    const ids = entries.map(entry => entry.id)
    expect(ids.indexOf('timer')).toBe(0)
    expect(ids.indexOf('connection')).toBeGreaterThan(ids.indexOf('webserver'))
    expect(ids.slice(-3)).toEqual(['desktop-connection', 'desktop-native', 'desktop-ui'])
    expect(entries.find(entry => entry.id === 'webserver')?.disabled).toBe(true)
    expect(dump).toContain('# == @deepseek-ai/dsh-base')
    expect(dump).toContain('# == @dsh-desktop/bundle')
    expect(dump.indexOf('id: timer')).toBeLessThan(dump.indexOf('id: desktop-connection'))
  })
})

describe('bootstrapDesktopProfile', () => {
  it('creates the complete offline desktop profile from embedded components', () => {
    const root = home()
    expect(bootstrapDesktopProfile({ home: root, resolveComponentVersion: name => DESKTOP_COMPONENTS[name] })).toEqual({ changed: true })
    const manifest = JSON.parse(readFileSync(profilePath(root, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual(DESKTOP_PROFILE_BUNDLES)
    expect(manifest.dsh.desktop.components).toEqual(DESKTOP_COMPONENTS)
    expect(readFileSync(profilePath(root, 'cordis.patch.yml'), 'utf8')).toContain('[]')
  })

  it('does not rewrite a valid profile', () => {
    const root = home()
    bootstrapDesktopProfile({ home: root, resolveComponentVersion })
    const before = readFileSync(profilePath(root, 'package.json'), 'utf8')
    expect(bootstrapDesktopProfile({ home: root, resolveComponentVersion })).toEqual({ changed: false })
    expect(readFileSync(profilePath(root, 'package.json'), 'utf8')).toBe(before)
  })

  it('repairs the product-owned empty root without changing the user patch', () => {
    const root = home()
    bootstrapDesktopProfile({ home: root, resolveComponentVersion })
    const patch = '# user overlay\n[]\n'
    writeFileSync(profilePath(root, 'cordis.patch.yml'), patch)
    writeFileSync(profilePath(root, 'cordis.yml'), '- id: stale\n  name: stale-plugin\n')

    expect(bootstrapDesktopProfile({ home: root, resolveComponentVersion })).toEqual({ changed: true })
    expect(readFileSync(profilePath(root, 'cordis.yml'), 'utf8')).toContain('[]')
    expect(readFileSync(profilePath(root, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it('repairs product state while preserving user-owned bytes and configuration', () => {
    const root = home()
    const dir = join(root, 'profiles', 'desktop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'user-profile', dependencies: { 'user-plugin': '3.2.1' }, unrelated: { keep: true }, dsh: { profile: { bundles: ['user-bundle', '@deepseek-ai/dsh-base'] }, desktop: { components: 'broken' }, userSetting: { keep: true } } }, undefined, 2) + '\n')
    const patch = '# user-owned bytes\n- id: user-plugin\n  config: { value: 1 }\n'
    writeFileSync(join(dir, 'cordis.patch.yml'), patch)
    expect(bootstrapDesktopProfile({ home: root, resolveComponentVersion: name => DESKTOP_COMPONENTS[name] })).toEqual({ changed: true })
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual([...DESKTOP_PROFILE_BUNDLES, 'user-bundle'])
    expect(manifest.dsh.desktop.components).toEqual(DESKTOP_COMPONENTS)
    expect(manifest.dependencies).toEqual({ 'user-plugin': '3.2.1' })
    expect(manifest.unrelated).toEqual({ keep: true })
    expect(manifest.dsh.userSetting).toEqual({ keep: true })
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  })

  it('preserves the original bytes of user-owned manifest fields during repair', () => {
    const root = home()
    const dir = join(root, 'profiles', 'desktop')
    mkdirSync(dir, { recursive: true })
    const manifest = '{\n  "name": "user-profile",\n  "dependencies": { "user-plugin": "3.2.1" },\n  "unrelated": {"escaped":"\\u4fdd\\u7559",  "spacing" : [1,  2]},\n  "dsh": {"profile":{"bundles":["user-bundle"]},"desktop":{"components":{}},"userSetting" : { "keep" : true }}\n}\n'
    writeFileSync(join(dir, 'package.json'), manifest)

    bootstrapDesktopProfile({ home: root, resolveComponentVersion })

    const repaired = readFileSync(join(dir, 'package.json'), 'utf8')
    expect(repaired).toContain('"dependencies": { "user-plugin": "3.2.1" }')
    expect(repaired).toContain('"unrelated": {"escaped":"\\u4fdd\\u7559",  "spacing" : [1,  2]}')
    expect(repaired).toContain('"userSetting" : { "keep" : true }')
  })

  it('rejects an incompatible embedded component version before writing', () => {
    const root = home()
    const incompatible = '@deepseek-ai/dsh-base'
    expect(() => bootstrapDesktopProfile({ home: root, resolveComponentVersion: name => name === incompatible ? '0.1.0-rc.7' : DESKTOP_COMPONENTS[name] })).toThrow(incompatible + ' requires ' + DESKTOP_COMPONENTS[incompatible] + ' but found 0.1.0-rc.7')
    expect(() => readFileSync(profilePath(root, 'package.json'), 'utf8')).toThrow()
  })

  it('names an embedded component whose required version cannot be resolved', () => {
    const root = home()
    const missing = '@dsh-desktop/native'
    expect(() => bootstrapDesktopProfile({ home: root, resolveComponentVersion: name => name === missing ? undefined : DESKTOP_COMPONENTS[name] })).toThrow('desktop profile bootstrap: embedded component ' + missing + ' requires ' + DESKTOP_COMPONENTS[missing] + ' but found missing; repair the application installation')
    expect(() => readFileSync(profilePath(root, 'package.json'), 'utf8')).toThrow()
  })

  it('rejects a malformed profile manifest without replacing it', () => {
    const root = home()
    const dir = join(root, 'profiles', 'desktop')
    mkdirSync(dir, { recursive: true })
    const malformed = '{ not json\n'
    writeFileSync(join(dir, 'package.json'), malformed)
    expect(() => bootstrapDesktopProfile({ home: root, resolveComponentVersion: name => DESKTOP_COMPONENTS[name] })).toThrow(/desktop profile bootstrap: cannot parse .*package.json/)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(malformed)
  })

  it('rejects a non-object profile manifest without replacing it', () => {
    const root = home()
    const dir = join(root, 'profiles', 'desktop')
    mkdirSync(dir, { recursive: true })
    const malformed = '["user-owned"]\n'
    writeFileSync(join(dir, 'package.json'), malformed)
    expect(() => bootstrapDesktopProfile({ home: root, resolveComponentVersion })).toThrow(/package.json.*must hold a JSON object/)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(malformed)
  })

  it('rejects a bundle list containing non-string entries without replacing it', () => {
    const root = home()
    const dir = join(root, 'profiles', 'desktop')
    mkdirSync(dir, { recursive: true })
    const malformed = '{"dsh":{"profile":{"bundles":["user-bundle",42]}}}\n'
    writeFileSync(join(dir, 'package.json'), malformed)
    expect(() => bootstrapDesktopProfile({ home: root, resolveComponentVersion })).toThrow(/dsh\.profile\.bundles must be an array of strings/)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(malformed)
  })
})
