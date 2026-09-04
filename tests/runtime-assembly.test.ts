import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { removeRuntimeOutput, scrubRuntimeEnvironment } from '../scripts/runtime-output.js'
import { verifyRuntimeClosure } from '../scripts/verify-runtime-closure.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const MANIFEST = path.join(ROOT, 'runtime/runtime-manifest.json')
const OUTPUT = path.join(ROOT, '.artifacts/runtime-test')
const CLEAN_ENV = scrubRuntimeEnvironment(process.env)

interface RuntimeManifest {
  schemaVersion: number
  product: { appId: string; profile: string; runtimeDownloads: boolean }
  dshVersion: string
  upstreamCommit: string
  entryPackages: Record<string, { version: string; entrypoints: string[] }>
  platformDependencies: Record<string, { version: string; targets: Record<string, { package: string; artifacts: string[] }> }>
  patches: Array<{ package: string; version: string; file: string; sha256: string; rationale: string; upstream: string; removeWhen: string; tests: string[] }>
  build: {
    packageManager: string
    lockfile: string
    lockfileSha256: string
    assemblyScript: string
    output: string
    electron: { version: string; runAsNode: boolean }
    package: { config: string; output: string; runtimePath: string }
  }
}

function manifest(): RuntimeManifest {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as RuntimeManifest
}

afterAll(() => removeRuntimeOutput(OUTPUT))

