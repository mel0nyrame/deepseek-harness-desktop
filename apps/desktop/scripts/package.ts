/**
 * Package the Electron desktop tracer bullet as a macOS application bundle.
 *
 * Owns the packaging contract (README.md documents the same layout): pnpm
 * legacy deploy materializes the production runtime closure — the dsh CLI,
 * every in-box plugin's built `lib`, the Web frontend dist, and node-pty —
 * into a symlink-free staging directory; node-pty is then rebuilt against the
 * pinned Electron ABI and validated by loading it inside the Electron binary;
 * electron-builder assembles the .app with the shell in the asar and the whole
 * runtime closure as real files under `Contents/Resources/runtime`, because
 * child processes and native loading need filesystem paths no archive can
 * provide. The assembled bundle and dmg are ad-hoc signed
 * (electron-builder.yml documents the identity decision), and every produced
 * artifact must pass the signature and image-integrity gates of
 * scripts/artifact-evidence.ts while its Gatekeeper verdict is recorded —
 * modern macOS rejects every ad-hoc signature via spctl, so the verdict
 * becomes a hard gate only once a Developer ID identity signs the artifacts.
 * Developer ID notarization needs paid Apple Developer Program credentials
 * (the yml carries the wiring); cross-arch artifacts come from the CI matrix
 * in .github/workflows/desktop-release.yml. This script builds the host
 * architecture only.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build, type Configuration } from 'electron-builder'
import { rebuild } from '@electron/rebuild'
import yaml from 'js-yaml'
import { discoverArtifacts, gatekeeperIsHardGate, hasCustomBundleIcon, signEvidenceSteps, type SignEvidenceStep } from './artifact-evidence.ts'

const require = createRequire(import.meta.url)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(scriptDir, '..')
const repoRoot = resolve(packageDir, '../..')
/** Deploy staging directory inside the app package (gitignored). */
const STAGING = join(packageDir, '.pack', 'stage')
/** electron-builder output directory (gitignored). */
const OUT_DIR = join(packageDir, 'dist')
/** The declarative electron-builder configuration this script executes. */
const BUILDER_CONFIG = join(packageDir, 'electron-builder.yml')

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/** Validated CLI configuration; construction owns help and parse-error exits. */
class PackageCli {
  private constructor(
    readonly skipBuild: boolean,
    readonly dryRun: boolean,
  ) {}

