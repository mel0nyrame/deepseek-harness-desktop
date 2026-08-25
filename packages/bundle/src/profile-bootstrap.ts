import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { composeEntries, loadProfile, renderConfigDump } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEdits, modify } from 'jsonc-parser'

const require = createRequire(import.meta.url)

export const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-desktop/bundle'] as const
export const DESKTOP_COMPONENTS: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-base': require('@deepseek-ai/dsh-base/package.json').version as string,
  '@deepseek-ai/dsh-web-app': require('@deepseek-ai/dsh-web-app/package.json').version as string,
  '@dsh-desktop/bundle': require('../package.json').version as string,
  '@dsh-desktop/connection': require('@dsh-desktop/connection/package.json').version as string,
  '@dsh-desktop/native': require('@dsh-desktop/native/package.json').version as string,
  '@dsh-desktop/ui': require('@dsh-desktop/ui/package.json').version as string,
}

export interface BootstrapOptions {
  /** Harness home that owns the `profiles/desktop` directory. */
  home: string
  /** Resolve versions from the application's embedded package closure. */
  resolveComponentVersion: (packageName: string) => string | undefined
}
export interface BootstrapResult {
  /** Whether bootstrap wrote any profile file. */
  changed: boolean
}
export interface DesktopProfileCompositionOptions {
  /** Harness home containing a bootstrapped `desktop` profile. */
  home: string
  /** Embedded application's package.json, used as the first bundle-resolution anchor. */
  installAnchor: string
}
export interface DesktopProfileComposition {
  /** Effective Loader entries after every bundle and user patch. */
  entries: EntryOptions[]
  /** Profile dump rendered with the same patch algorithm as application boot. */
  dump: string
}
type JsonObject = Record<string, unknown>
interface ManifestFile { source: string; value: JsonObject }

const PROFILE_PATCH = '# User-owned desktop profile patches, applied after product bundles.\n[]\n'
const PROFILE_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
const PROFILE_ROOT = '# Product-owned empty root; edit cordis.patch.yml for user overlays.\n[]\n'

function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function readManifest(file: string): ManifestFile | undefined {
  if (!existsSync(file)) return undefined
  const source = readFileSync(file, 'utf8')
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error('desktop profile bootstrap: cannot parse ' + file + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error })
  }
  if (!isObject(value)) throw new Error('desktop profile bootstrap: ' + file + ' must hold a JSON object')
  return { source, value }
}

function sameRecord(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  const candidate = object(value)
  const keys = Object.keys(expected)
  return Object.keys(candidate).length === keys.length && keys.every(key => candidate[key] === expected[key])
}

function replaceJson(source: string, path: (string | number)[], value: unknown): string {
  return applyEdits(source, modify(source, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }))
}

function repairManifest(source: string, manifest: JsonObject, bundles: readonly string[]): string {
  const dsh = object(manifest.dsh)
  let repaired = source
  if (!isObject(manifest.dsh)) {
    return replaceJson(repaired, ['dsh'], { profile: { bundles }, desktop: { components: DESKTOP_COMPONENTS } })
  }
  if (isObject(dsh.profile)) repaired = replaceJson(repaired, ['dsh', 'profile', 'bundles'], bundles)
  else repaired = replaceJson(repaired, ['dsh', 'profile'], { bundles })
  if (isObject(dsh.desktop)) repaired = replaceJson(repaired, ['dsh', 'desktop', 'components'], DESKTOP_COMPONENTS)
  else repaired = replaceJson(repaired, ['dsh', 'desktop'], { components: DESKTOP_COMPONENTS })
  return repaired
}

/**
 * Load the bootstrapped manifest through the published profile resolver and render its effective Loader tree.
 *
 * @returns effective Loader entries and the equivalent config dump.
 * @throws when profile, bundle, or patch resolution, reading, parsing, or validation fails.
 */
export function composeDesktopProfile(options: DesktopProfileCompositionOptions): DesktopProfileComposition {
  const profile = loadProfile('desktop profile', 'desktop', options.installAnchor, options.home)
  const patchLayers = [...profile.layers.map(layer => layer.patches), profile.patches]
  const dumpLayers = [
    ...profile.layers.map(layer => ({ label: layer.packageName, patches: layer.patches })),
    { label: profile.patchPath, patches: profile.patches },
  ]
  return {
    entries: composeEntries(patchLayers),
    dump: renderConfigDump('desktop profile', join(profile.dir, 'cordis.yml'), dumpLayers),
  }
}

/**
 * Create support files and repair only product-owned manifest fields of the desktop profile.
 *
 * @returns whether any profile file was written.
 * @throws before writing when the embedded closure is missing or version-incompatible, or when an existing manifest is invalid JSON, has a non-object root, or declares a non-string bundle entry.
 */
export function bootstrapDesktopProfile(options: BootstrapOptions): BootstrapResult {
  for (const [name, requiredVersion] of Object.entries(DESKTOP_COMPONENTS)) {
    const actualVersion = options.resolveComponentVersion(name)
    if (actualVersion !== requiredVersion) {
      const actual = actualVersion === undefined ? 'missing' : actualVersion
      throw new Error('desktop profile bootstrap: embedded component ' + name + ' requires ' + requiredVersion + ' but found ' + actual + '; repair the application installation')
    }
  }

  const dir = join(options.home, 'profiles', 'desktop')
  const manifestPath = join(dir, 'package.json')
  const existing = readManifest(manifestPath)
  const manifest: JsonObject = existing?.value ?? { name: 'dsh-profile-desktop', private: true, dependencies: {} }
  const dsh = object(manifest.dsh)
  const profile = object(dsh.profile)
  const declaredBundles = profile.bundles
  if (declaredBundles !== undefined && !isStringArray(declaredBundles)) {
    throw new Error('desktop profile bootstrap: ' + manifestPath + ' dsh.profile.bundles must be an array of strings')
  }
  const previousBundles = declaredBundles ?? []
  const userBundles = previousBundles.filter(bundle => !DESKTOP_PROFILE_BUNDLES.includes(bundle as typeof DESKTOP_PROFILE_BUNDLES[number]))
  const bundles = [...DESKTOP_PROFILE_BUNDLES, ...userBundles]
  const desktop = object(dsh.desktop)
  const valid = existing !== undefined && JSON.stringify(profile.bundles) === JSON.stringify(bundles) && sameRecord(desktop.components, DESKTOP_COMPONENTS)

  mkdirSync(dir, { recursive: true })
  let changed = false
  for (const [file, content] of [['cordis.patch.yml', PROFILE_PATCH], ['pnpm-workspace.yaml', PROFILE_WORKSPACE]] as const) {
    const target = join(dir, file)
    if (existsSync(target)) continue
    writeFileSync(target, content)
    changed = true
  }
  const rootPath = join(dir, 'cordis.yml')
  if (!existsSync(rootPath) || readFileSync(rootPath, 'utf8') !== PROFILE_ROOT) {
    writeFileSync(rootPath, PROFILE_ROOT)
    changed = true
  }
  if (valid) return { changed }

  const source = existing?.source ?? JSON.stringify(manifest, undefined, 2) + '\n'
  writeFileSync(manifestPath, repairManifest(source, manifest, bundles))
  return { changed: true }
}
