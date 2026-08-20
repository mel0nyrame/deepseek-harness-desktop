import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

const require = createRequire(import.meta.url)

export const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-desktop/bundle'] as const
export const DESKTOP_COMPONENTS: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-base': require('@deepseek-ai/dsh-base/package.json').version as string,
  '@deepseek-ai/dsh-web-app': require('@deepseek-ai/dsh-web-app/package.json').version as string,
  '@dsh-desktop/bundle': require('../package.json').version as string,
}

interface BootstrapOptions {
  home: string
  resolveComponentVersion: (packageName: string) => string | undefined
}
interface BootstrapResult { changed: boolean }
type JsonObject = Record<string, unknown>

const PROFILE_PATCH = '# User-owned desktop profile patches, applied after product bundles.\n[]\n'
const PROFILE_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {}
}

function readManifest(file: string): JsonObject | undefined {
  if (!existsSync(file)) return undefined
  try {
    return object(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    throw new Error('desktop profile bootstrap: cannot parse ' + file + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error })
  }
}

function sameRecord(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  const candidate = object(value)
  const keys = Object.keys(expected)
  return Object.keys(candidate).length === keys.length && keys.every(key => candidate[key] === expected[key])
}

/** Compose the real base, Web, and desktop bundle patches in product order. */
export function composeDesktopEntries(): EntryOptions[] {
  const layers = [
    require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'),
    require.resolve('@deepseek-ai/dsh-web-app/cordis.patch.yml'),
    fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)),
  ].map(file => loadOverlayPatches('desktop profile', file))
  return composeEntries(layers)
}

/** Create or repair product-owned fields of the desktop profile. */
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
  const manifest: JsonObject = existing ?? { name: 'dsh-profile-desktop', private: true, dependencies: {} }
  const dsh = object(manifest.dsh)
  const profile = object(dsh.profile)
  const previousBundles = Array.isArray(profile.bundles) ? profile.bundles.filter((item): item is string => typeof item === 'string') : []
  const userBundles = previousBundles.filter(bundle => !DESKTOP_PROFILE_BUNDLES.includes(bundle as typeof DESKTOP_PROFILE_BUNDLES[number]))
  const bundles = [...DESKTOP_PROFILE_BUNDLES, ...userBundles]
  const desktop = object(dsh.desktop)
  const valid = existing !== undefined && JSON.stringify(profile.bundles) === JSON.stringify(bundles) && sameRecord(desktop.components, DESKTOP_COMPONENTS)

  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, 'cordis.patch.yml'))) writeFileSync(join(dir, 'cordis.patch.yml'), PROFILE_PATCH)
  if (!existsSync(join(dir, 'pnpm-workspace.yaml'))) writeFileSync(join(dir, 'pnpm-workspace.yaml'), PROFILE_WORKSPACE)
  if (valid) return { changed: false }

  profile.bundles = bundles
  dsh.profile = profile
  desktop.components = { ...DESKTOP_COMPONENTS }
  dsh.desktop = desktop
  manifest.dsh = dsh
  writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  return { changed: true }
}
