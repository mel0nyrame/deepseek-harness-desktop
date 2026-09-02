import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { Configuration, PackagerOptions } from 'electron-builder'
import { parse } from 'yaml'
import {
  discoverArtifacts,
  gatekeeperIsHardGate,
  readPackagedAppEvidence,
  signEvidenceSteps,
  type SignEvidenceStep,
} from './artifact-evidence.ts'
import { removeRuntimeOutput, scrubRuntimeEnvironment } from './runtime-output.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUNTIME = path.join(ROOT, '.artifacts', 'package-runtime')
const PACKAGE_PROJECT = path.join(ROOT, '.artifacts', 'package-project')
const OUTPUT = path.join(ROOT, 'apps', 'desktop', 'dist')
const APP_DIR = path.join(ROOT, 'apps', 'desktop')
const CONFIG = path.join(APP_DIR, 'electron-builder.yml')
const requireFromShell = createRequire(path.join(APP_DIR, 'package.json'))
const CLEAN_ENVIRONMENT = scrubRuntimeEnvironment(process.env)

function pnpm(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(value => value.includes(' ') ? JSON.stringify(value) : value).join(' ')
}

async function run(
  label: string,
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv = CLEAN_ENVIRONMENT,
): Promise<void> {
  const printable = commandLine(command, args)
  console.log(`dsh-desktop package: ${label}: ${printable}`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...environment, CI: 'true' },
      stdio: 'inherit',
    })
    child.once('error', error => {
      reject(new Error(`dsh-desktop package: ${label} failed to spawn: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(
        `dsh-desktop package: ${label} failed (${code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`}): ${printable}`,
      ))
    })
  })
}

function electronPaths(): { packageDir: string; dist: string; executable: string; version: string } {
  const packageDir = path.dirname(requireFromShell.resolve('electron/package.json'))
  const installed = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof installed.version !== 'string') {
    throw new Error('dsh-desktop package: installed Electron has no version')
  }
  const dist = path.join(packageDir, 'dist')
  const executable = path.join(dist, process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : 'electron')
  return { packageDir, dist, executable, version: installed.version }
}

async function ensureElectron(): Promise<ReturnType<typeof electronPaths>> {
  const electron = electronPaths()
  if (!fs.existsSync(electron.executable)) {
    await run('Electron distribution restore', process.execPath, [
      path.join(electron.packageDir, 'install.js'),
    ], scrubRuntimeEnvironment(process.env))
  }
  if (!fs.existsSync(electron.executable)) {
    throw new Error(`dsh-desktop package: Electron distribution is missing: ${electron.executable}`)
  }
  return electron
}

async function validateNativeRuntime(electron: ReturnType<typeof electronPaths>): Promise<void> {
  const runtimeManifest = path.join(RUNTIME, 'package.json')
  const script = [
    "const { createRequire } = require('node:module')",
    `const runtimeRequire = createRequire(${JSON.stringify(runtimeManifest)})`,
    "runtimeRequire('node-pty')",
    "runtimeRequire('koffi')",
    "console.log('native ABI validation passed under Electron ' + process.versions.electron)",
  ].join(';')
  await run('native ABI validation', electron.executable, ['-e', script], {
    ...scrubRuntimeEnvironment(process.env),
    ELECTRON_RUN_AS_NODE: '1',
  })
}

function stagePackageProject(): void {
  const shellManifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')) as {
    dependencies?: unknown
    devDependencies?: unknown
    scripts?: unknown
    [key: string]: unknown
  }
  shellManifest.main = './lib/packaged-main.js'
  shellManifest.files = ['lib/packaged-main.js']
  delete shellManifest.dependencies
  delete shellManifest.devDependencies
  delete shellManifest.scripts
  removeRuntimeOutput(PACKAGE_PROJECT)
  fs.mkdirSync(path.join(PACKAGE_PROJECT, 'build'), { recursive: true })
  fs.mkdirSync(path.join(PACKAGE_PROJECT, 'lib'), { recursive: true })
  fs.copyFileSync(
    path.join(APP_DIR, 'lib', 'packaged-main.js'),
    path.join(PACKAGE_PROJECT, 'lib', 'packaged-main.js'),
  )
  fs.copyFileSync(path.join(APP_DIR, 'build', 'icon.png'), path.join(PACKAGE_PROJECT, 'build', 'icon.png'))
  fs.writeFileSync(
    path.join(PACKAGE_PROJECT, 'package.json'),
    `${JSON.stringify(shellManifest, undefined, 2)}\n`,
  )
}

function electronVersion(config: Configuration, electron: ReturnType<typeof electronPaths>): string {
  const shell = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, unknown>
  }
  const runtime = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'runtime', 'runtime-manifest.json'), 'utf8'),
  ) as { build?: { electron?: { version?: unknown } } }
  const declarations = {
    shell: shell.devDependencies?.electron,
    builder: config.electronVersion,
    runtime: runtime.build?.electron?.version,
    installed: electron.version,
  }
  const expected = declarations.shell
  if (typeof expected !== 'string'
    || Object.values(declarations).some(version => version !== expected)) {
    throw new Error(
      `dsh-desktop package: Electron version declarations disagree: ${JSON.stringify(declarations)}`,
    )
  }
  return expected
}

