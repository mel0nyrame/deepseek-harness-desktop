import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_COMPONENTS, DESKTOP_PROFILE_BUNDLES, bootstrapDesktopProfile, composeDesktopEntries } from '../packages/bundle/src/profile-bootstrap.js'

function home(): string { return mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-')) }
function profilePath(root: string, file: string): string { return join(root, 'profiles', 'desktop', file) }
const resolveComponentVersion = (name: string): string | undefined => DESKTOP_COMPONENTS[name]

describe('desktop profile composition', () => {
  it('assembles the ordered real Loader entry tree', () => {
    const entries = composeDesktopEntries()
    const ids = entries.map(entry => entry.id)
    expect(ids.indexOf('timer')).toBe(0)
    expect(ids.indexOf('connection')).toBeGreaterThan(ids.indexOf('webserver'))
    expect(ids.slice(-3)).toEqual(['desktop-connection', 'desktop-native', 'desktop-ui'])
    expect(entries.find(entry => entry.id === 'webserver')?.disabled).toBe(true)
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

  it('rejects an incompatible embedded component version before writing', () => {
    const root = home()
    const incompatible = '@deepseek-ai/dsh-base'
    expect(() => bootstrapDesktopProfile({ home: root, resolveComponentVersion: name => name === incompatible ? '0.1.0-rc.7' : DESKTOP_COMPONENTS[name] })).toThrow(incompatible + ' requires ' + DESKTOP_COMPONENTS[incompatible] + ' but found 0.1.0-rc.7')
    expect(() => readFileSync(profilePath(root, 'package.json'), 'utf8')).toThrow()
  })

  it('names an embedded component whose required version cannot be resolved', () => {
    const root = home()
    const missing = '@deepseek-ai/dsh-web-app'
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
})