describe('published DSH runtime', () => {
  it('records one consistent rc.8 runtime contract', () => {
    const value = manifest()
    expect(value).toMatchObject({
      schemaVersion: 2,
      product: {
        appId: 'ai.deepseek.dsh-desktop',
        profile: 'desktop',
        runtimeDownloads: false,
      },
      dshVersion: '0.1.0-rc.8',
      upstreamCommit: '141eb6fef83422698aef7a981029e843e8161534',
      entryPackages: {
        '@deepseek-ai/dsh': { version: '0.1.0-rc.8', entrypoints: ['lib/bin.js'] },
      },
      platformDependencies: {
        'node-pty': {
          version: '1.2.0-beta.15',
          targets: {
            'linux-x64': {
              package: 'node-pty',
              artifacts: ['prebuilds/linux-x64/pty.node'],
            },
          },
        },
        koffi: {
          version: '3.1.0',
          targets: {
            'linux-x64': {
              package: '@koromix/koffi-linux-x64',
              artifacts: ['linux_x64/koffi.node'],
            },
          },
        },
      },
      build: {
        packageManager: 'pnpm@11.7.0',
        lockfile: 'pnpm-lock.yaml',
        assemblyScript: 'scripts/assemble-runtime.ts',
        output: '.artifacts/runtime',
        electron: { version: '43.4.0', runAsNode: true },
        package: {
          config: 'apps/desktop/electron-builder.yml',
          output: 'apps/desktop/dist',
          runtimePath: 'Contents/Resources/runtime',
        },
      },
    })
    const gitlink = execFileSync('git', ['ls-files', '-s', 'upstream'], { cwd: ROOT, env: CLEAN_ENV, encoding: 'utf8' }).trim()
    expect(gitlink).toBe(`160000 ${value.upstreamCommit} 0\tupstream`)
    expect(() => execFileSync('git', ['check-ignore', value.build.output], { cwd: ROOT, env: CLEAN_ENV })).not.toThrow()
    const lockfileDigest = execFileSync('shasum', ['-a', '256', value.build.lockfile], { cwd: ROOT, env: CLEAN_ENV, encoding: 'utf8' }).split(' ')[0]
    expect(lockfileDigest).toBe(value.build.lockfileSha256)
    expect(value.patches).toHaveLength(5)
    const workspace = parse(fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { patchedDependencies?: Record<string, string> }
    expect(workspace.patchedDependencies).toEqual(Object.fromEntries(value.patches.map(patch => [`${patch.package}@${patch.version}`, patch.file])))
    for (const patch of value.patches) {
      expect(fs.existsSync(path.join(ROOT, patch.file))).toBe(true)
      const actual = execFileSync('shasum', ['-a', '256', patch.file], { cwd: ROOT, env: CLEAN_ENV, encoding: 'utf8' }).split(' ')[0]
      expect(actual).toBe(patch.sha256)
      expect(patch.rationale).not.toBe('')
      expect(patch.upstream).not.toBe('')
      expect(patch.removeWhen).not.toBe('')
      expect(patch.tests.length).toBeGreaterThan(0)
    }
  })

  it('refuses to replace the filesystem root', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/assemble-runtime.ts'), '--output', path.parse(ROOT).root], {
      cwd: ROOT,
      env: CLEAN_ENV,
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Refusing to replace unsafe runtime output')
  })

  it('unlinks a link-shaped output without deleting its target', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-output-'))
    try {
      const target = path.join(parent, 'target')
      const output = path.join(parent, 'output')
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, 'keep'), 'keep')
      fs.symlinkSync(target, output, process.platform === 'win32' ? 'junction' : 'dir')

      removeRuntimeOutput(output)

      expect(fs.existsSync(output)).toBe(false)
      expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('keep')
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('removes credentials from runtime assembly subprocesses', () => {
    expect(scrubRuntimeEnvironment({
      PATH: '/bin',
      DEEPSEEK_API_KEY: 'secret',
      NPM_TOKEN: 'secret',
      CLIENT_SECRET: 'secret',
      DB_PASSWORD: 'secret',
    })).toEqual({ PATH: '/bin' })
  })

  it('rejects source-relative dependency inputs in an assembled runtime', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-closure-'))
    try {
      fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({
        name: '@dsh-desktop/shell',
        version: '0.1.0',
        dependencies: { '@dsh-desktop/bundle': 'link:../../packages/bundle' },
      }))

      expect(() => verifyRuntimeClosure(runtime)).toThrow(
        'Source-relative dependency in assembled runtime',
      )
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })

  it.each([
    ['main', { main: '../legacy/main.js' }],
    ['bin', { bin: { dsh: '../../source/bin.js' } }],
    ['exports', { exports: { '.': '../source/index.js' } }],
  ])('rejects %s entries that escape their runtime package', (_field, entry) => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-entry-'))
    try {
      fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({
        name: 'escaping-package',
        ...entry,
      }))

      expect(() => verifyRuntimeClosure(runtime)).toThrow(
        'Runtime entry escapes its package',
      )
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })

  it('rejects a declared runtime entry that is absent from the package', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-missing-entry-'))
    try {
      fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({
        name: 'missing-entry-package',
        main: './missing.js',
      }))

      expect(() => verifyRuntimeClosure(runtime)).toThrow(
        'Runtime entry is missing',
      )
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })

  it('rejects a declared runtime export that is absent from the package', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-missing-export-'))
    try {
      fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({
        name: 'missing-export-package',
        exports: { '.': './missing.js' },
      }))

      expect(() => verifyRuntimeClosure(runtime)).toThrow(
        'Runtime entry is missing',
      )
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })

  it('rejects source references that escape their runtime package', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-source-entry-'))
    try {
      fs.mkdirSync(path.join(runtime, 'lib'))
      fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({
        name: 'source-entry-package',
        main: './lib/main.js',
      }))
      fs.writeFileSync(path.join(runtime, 'lib/main.js'), "import '../../../source/main.js'\n")

      expect(() => verifyRuntimeClosure(runtime)).toThrow(
        'Runtime source reference escapes its package',
      )
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })

  it('rejects file URL source references that escape their runtime package', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-file-url-'))
    try {
      fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({
        name: 'file-url-package',
        main: './main.js',
      }))
      fs.writeFileSync(path.join(runtime, 'main.js'), "import 'file:///repo/source/main.js'\n")

      expect(() => verifyRuntimeClosure(runtime)).toThrow(
        'Runtime source reference escapes its package',
      )
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })

  it('allows nested package manifests to reference their containing package', () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-nested-entry-'))
    try {
      const packageRoot = path.join(runtime, 'node_modules', '@scope', 'package')
      fs.mkdirSync(path.join(packageRoot, 'node'), { recursive: true })
      fs.mkdirSync(path.join(packageRoot, 'dist/node'), { recursive: true })
      fs.writeFileSync(path.join(runtime, 'package.json'), '{"name":"runtime"}')
      fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"@scope/package"}')
      fs.writeFileSync(
        path.join(packageRoot, 'node', 'package.json'),
        '{"main":"../dist/node/index.js"}',
      )
      fs.writeFileSync(path.join(packageRoot, 'dist/node/index.js'), '')

      expect(() => verifyRuntimeClosure(runtime)).not.toThrow()
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true })
    }
  })

  it('rejects runtime links that escape the assembled closure', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-link-'))
    const runtime = path.join(parent, 'runtime')
    const external = path.join(parent, 'source-package')
    try {
      fs.mkdirSync(path.join(runtime, 'node_modules'), { recursive: true })
      fs.mkdirSync(external)
      fs.writeFileSync(path.join(runtime, 'package.json'), '{"name":"runtime"}')
      fs.writeFileSync(path.join(external, 'package.json'), '{"name":"source-package"}')
      fs.symlinkSync(external, path.join(runtime, 'node_modules', 'source-package'), 'dir')

      expect(() => verifyRuntimeClosure(runtime)).toThrow(
        'Runtime link escapes the assembled closure',
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses output outside the generated runtime root', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/assemble-runtime.ts'), '--output', path.join(ROOT, 'packages')], {
      cwd: ROOT,
      env: CLEAN_ENV,
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Refusing to replace unsafe runtime output')
  })

  it('assembles every declared entrypoint without source dependencies', () => {
    const value = manifest()
    const workspace = parse(fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as {
      packages?: string[]
    }
    expect(workspace.packages?.some(pattern => pattern.includes('upstream'))).toBe(false)
    execFileSync(process.execPath, [path.join(ROOT, value.build.assemblyScript), '--output', OUTPUT], {
      cwd: ROOT,
      env: { ...CLEAN_ENV, CI: 'true' },
      stdio: 'pipe',
    })
    for (const [name, entry] of Object.entries(value.entryPackages)) {
      const packageRoot = name === '@dsh-desktop/shell' ? OUTPUT : path.join(OUTPUT, 'node_modules', name)
      const relativeToSource = path.relative(path.join(ROOT, 'upstream'), fs.realpathSync(packageRoot))
      expect(relativeToSource === '..' || relativeToSource.startsWith(`..${path.sep}`)).toBe(true)
      for (const entrypoint of entry.entrypoints) {
        expect(fs.existsSync(path.join(packageRoot, entrypoint))).toBe(true)
      }
    }
    const desktopManifests = [
      path.join(OUTPUT, 'package.json'),
      ...fs.readdirSync(path.join(OUTPUT, 'node_modules'), { recursive: true, encoding: 'utf8' })
        .filter(relative => relative.endsWith('package.json'))
        .map(relative => path.join(OUTPUT, 'node_modules', relative)),
    ]
      .map(file => ({ file, value: JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> }))
      .filter(entry => String(entry.value.name).startsWith('@dsh-desktop/'))
    expect(desktopManifests.length).toBeGreaterThanOrEqual(5)
    for (const entry of desktopManifests) {
      expect(entry.value.scripts, `${entry.file} carries source build scripts`).toBeUndefined()
      expect(entry.value.devDependencies, `${entry.file} carries development dependencies`).toBeUndefined()
    }
    const target = `${process.platform}-${process.arch}`
    for (const dependency of Object.values(value.platformDependencies)) {
      const targetDependency = dependency.targets[target]
      expect(targetDependency).toBeDefined()
      for (const artifact of targetDependency?.artifacts ?? []) {
        expect(fs.existsSync(path.join(OUTPUT, 'node_modules', targetDependency?.package ?? '', artifact))).toBe(true)
      }
    }
  }, 120_000)

  it('launches the assembled CLI through Electron-compatible Node behavior', () => {
    const electronPackage = path.join(ROOT, 'apps/desktop/node_modules/electron')
    const electronPathFile = path.join(electronPackage, 'path.txt')
    if (!fs.existsSync(electronPathFile)) {
      execFileSync(process.execPath, [path.join(electronPackage, 'install.js')], { cwd: ROOT, env: CLEAN_ENV })
    }
    const electron = path.join(electronPackage, 'dist', fs.readFileSync(electronPathFile, 'utf8').trim())
    if (!fs.existsSync(electron)) {
      execFileSync(process.execPath, [path.join(electronPackage, 'install.js')], { cwd: ROOT, env: CLEAN_ENV })
    }
    const cli = path.join(OUTPUT, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-smoke-'))
    try {
      const output = execFileSync(electron, [cli, '--help'], {
        cwd: os.tmpdir(),
        env: { ...CLEAN_ENV, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
        encoding: 'utf8',
      })
      expect(output).toContain('Usage: dsh')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})