function installCleanProcessEnvironment(): void {
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, CLEAN_ENVIRONMENT, { CSC_FOR_PULL_REQUEST: 'true' })
}

/**
 * Builds the installer once, retrying once from a clean output when
 * electron-builder's signing exhausts the host file descriptors (EMFILE);
 * the signing concurrency peak is timing-dependent, so a fresh attempt
 * usually completes under the same limit. Other failures surface directly.
 */
async function buildInstallable(options: PackagerOptions): Promise<void> {
  const { build } = await import('electron-builder')
  try {
    await build(options)
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('EMFILE'))) throw error
    console.warn('dsh-desktop package: electron-builder exhausted the host file descriptors; retrying from a clean output')
    removeRuntimeOutput(OUTPUT)
    fs.mkdirSync(OUTPUT, { recursive: true })
    await build(options)
  }
}

function packagedRuntimeResources(): NonNullable<Configuration['extraResources']> {
  return [
    { from: path.join(RUNTIME, 'package.json'), to: 'runtime/package.json' },
    { from: path.join(RUNTIME, 'runtime-manifest.json'), to: 'runtime/runtime-manifest.json' },
    { from: path.join(RUNTIME, 'README.md'), to: 'runtime/README.md' },
    { from: path.join(RUNTIME, 'renderer.html'), to: 'runtime/renderer.html' },
    { from: path.join(RUNTIME, 'lib'), to: 'runtime/lib' },
    { from: path.join(RUNTIME, 'node_modules'), to: 'runtime/node_modules' },
  ]
}

async function runEvidenceStep(step: SignEvidenceStep): Promise<void> {
  const attempts = step.required ? 3 : 1
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await run(step.label, step.command, [...step.args])
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, 1_500))
      }
    }
  }
  throw lastError
}

async function verifyArtifacts(
  artifacts: readonly string[],
  identity: string | null | undefined,
): Promise<void> {
  const enforceGatekeeper = gatekeeperIsHardGate(identity)
  for (const artifact of artifacts) {
    if (artifact.endsWith('.app')) {
      const evidence = readPackagedAppEvidence(artifact)
      console.log(`dsh-desktop package: artifact evidence: ${JSON.stringify(evidence)}`)
    }
    for (const step of signEvidenceSteps(artifact, enforceGatekeeper)) {
      try {
        await runEvidenceStep(step)
      } catch (error) {
        if (step.required || (error instanceof Error && error.message.includes('failed to spawn'))) {
          throw error
        }
        console.warn(
          `dsh-desktop package: ${step.label} rejected the artifact (recorded as evidence): ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }
}

function usage(): string {
  return [
    'Usage: pnpm run package [-- --skip-build] [--dry-run]',
    '',
    '  --skip-build  use existing built package artifacts.',
    '  --dry-run     print the packaging stages without changing files.',
  ].join('\n')
}

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument, index) => argument !== '--' || index !== 0),
  options: {
    'skip-build': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  console.log(usage())
} else if (values['dry-run']) {
  if (!values['skip-build']) console.log('dsh-desktop package: build: pnpm run build')
  console.log(`dsh-desktop package: runtime assembly: ${RUNTIME}`)
  console.log('dsh-desktop package: native ABI validation: node-pty and koffi under Electron')
  console.log(`dsh-desktop package: electron-builder: ${OUTPUT}`)
  console.log('dsh-desktop package: artifact evidence: identity, runtime manifest, native helpers, signatures')
} else {
  if (process.platform !== 'darwin') throw new Error('desktop packaging currently requires macOS')
  if (!values['skip-build']) await run('build', pnpm(), ['run', 'build'])
  await run('runtime assembly', process.execPath, [
    path.join(ROOT, 'scripts', 'assemble-runtime.ts'), '--output', RUNTIME,
  ], scrubRuntimeEnvironment(process.env))
  const config = parse(fs.readFileSync(CONFIG, 'utf8')) as Configuration
  const electron = await ensureElectron()
  const version = electronVersion(config, electron)
  await validateNativeRuntime(electron)
  stagePackageProject()

  removeRuntimeOutput(OUTPUT)
  fs.mkdirSync(OUTPUT, { recursive: true })
  installCleanProcessEnvironment()
  await buildInstallable({
    projectDir: PACKAGE_PROJECT,
    config: {
      ...config,
      electronVersion: version,
      electronDist: electron.dist,
      directories: { output: OUTPUT },
      extraResources: packagedRuntimeResources(),
    },
  })
  const artifacts = discoverArtifacts(fs.readdirSync(OUTPUT), OUTPUT)
  if (artifacts.length === 0) throw new Error(`dsh-desktop package: no products under ${OUTPUT}`)
  await verifyArtifacts(artifacts, config.mac?.identity)
  console.log('dsh-desktop package: products:')
  for (const artifact of artifacts) console.log(`  ${artifact}`)
}