  static parse(argv: string[]): PackageCli {
    // parseArgs reports values under the declared option names, so the
    // hyphenated flags must be read with the same keys they were given.
    let values: Record<string, string | boolean | undefined>
    try {
      values = parseArgs({
        args: argv,
        options: {
          'skip-build': { type: 'boolean', default: false },
          'dry-run': { type: 'boolean', default: false },
          'help': { type: 'boolean', default: false },
        },
      }).values
    } catch (error) {
      console.error(`dsh-desktop package: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(PackageCli.usage())
      process.exit(1)
    }
    if (values['help'] === true) {
      console.log(PackageCli.usage())
      process.exit(0)
    }
    return new PackageCli(values['skip-build'] === true, values['dry-run'] === true)
  }

  private static usage(): string {
    return [
      'Usage: pnpm --filter @deepseek-ai/dsh-desktop run package [flags]',
      '',
      '  --skip-build  skip `pnpm run build` (lib/ artifacts must already exist).',
      '  --dry-run     print every command and filesystem change without executing.',
      '  --help        print this help.',
      '',
      `Stages the runtime closure in ${STAGING} and writes the signed .app and dmg under ${OUT_DIR}.`,
    ].join('\n')
  }
}

/** Sequential packaging pipeline; subprocess errors name the failing command. */
class DesktopPackageBuild {
  constructor(private readonly cli: PackageCli) {}

  /** The pinned production Electron version, from this package's devDependencies. */
  async electronVersion(): Promise<string> {
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    const spec = manifest.devDependencies?.['electron']
    if (spec === undefined) throw new Error('dsh-desktop package: the electron devDependency is missing')
    return spec.replace(/^\^/, '')
  }

  /** The installed Electron distribution electron-builder and validation reuse. */
  electronDist(): string {
    return join(dirname(require.resolve('electron/package.json')), 'dist')
  }

  /**
   * Ensure the pinned Electron distribution exists before rebuild and
   * validation. Fresh installs download it through Electron's reviewed
   * postinstall (allowBuilds), but the packaging pipeline must not depend on
   * that side effect surviving the legacy deploy's workspace-state churn:
   * when the dist is absent, restore it through the package's own install
   * script.
   */
  async restoreElectronDist(): Promise<void> {
    const electronExecutable = join(
      this.electronDist(),
      process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
    )
    if (existsSync(electronExecutable)) return
    if (this.cli.dryRun) {
      console.log('dsh-desktop package: [dry-run] node electron/install.js (distribution missing)')
      return
    }
    const electronPackage = dirname(require.resolve('electron/package.json'))
    console.log(`dsh-desktop package: electron distribution missing at ${this.electronDist()}; restoring with the package's install script.`)
    await this.run('electron restore', process.execPath, [join(electronPackage, 'install.js')])
    if (!existsSync(electronExecutable)) {
      throw new Error(`dsh-desktop package: electron restore produced no distribution at ${this.electronDist()}`)
    }
  }

  /** Verify the runtime closure before deploying or packaging. */
  async verifyClosure(): Promise<void> {
    await this.run('runtime dependency closure', pnpmBin(), ['run', 'verify-runtime-closure'])
  }

  /** Build all package artifacts unless `--skip-build` was passed. */
  async buildLib(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('dsh-desktop package: skipping pnpm run build (--skip-build)')
      return
    }
    await this.run('build', pnpmBin(), ['run', 'build'])
  }

  /** Clear and deploy the production runtime closure into the staging directory. */
  async deployStaging(): Promise<void> {
    if (STAGING === repoRoot || repoRoot.startsWith(STAGING + sep)) {
      throw new Error(`dsh-desktop package: refusing to clear staging dir ${STAGING}: it contains the repo root.`)
    }
    if (this.cli.dryRun) console.log(`dsh-desktop package: [dry-run] rm -rf ${STAGING}`)
    else await rm(STAGING, { recursive: true, force: true })
    await this.run('deploy', pnpmBin(), [
      '--filter',
      '@deepseek-ai/dsh-desktop',
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      STAGING,
    ])
    await this.restoreLegacyHoists()
    await this.materializeStagedLinks()
    await this.stageIcon()
    // The legacy deploy's production install records its settings (production,
    // hoisted linker) in the workspace state beside the repo's node_modules;
    // without this restore, every later `pnpm run` triggers pnpm's deps-status
    // check and re-runs a production install that strips devDependencies.
    await this.run('restore workspace state', pnpmBin(), ['install'])
  }

  /**
   * Restore direct packages that pnpm's legacy hoister places beside the
   * deploy source instead of in the target (observed with `@deepseek-ai/dsh`:
   * a deep closure can push the app itself back to the source node_modules).
   * The deployed manifest supplies the closure, so package-local node_modules
   * trees are omitted to preserve one flat Cordis instance and a
   * symlink-free packaged payload.
   */
  private async restoreLegacyHoists(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('dsh-desktop package: [dry-run] restore direct dependencies omitted by legacy deploy')
      return
    }
    const manifestPath = join(STAGING, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const sourceNodeModules = join(packageDir, 'node_modules')
    const restored: string[] = []
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      const destination = join(STAGING, 'node_modules', dependency)
      if (existsSync(destination)) continue
      const source = join(sourceNodeModules, dependency)
      if (!existsSync(source)) {
        throw new Error(
          `dsh-desktop package: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
        )
      }
      await mkdir(dirname(destination), { recursive: true })
      const nestedNodeModules = join(source, 'node_modules')
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      restored.push(dependency)
    }
    const stillMissing = Object.keys(manifest.dependencies ?? {})
      .filter(dependency => !existsSync(join(STAGING, 'node_modules', dependency)))
    if (stillMissing.length > 0) {
      throw new Error(`dsh-desktop package: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
    }
    if (restored.length > 0) {
      console.log(`dsh-desktop package: restored legacy deploy hoists: ${restored.join(', ')}`)
    }
  }

  /** Replace deploy-time package links with files and reject any remaining link. */
  private async materializeStagedLinks(): Promise<void> {
    const nodeModules = join(STAGING, 'node_modules')
    let remaining = await this.findSymlink(nodeModules)
    while (remaining !== undefined) {
      const segments = remaining.slice(nodeModules.length + 1).split(sep)
      const binIndex = segments.lastIndexOf('.bin')
      if (binIndex >= 0) {
        await this.rmPath(join(nodeModules, ...segments.slice(0, binIndex + 1)))
        remaining = await this.findSymlink(nodeModules)
        continue
      }
      const destination = remaining
      const source = await realpath(destination)
      const nestedNodeModules = join(source, 'node_modules')
      await this.rmPath(destination)
      if (this.cli.dryRun) {
        console.log(`dsh-desktop package: [dry-run] cp ${source} ${destination}`)
      } else {
        await cp(source, destination, {
          recursive: true,
          dereference: true,
          filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
        })
      }
      remaining = await this.findSymlink(nodeModules)
    }
  }

  /** Return the first symbolic link below a directory, if one exists. */
  private async findSymlink(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) return path
      if (metadata.isDirectory()) {
        const nested = await this.findSymlink(path)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  private async rmPath(path: string): Promise<void> {
    if (this.cli.dryRun) {
      console.log(`dsh-desktop package: [dry-run] rm -rf ${path}`)
      return
    }
    await rm(path, { recursive: true, force: true })
  }

  /**
   * Stage the application icon beside the deployed closure: electron-builder
   * resolves the yml's mac.icon against the staging projectDir, so the
   * committed build/icon.png must exist inside the staged project for the
   * custom icon (rather than the default Electron one) to ship.
   */
  private async stageIcon(): Promise<void> {
    const source = join(packageDir, 'build', 'icon.png')
    if (!existsSync(source)) {
      throw new Error(
        `dsh-desktop package: the icon source is missing at ${source}; regenerate it with 'pnpm --filter @deepseek-ai/dsh-desktop run icon'.`,
      )
    }
    const destination = join(STAGING, 'build', 'icon.png')
    if (this.cli.dryRun) {
      console.log(`dsh-desktop package: [dry-run] cp ${source} ${destination}`)
      return
    }
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination)
  }

  /** Rebuild node-pty against the production Electron ABI in place. */
  async rebuildPty(): Promise<void> {
    const ptyDir = join(STAGING, 'node_modules', 'node-pty')
    if (!existsSync(join(ptyDir, 'package.json'))) {
      throw new Error(`dsh-desktop package: node-pty is missing from the deployed closure at ${ptyDir}.`)
    }
    if (this.cli.dryRun) {
      console.log(`dsh-desktop package: [dry-run] electron-rebuild node-pty at ${ptyDir}`)
      return
    }
    await rebuild({
      buildPath: ptyDir,
      electronVersion: await this.electronVersion(),
      force: true,
    })
    const releaseDir = join(ptyDir, 'build', 'Release')
    for (const artifact of ['pty.node', 'spawn-helper']) {
      if (!existsSync(join(releaseDir, artifact))) {
        throw new Error(`dsh-desktop package: rebuild produced no ${artifact} under ${releaseDir}.`)
      }
    }
    await chmod(join(releaseDir, 'spawn-helper'), 0o755)
    console.log(`dsh-desktop package: node-pty rebuilt for Electron ${await this.electronVersion()} at ${releaseDir}`)
  }

  /**
   * Validate the rebuilt addon against the production Electron runtime: the
   * Electron binary runs as Node and loads node-pty from the staging closure,
   * so an ABI mismatch fails the packaging instead of the installed app.
   */
  async validateRuntime(): Promise<void> {
    const electronExecutable = join(
      this.electronDist(),
      process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
    )
    if (!existsSync(electronExecutable)) {
      throw new Error(
        `dsh-desktop package: electron distribution missing at ${this.electronDist()}; `
        + 'restore it with `node node_modules/electron/install.js` inside apps/desktop.',
      )
    }
    const script = `const pty = require(${JSON.stringify(join(STAGING, 'node_modules', 'node-pty'))}); console.log('node-pty ABI check passed under Electron ' + process.versions.electron)`
    if (this.cli.dryRun) {
      console.log(`dsh-desktop package: [dry-run] ELECTRON_RUN_AS_NODE=1 ${electronExecutable} -e ${JSON.stringify(script)}`)
      return
    }
    await this.run('native validation', electronExecutable, ['-e', script], {
      ELECTRON_RUN_AS_NODE: '1',
    })
  }

  /** Assemble the macOS application bundle from the staged closure. */
  async package(config: Configuration): Promise<string[]> {
    await mkdir(OUT_DIR, { recursive: true })
    if (this.cli.dryRun) {
      console.log(`dsh-desktop package: [dry-run] electron-builder projectDir=${STAGING} output=${OUT_DIR}`)
      return []
    }
    // electron-builder skips code signing on pull-request CI builds unless
    // forced; the pipeline signs on every context, so the PR lane and the
    // release legs produce the same ad-hoc signed artifact.
    process.env.CSC_FOR_PULL_REQUEST = 'true'
    await build({
      projectDir: STAGING,
      config: {
        ...config,
        // The installed devDependency is the single source of the production
        // Electron version; the yml value only documents the pairing.
        electronVersion: await this.electronVersion(),
        directories: { output: OUT_DIR },
        electronDist: this.electronDist(),
      },
    })
    // electron-builder reports no stable artifact path, and the dir
    // target's output directory carries an architecture suffix on non-x64
    // hosts; discover the produced bundle and dmg instead.
    const artifacts = discoverArtifacts(await readdir(OUT_DIR), OUT_DIR)
    if (artifacts.length === 0) {
      throw new Error(`dsh-desktop package: no product after electron-builder; inspect ${OUT_DIR}.`)
    }
    return artifacts
  }

  /** Every produced bundle must ship the custom icon, not the Electron default. */
  async verifyBundleIcons(products: string[]): Promise<void> {
    for (const product of products.filter(path => path.endsWith('.app'))) {
      if (hasCustomBundleIcon(product)) continue
      throw new Error(
        `dsh-desktop package: bundle ${product} does not carry the custom icon (Contents/Resources/icon.icns + CFBundleIconFile reference).`,
      )
    }
  }

  /** Verify each produced artifact's signature and record its Gatekeeper verdict. */
  async verifySigning(products: string[], identity: string | null | undefined): Promise<void> {
    if (process.platform !== 'darwin') {
      console.log('dsh-desktop package: skipping signing verification (macOS only)')
      return
    }
    // Gatekeeper rejects every ad-hoc signature via spctl on modern macOS —
    // even an unquarantined local build — while launch itself is only
    // assessed for quarantine-flagged downloads. The verdict is recorded
    // evidence under ad-hoc signing and becomes a hard gate once a real
    // Developer ID identity signs the artifacts.
    const enforceGatekeeper = gatekeeperIsHardGate(identity)
    for (const artifact of products) {
      for (const step of signEvidenceSteps(artifact, enforceGatekeeper)) {
        if (this.cli.dryRun) {
          console.log(`dsh-desktop package: [dry-run] ${formatCommand(step.command, [...step.args])}`)
          continue
        }
        try {
          await this.runEvidenceStep(step)
        } catch (error) {
          // The expected verdict under ad-hoc signing: Gatekeeper rejects the
          // signature via spctl (a non-zero exit), and the pipeline records
          // it as evidence instead of failing the build. A spawn failure
          // means the check never ran and must fail the build.
          if (step.required) throw error
          if (error instanceof Error && error.message.includes('failed to spawn')) throw error
          console.warn(`dsh-desktop package: ${step.label} rejected the artifact (recorded as evidence): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  /**
   * Run one evidence step; hard gates retry twice because a freshly built
   * bundle can fail `codesign --verify` with "code has no resources but
   * signature indicates they must be present" while the signing daemon or
   * the image build still touches it on a busy runner — the observed PR
   * lane failure that never reproduced on the release legs. A settled
   * re-verification is the same evidence; all attempts failing fails the
   * build.
   */
  private async runEvidenceStep(step: SignEvidenceStep): Promise<void> {
    const attempts = step.required ? 3 : 1
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.run(step.label, step.command, [...step.args])
        return
      } catch (error) {
        lastError = error
        if (attempt < attempts) {
          console.warn(`dsh-desktop package: ${step.label} attempt ${attempt}/${attempts} failed; re-verifying: ${error instanceof Error ? error.message : String(error)}`)
          await new Promise(resolveWait => setTimeout(resolveWait, 1_500))
        }
      }
    }
    throw lastError
  }

  printProducts(products: string[]): void {
    console.log(this.cli.dryRun ? 'dsh-desktop package: [dry-run] would produce:' : 'dsh-desktop package: products:')
    for (const path of products) console.log(`  ${path}`)
  }

  /** Run one subprocess with inherited stdio; non-zero exits include the command. */
  private async run(label: string, command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`dsh-desktop package: [dry-run] ${printable}`)
      return
    }
    console.log(`dsh-desktop package: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: repoRoot,
        stdio: 'inherit',
        // Artifact builds must not mutate or validate a developer's Git hooks
        // or stall on pnpm's interactive modules-dir purge.
        env: { ...process.env, ...env, CI: 'true' },
      })
      child.once('error', (error) => {
        reject(new Error(`dsh-desktop package: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`dsh-desktop package: ${label} failed (${cause}): ${printable}`))
      })
    })
  }
}

async function main(): Promise<void> {
  const cli = PackageCli.parse(process.argv.slice(2))
  const pipeline = new DesktopPackageBuild(cli)
  console.log(`dsh-desktop package: staging: ${STAGING}`)
  console.log(`dsh-desktop package: output: ${OUT_DIR}`)
  await pipeline.verifyClosure()
  await pipeline.buildLib()
  await pipeline.deployStaging()
  await pipeline.restoreElectronDist()
  await pipeline.rebuildPty()
  await pipeline.validateRuntime()
  const builderConfig = yaml.load(await readFile(BUILDER_CONFIG, 'utf8')) as Configuration
  const products = await pipeline.package(builderConfig)
  await pipeline.verifyBundleIcons(products)
  await pipeline.verifySigning(products, builderConfig.mac?.identity)
  pipeline.printProducts(products)
}

await main()
