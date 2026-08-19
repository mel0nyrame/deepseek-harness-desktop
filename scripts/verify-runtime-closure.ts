/**
<<<<<<< HEAD
 * Verify that every executable deploy manifest supplies every required
 * workspace peer in its dependency graph. With auto peer installation
 * disabled, a missing root peer can otherwise fail only when Cordis loads the
 * packaged plugin. Defaults to the two deploy roots: the Python SDK runtime
 * and the desktop application bundle.
=======
 * Verify that the executable deploy manifest supplies every plugin referenced
 * by a shipped agent preset and every required workspace peer in its dependency
 * graph. With auto peer installation disabled, either omission can otherwise
 * fail only when Cordis loads the packaged plugin.
>>>>>>> upstream/master
 */
import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isCordisGroupEntry, loadCordisYaml } from './cordis-yaml.ts'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface WorkspacePackage {
  path: string
  manifest: PackageManifest
}

<<<<<<< HEAD
/** Deploy roots whose dependency closures are packaged runtime closures. */
const DEFAULT_MANIFESTS = ['python/sdk-runtime/package.json', 'apps/desktop/package.json']

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { manifest: { type: 'string', multiple: true } },
})
const manifestValues = values.manifest ?? []
const manifests = manifestValues.length > 0
  ? manifestValues.map(path => resolve(root, path))
  : DEFAULT_MANIFESTS.map(path => resolve(root, path))
const workspace = await loadWorkspacePackages()

let failed = false
for (const manifestPath of manifests) {
  const failures = await verifyManifest(manifestPath, workspace)
  if (failures.length === 0) continue
  failed = true
  const manifest = await loadManifest(manifestPath)
  console.error(`verify-runtime-closure: required workspace peers are missing from ${manifest.name ?? manifestPath} dependencies:`)
  for (const failure of failures) console.error(`  ${failure}`)
=======
interface RuntimePlatform {
  tag: string
  executable: string
>>>>>>> upstream/master
}
if (failed) process.exit(1)

<<<<<<< HEAD
console.log(`verify-runtime-closure: ${manifests.length} deploy manifest(s) form closed runtime dependency graphs.`)

async function verifyManifest(
  manifestPath: string,
  workspace: ReadonlyMap<string, WorkspacePackage>,
): Promise<string[]> {
  const runtimeManifest = await loadManifest(manifestPath)
  const runtimeName = runtimeManifest.name ?? manifestPath
  const runtimeDependencies = runtimeManifest.dependencies ?? {}
=======
type RuntimePlatformManifest = Record<string, RuntimePlatform>

const AGENT_PRESET_GLOB = 'apps/cli/config/agent-presets/*/agent.cordis.yml'

export interface RuntimeClosureResult {
  failures: string[]
  presetCount: number
  workspacePackageCount: number
}

/**
 * Check that the runtime manifest contains every shipped-preset plugin and workspace peer.
 * @param root repository root containing the runtime manifest and shipped presets.
 * @param manifestPath runtime manifest path relative to {@link root}.
 * @returns the discovered preset count, reachable workspace package count, and violations.
 */
export async function verifyRuntimeClosure(
  root: string,
  manifestPath = 'python/sdk-runtime/package.json',
): Promise<RuntimeClosureResult> {
  const runtimeManifest = await loadManifest(resolve(root, manifestPath))
  const runtimeName = runtimeManifest.name ?? manifestPath
  const workspace = await loadWorkspacePackages(root)
  const runtimeDependencies = runtimeManifest.dependencies ?? {}
  const platforms = await loadJson<RuntimePlatformManifest>(resolve(root, 'python/sdk-runtime/platforms.json'))
  const presetPaths = globSync(AGENT_PRESET_GLOB, { cwd: root }).sort()
  const targets = Object.keys(platforms).sort()
>>>>>>> upstream/master
  const parents = new Map<string, string | undefined>()
  const queue: string[] = []

  for (const dependency of Object.keys(runtimeDependencies).sort()) {
    if (!workspace.has(dependency)) continue
    parents.set(dependency, undefined)
    queue.push(dependency)
  }
<<<<<<< HEAD

  const failures: string[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const packageName = queue[index]
    if (packageName === undefined) continue
    const current = workspace.get(packageName)
    if (current === undefined) continue
    const peers = current.manifest.peerDependencies ?? {}
    const peerMeta = current.manifest.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(peers).sort()) {
      if (!workspace.has(peer) || peerMeta[peer]?.optional === true) continue
      if (runtimeDependencies[peer]?.startsWith('workspace:') === true) continue
      failures.push(`${formatChain(runtimeName, packageName, parents)} -> ${peer}`)
    }
    const dependencies = {
      ...current.manifest.dependencies,
      ...current.manifest.optionalDependencies,
    }
    for (const dependency of Object.keys(dependencies).sort()) {
      if (!workspace.has(dependency) || parents.has(dependency)) continue
      parents.set(dependency, packageName)
      queue.push(dependency)
    }
  }
  return failures
}

async function loadWorkspacePackages(): Promise<Map<string, WorkspacePackage>> {
  // Apps belong here: the desktop deploy root reaches its whole closure
  // through @deepseek-ai/dsh (apps/cli), which packages/*/* alone cannot see.
  const paths = globSync(['packages/*/*/package.json', 'apps/*/package.json', 'vendor/*/package.json'], { cwd: root })
=======

  const failures: string[] = []
  if (presetPaths.length === 0) failures.push(`no agent presets matched ${AGENT_PRESET_GLOB}`)
  if (targets.length === 0) failures.push('python/sdk-runtime/platforms.json defines no runtime targets')
  failures.push(...await missingPresetPlugins(root, runtimeDependencies, presetPaths, targets))
  for (let index = 0; index < queue.length; index += 1) {
    const packageName = queue[index]
    if (packageName === undefined) continue
    const current = workspace.get(packageName)
    if (current === undefined) continue
    const peers = current.manifest.peerDependencies ?? {}
    const peerMeta = current.manifest.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(peers).sort()) {
      if (!workspace.has(peer) || peerMeta[peer]?.optional === true) continue
      if (runtimeDependencies[peer]?.startsWith('workspace:') === true) continue
      failures.push(`${formatChain(runtimeName, packageName, parents)} -> ${peer}`)
    }
    const dependencies = {
      ...current.manifest.dependencies,
      ...current.manifest.optionalDependencies,
    }
    for (const dependency of Object.keys(dependencies).sort()) {
      if (!workspace.has(dependency) || parents.has(dependency)) continue
      parents.set(dependency, packageName)
      queue.push(dependency)
    }
  }

  return {
    failures,
    presetCount: presetPaths.length,
    workspacePackageCount: queue.length,
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..')
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { manifest: { type: 'string' } },
  })
  const result = await verifyRuntimeClosure(root, values.manifest)
  if (result.failures.length > 0) {
    console.error('verify-runtime-closure: preset plugins or required workspace peers are missing from python/sdk-runtime dependencies:')
    for (const failure of result.failures) console.error(`  ${failure}`)
    process.exitCode = 1
  } else {
    console.log(
      `verify-runtime-closure: ${result.presetCount} agent presets and ${result.workspacePackageCount} workspace packages form a closed runtime dependency graph.`,
    )
  }
}

