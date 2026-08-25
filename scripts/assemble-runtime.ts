import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { parse } from 'yaml'
import { assertRuntimeOutput, removeRuntimeOutput, scrubRuntimeEnvironment } from './runtime-output.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime/runtime-manifest.json'), 'utf8')) as {
  dshVersion: string
  entryPackages: Record<string, { version: string; entrypoints: string[] }>
  platformDependencies: Record<string, { version: string; targets: Record<string, { package: string; artifacts: string[] }> }>
  patches: Array<{ package: string; version: string; file: string; sha256: string }>
  build: { output: string; lockfile: string; lockfileSha256: string }
}
const argv = process.argv.slice(2).filter((argument, index) => argument !== '--' || index !== 0)
const { values } = parseArgs({ args: argv, options: { output: { type: 'string' } } })
const output = path.resolve(ROOT, values.output ?? manifest.build.output)
assertRuntimeOutput(output, path.join(ROOT, '.artifacts'))
const subprocessEnvironment = { ...scrubRuntimeEnvironment(process.env), CI: 'true' }
const lockfileDigest = execFileSync('shasum', ['-a', '256', manifest.build.lockfile], { cwd: ROOT, env: subprocessEnvironment, encoding: 'utf8' }).split(' ')[0]
if (lockfileDigest !== manifest.build.lockfileSha256) throw new Error(`Runtime lockfile digest drift: expected ${manifest.build.lockfileSha256}, found ${lockfileDigest}`)
const workspace = fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
const patchedDependencies = (parse(workspace) as { patchedDependencies?: Record<string, string> }).patchedDependencies ?? {}
const declaredPatches = new Map(manifest.patches.map(patch => [`${patch.package}@${patch.version}`, patch.file]))
for (const patch of manifest.patches) {
  const packageVersion = `${patch.package}@${patch.version}`
  if (patchedDependencies[packageVersion] !== patch.file) throw new Error(`Runtime patch is not configured exactly: ${packageVersion}: ${patch.file}`)
  const digest = execFileSync('shasum', ['-a', '256', patch.file], { cwd: ROOT, env: subprocessEnvironment, encoding: 'utf8' }).split(' ')[0]
  if (digest !== patch.sha256) throw new Error(`Runtime patch digest drift: ${patch.file}`)
}
for (const [packageVersion, file] of Object.entries(patchedDependencies)) {
  if (declaredPatches.get(packageVersion) !== file) throw new Error(`Runtime patch is not declared in the manifest: ${packageVersion}: ${file}`)
}
removeRuntimeOutput(output)
execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
  '--filter', '@dsh-desktop/shell', 'deploy', '--prod', '--legacy',
  '--config.node-linker=hoisted', output,
], { cwd: ROOT, env: subprocessEnvironment, stdio: 'inherit' })
execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install'], {
  cwd: ROOT, env: subprocessEnvironment, stdio: 'inherit',
})

function packageRoot(name: string): string {
  return name === '@dsh-desktop/shell' ? output : path.join(output, 'node_modules', name)
}

function packageManifest(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(packageRoot(name), 'package.json'), 'utf8')) as Record<string, unknown>
}

const runtimePackagePaths = [
  path.join(output, 'package.json'),
  ...fs.readdirSync(path.join(output, 'node_modules'), { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('package.json'))
    .map(file => path.join(output, 'node_modules', file)),
]
for (const packagePath of runtimePackagePaths) {
  const value = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as Record<string, unknown>
  let changed = false
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = value[section]
    if (typeof dependencies !== 'object' || dependencies === null) continue
    for (const [name, specifier] of Object.entries(dependencies as Record<string, unknown>)) {
      if (!String(specifier).startsWith('workspace:')) continue
      const installed = packageManifest(name)
      if (typeof installed.version !== 'string') throw new Error(`Workspace package has no version: ${name}`)
      ;(dependencies as Record<string, unknown>)[name] = installed.version
      changed = true
    }
  }
  if (changed) {
    const replacement = `${packagePath}.desktop-runtime`
    fs.writeFileSync(replacement, `${JSON.stringify(value, undefined, 2)}\n`)
    fs.renameSync(replacement, packagePath)
  }
}
for (const [name, entry] of Object.entries(manifest.entryPackages)) {
  const installed = packageManifest(name)
  if (installed.version !== entry.version) throw new Error(`Runtime version drift for ${name}: expected ${entry.version}, found ${String(installed.version)}`)
  for (const relative of entry.entrypoints) {
    if (!fs.existsSync(path.join(packageRoot(name), relative))) throw new Error(`Missing runtime entrypoint: ${name}/${relative}`)
  }
}
for (const [name, dependency] of Object.entries(manifest.platformDependencies)) {
  const installed = packageManifest(name)
  if (installed.version !== dependency.version) throw new Error(`Platform dependency drift for ${name}: expected ${dependency.version}, found ${String(installed.version)}`)
  const target = `${process.platform}-${process.arch}`
  const targetDependency = dependency.targets[target]
  if (targetDependency === undefined) throw new Error(`Unsupported runtime platform: ${target}`)
  const targetManifest = packageManifest(targetDependency.package)
  if (targetManifest.version !== dependency.version) throw new Error(`Platform package drift for ${targetDependency.package}: expected ${dependency.version}, found ${String(targetManifest.version)}`)
  for (const relative of targetDependency.artifacts) {
    if (!fs.existsSync(path.join(output, 'node_modules', targetDependency.package, relative))) throw new Error(`Missing platform artifact: ${targetDependency.package}/${relative}`)
  }
}
for (const packagePath of runtimePackagePaths) {
  const value = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as Record<string, unknown>
  if (typeof value.name === 'string' && value.name.startsWith('@deepseek-ai/dsh') && value.version !== manifest.dshVersion) {
    throw new Error(`Official DSH version drift for ${value.name}: expected ${manifest.dshVersion}, found ${String(value.version)}`)
  }
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const dependencies = value[section]
    if (typeof dependencies !== 'object' || dependencies === null) continue
    for (const [name, specifier] of Object.entries(dependencies as Record<string, unknown>)) {
      if (String(specifier).startsWith('workspace:')) throw new Error(`Workspace dependency in assembled runtime: ${packagePath} ${name}=${String(specifier)}`)
    }
  }
}
fs.copyFileSync(path.join(ROOT, 'runtime/runtime-manifest.json'), path.join(output, 'runtime-manifest.json'))
console.log(`Assembled DSH ${manifest.dshVersion} runtime at ${output}`)
