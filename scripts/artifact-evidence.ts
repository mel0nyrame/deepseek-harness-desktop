import fs from 'node:fs'
import path from 'node:path'
import { verifyRuntimeClosure } from './verify-runtime-closure.ts'

interface PackagedManifest {
  readonly product?: {
    readonly appId?: unknown
    readonly profile?: unknown
    readonly runtimeDownloads?: unknown
  }
  readonly platformDependencies?: Record<string, {
    readonly targets?: Record<string, {
      readonly package?: unknown
      readonly artifacts?: unknown
    }>
  }>
}

export interface PackagedAppEvidence {
  readonly appId: string
  readonly profile: string
  readonly runtimeDownloads: false
  readonly nativeArtifacts: string[]
}

export interface SignEvidenceStep {
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  readonly required: boolean
}

/** Whether Gatekeeper rejection fails the build for the configured identity. */
export function gatekeeperIsHardGate(identity: string | null | undefined): boolean {
  return identity !== undefined && identity !== null && identity !== '-'
}

/** Signature, image-integrity, and Gatekeeper evidence for one macOS product. */
export function signEvidenceSteps(
  artifact: string,
  enforceGatekeeper: boolean,
): SignEvidenceStep[] {
  if (artifact.endsWith('.dmg')) {
    return [
      { label: 'dmg integrity', command: 'hdiutil', args: ['verify', artifact], required: true },
      {
        label: 'dmg gatekeeper assessment',
        command: 'spctl',
        args: ['--assess', '--type', 'open', '--verbose=4', artifact],
        required: enforceGatekeeper,
      },
    ]
  }
  return [
    {
      label: 'signature verification',
      command: 'codesign',
      args: ['--verify', '--deep', '--strict', '--verbose=2', artifact],
      required: true,
    },
    {
      label: 'signature identity',
      command: 'codesign',
      args: ['-d', '--verbose=2', artifact],
      required: false,
    },
    {
      label: 'gatekeeper assessment',
      command: 'spctl',
      args: ['--assess', '--type', 'execute', '--verbose=4', artifact],
      required: enforceGatekeeper,
    },
  ]
}

/** Discover application and disk-image products emitted by electron-builder. */
export function discoverArtifacts(entries: readonly string[], output: string): string[] {
  const artifacts: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('mac')) {
      const app = path.join(output, entry, 'DSH Desktop.app')
      if (fs.existsSync(app)) artifacts.push(app)
    } else if (entry.endsWith('.dmg')) {
      artifacts.push(path.join(output, entry))
    }
  }
  return artifacts.toSorted()
}

function requiredFile(file: string): void {
  if (!fs.statSync(file).isFile()) throw new Error(`Packaged application file is missing: ${file}`)
}

function plistString(plist: string, key: string): string | undefined {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))
  return match?.[1]
}

/** Read and validate installed product identity and native-runtime evidence. */
export function readPackagedAppEvidence(app: string): PackagedAppEvidence {
  const contents = path.join(app, 'Contents')
  const resources = path.join(contents, 'Resources')
  const runtime = path.join(resources, 'runtime')
  const plistPath = path.join(contents, 'Info.plist')
  const manifestPath = path.join(runtime, 'runtime-manifest.json')
  requiredFile(plistPath)
  requiredFile(path.join(resources, 'app.asar'))
  requiredFile(path.join(resources, 'icon.icns'))
  requiredFile(path.join(runtime, 'lib', 'main.js'))
  requiredFile(path.join(runtime, 'lib', 'preload.cjs'))
  requiredFile(path.join(runtime, 'renderer.html'))
  requiredFile(path.join(runtime, 'node_modules', '@dsh-desktop', 'bundle', 'cordis.patch.yml'))
  requiredFile(manifestPath)
  verifyRuntimeClosure(runtime)

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PackagedManifest
  const appId = plistString(fs.readFileSync(plistPath, 'utf8'), 'CFBundleIdentifier')
  if (typeof appId !== 'string' || appId !== manifest.product?.appId) {
    throw new Error(`Packaged application identifier does not match its runtime manifest: ${String(appId)}`)
  }
  if (manifest.product?.profile !== 'desktop') {
    throw new Error(`Packaged runtime profile is not desktop: ${String(manifest.product?.profile)}`)
  }
  if (manifest.product.runtimeDownloads !== false) {
    throw new Error('Packaged runtime does not prohibit startup downloads')
  }

  const target = `darwin-${process.arch}`
  const nativeArtifacts: string[] = []
  for (const [name, dependency] of Object.entries(manifest.platformDependencies ?? {})) {
    const targetDependency = dependency.targets?.[target]
    if (typeof targetDependency?.package !== 'string' || !Array.isArray(targetDependency.artifacts)) {
      throw new Error(`Packaged runtime has no native dependency declaration for ${name} on ${target}`)
    }
    for (const value of targetDependency.artifacts) {
      if (typeof value !== 'string') throw new Error(`Packaged runtime has an invalid ${name} artifact`)
      const relative = `${targetDependency.package}/${value}`
      const artifact = path.join(runtime, 'node_modules', relative)
      requiredFile(artifact)
      if (value.endsWith('spawn-helper') && (fs.statSync(artifact).mode & 0o111) === 0) {
        throw new Error(`Packaged PTY helper is not executable: ${artifact}`)
      }
      nativeArtifacts.push(relative)
    }
  }

  return {
    appId,
    profile: manifest.product.profile,
    runtimeDownloads: manifest.product.runtimeDownloads,
    nativeArtifacts,
  }
}