async function missingPresetPlugins(
  root: string,
  runtimeDependencies: Readonly<Record<string, string>>,
  presetPaths: readonly string[],
  targets: readonly string[],
): Promise<string[]> {
  const missing = new Map<string, Set<string>>()
  const failures: string[] = []
  for (const presetPath of presetPaths) {
    const document = loadCordisYaml(await readFile(resolve(root, presetPath), 'utf8'))
    if (!Array.isArray(document)) {
      failures.push(`${presetPath}: preset root must be a Loader entry array`)
      continue
    }
    for (const target of targets) {
      const processPlatform = processPlatformForTarget(target)
      for (const plugin of activeBarePluginPackages(document, processPlatform)) {
        const version = runtimeDependencies[plugin]
        if (version?.startsWith('workspace:') === true) continue
        const preset = basename(dirname(presetPath))
        const declaration = version === undefined
          ? ''
          : ` [runtime dependency is ${JSON.stringify(version)}; expected workspace:]`
        const key = `${preset} preset -> ${plugin}${declaration}`
        const targets = missing.get(key) ?? new Set<string>()
        targets.add(target)
        missing.set(key, targets)
      }
    }
  }
  failures.push(...[...missing.entries()].map(([chain, targets]) =>
    `${chain} (${[...targets].sort().join(', ')})`))
  return failures
}

function activeBarePluginPackages(entries: unknown[], processPlatform: string): Set<string> {
  const packages = new Set<string>()
  const visit = (value: unknown, parentDisabled: boolean): void => {
    if (!isRecord(value)) return
    const disabled = parentDisabled || disabledOnPlatform(value.disabled, processPlatform)
    if (disabled) return
    if (typeof value.name === 'string') {
      const packageName = barePackageName(value.name)
      if (packageName !== undefined) packages.add(packageName)
    }
    if (isCordisGroupEntry(value)) {
      for (const child of value.config) visit(child, disabled)
    }
  }
  for (const entry of entries) visit(entry, false)
  return packages
}

function disabledOnPlatform(value: unknown, processPlatform: string): boolean {
  if (typeof value === 'boolean') return value
  if (!isRecord(value) || typeof value.__jsExpr !== 'string') return false
  const match = /^process\.platform\s*(===|!==)\s*(['"])(win32|linux|darwin)\2$/.exec(value.__jsExpr.trim())
  if (match === null) return false
  const [, operator, , expected] = match
  return operator === '===' ? processPlatform === expected : processPlatform !== expected
}

function processPlatformForTarget(target: string): string {
  if (target.startsWith('linux-')) return 'linux'
  if (target.startsWith('macos-')) return 'darwin'
  throw new Error(`verify-runtime-closure: unsupported runtime target ${JSON.stringify(target)}`)
}

function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return undefined
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  }
  return parts[0] || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function loadWorkspacePackages(root: string): Promise<Map<string, WorkspacePackage>> {
  const paths = globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: root })
>>>>>>> upstream/master
    .sort()
    .map(relative => resolve(root, relative))
  const result = new Map<string, WorkspacePackage>()
  for (const path of paths) {
    const manifest = await loadManifest(path)
    if (manifest.name !== undefined) result.set(manifest.name, { path, manifest })
  }
  return result
}

async function loadManifest(path: string): Promise<PackageManifest> {
  return loadJson<PackageManifest>(path)
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function formatChain(
  runtimeName: string,
  packageName: string,
  parents: ReadonlyMap<string, string | undefined>,
): string {
  const chain = [packageName]
  let parent = parents.get(packageName)
  while (parent !== undefined) {
    chain.unshift(parent)
    parent = parents.get(parent)
  }
  return [runtimeName, ...chain].join(' -> ')
}
