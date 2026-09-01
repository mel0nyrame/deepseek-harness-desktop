import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { scrubRuntimeEnvironment } from '../scripts/runtime-output.js'
import {
  discoverArtifacts,
  gatekeeperIsHardGate,
  readPackagedAppEvidence,
  signEvidenceSteps,
} from '../scripts/artifact-evidence.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const BUILDER_CONFIG = path.join(ROOT, 'apps/desktop/electron-builder.yml')

describe('desktop package contract', () => {
  it('exposes exact-version package and installed-smoke commands', () => {
    const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const shell = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'apps/desktop/package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string> }
    const runtime = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'runtime/runtime-manifest.json'), 'utf8'),
    ) as { build?: { electron?: { version?: string } } }
    const config = parse(fs.readFileSync(BUILDER_CONFIG, 'utf8')) as {
      electronVersion?: string
    }
    expect(root.scripts).toMatchObject({
      package: 'node scripts/package-desktop.ts',
      'test:package': 'vitest run tests/desktop-package.test.ts tests/desktop-packaged.e2e.test.ts',
    })
    expect(root.devDependencies?.['electron-builder']).toBe('26.15.3')
    expect([
      config.electronVersion,
      runtime.build?.electron?.version,
    ]).toEqual([
      shell.devDependencies?.electron,
      shell.devDependencies?.electron,
    ])
  })

  it('places only a bootstrap in asar and keeps the complete runtime on the real filesystem', () => {
    const config = parse(fs.readFileSync(BUILDER_CONFIG, 'utf8')) as Record<string, unknown>

    expect(config).toMatchObject({
      appId: 'ai.deepseek.dsh-desktop',
      productName: 'DSH Desktop',
      electronVersion: '43.4.0',
      asar: true,
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
      files: ['lib/packaged-main.js', 'package.json', '!node_modules/**'],
      mac: {
        icon: 'build/icon.png',
        identity: '-',
        hardenedRuntime: false,
        category: 'public.app-category.developer-tools',
        target: ['dmg', 'dir'],
      },
    })
    expect(config).not.toHaveProperty('extraResources')
  })

  it('reports the complete packaging pipeline without mutating outputs in dry-run mode', () => {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/package-desktop.ts'), '--dry-run',
    ], {
      cwd: ROOT,
      env: scrubRuntimeEnvironment(process.env),
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('build: pnpm run build')
    expect(result.stdout).toContain('runtime assembly:')
    expect(result.stdout).toContain('native ABI validation:')
    expect(result.stdout).toContain('electron-builder:')
    expect(result.stdout).toContain('artifact evidence:')
  })

  it('reads product identity and native-runtime evidence from the application bundle', () => {
    const app = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'dsh-package-evidence-'))
    const resources = path.join(app, 'Contents', 'Resources')
    const runtime = path.join(resources, 'runtime')
    const target = `darwin-${process.arch}`
    const ptyArtifacts = [
      `prebuilds/${target}/pty.node`,
      `prebuilds/${target}/spawn-helper`,
    ]
    const koffiPackage = `@koromix/koffi-darwin-${process.arch}`
    const koffiArtifact = `darwin_${process.arch}/koffi.node`
    try {
      fs.mkdirSync(path.join(runtime, 'node_modules', '@dsh-desktop', 'bundle'), { recursive: true })
      fs.mkdirSync(path.join(runtime, 'lib'), { recursive: true })
      fs.mkdirSync(path.join(runtime, 'node_modules', 'node-pty', `prebuilds/${target}`), { recursive: true })
      fs.mkdirSync(path.join(runtime, 'node_modules', koffiPackage, `darwin_${process.arch}`), { recursive: true })
      fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), [
        '<plist><dict>',
        '<key>CFBundleIdentifier</key><string>ai.deepseek.dsh-desktop</string>',
        '<key>CFBundleIconFile</key><string>icon.icns</string>',
        '</dict></plist>',
      ].join(''))
      fs.writeFileSync(path.join(resources, 'app.asar'), 'shell')
      fs.writeFileSync(path.join(resources, 'icon.icns'), 'icon')
      fs.writeFileSync(path.join(runtime, 'lib', 'main.js'), 'main')
      fs.writeFileSync(path.join(runtime, 'lib', 'preload.cjs'), 'preload')
      fs.writeFileSync(path.join(runtime, 'renderer.html'), 'renderer')
      fs.writeFileSync(path.join(runtime, 'runtime-manifest.json'), JSON.stringify({
        product: {
          appId: 'ai.deepseek.dsh-desktop',
          profile: 'desktop',
          runtimeDownloads: false,
        },
        platformDependencies: {
          'node-pty': {
            targets: { [target]: { package: 'node-pty', artifacts: ptyArtifacts } },
          },
          koffi: {
            targets: { [target]: { package: koffiPackage, artifacts: [koffiArtifact] } },
          },
        },
      }))
      fs.writeFileSync(path.join(runtime, 'node_modules', '@dsh-desktop', 'bundle', 'cordis.patch.yml'), '- id: desktop\n')
      for (const artifact of ptyArtifacts) {
        fs.writeFileSync(path.join(runtime, 'node_modules', 'node-pty', artifact), artifact)
      }
      fs.chmodSync(path.join(runtime, 'node_modules', 'node-pty', ptyArtifacts[1] as string), 0o755)
      fs.writeFileSync(path.join(runtime, 'node_modules', koffiPackage, koffiArtifact), koffiArtifact)

      expect(readPackagedAppEvidence(app)).toEqual({
        appId: 'ai.deepseek.dsh-desktop',
        profile: 'desktop',
        runtimeDownloads: false,
        nativeArtifacts: [
          `node-pty/${ptyArtifacts[0]}`,
          `node-pty/${ptyArtifacts[1]}`,
          `${koffiPackage}/${koffiArtifact}`,
        ],
      })
    } finally {
      fs.rmSync(app, { recursive: true, force: true })
    }
  })

  it('gates signatures and disk-image integrity while recording ad-hoc Gatekeeper results', () => {
    const app = '/out/mac-arm64/DSH Desktop.app'
    const dmg = '/out/DSH Desktop-0.1.0-arm64.dmg'

    expect(gatekeeperIsHardGate('-')).toBe(false)
    expect(gatekeeperIsHardGate('Developer ID Application: DSH Desktop')).toBe(true)
    expect(signEvidenceSteps(app, false).map(step => [step.label, step.required])).toEqual([
      ['signature verification', true],
      ['signature identity', false],
      ['gatekeeper assessment', false],
    ])
    expect(signEvidenceSteps(dmg, true).map(step => [step.label, step.required])).toEqual([
      ['dmg integrity', true],
      ['dmg gatekeeper assessment', true],
    ])
  })

  it('discovers only the application bundle and dmg products', () => {
    const output = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'dsh-products-'))
    try {
      fs.mkdirSync(path.join(output, 'mac-arm64', 'DSH Desktop.app'), { recursive: true })
      fs.writeFileSync(path.join(output, 'DSH Desktop-0.1.0-arm64.dmg'), '')
      fs.writeFileSync(path.join(output, 'DSH Desktop-0.1.0-arm64.dmg.blockmap'), '')

      expect(discoverArtifacts(fs.readdirSync(output), output)).toEqual([
        path.join(output, 'DSH Desktop-0.1.0-arm64.dmg'),
        path.join(output, 'mac-arm64', 'DSH Desktop.app'),
      ])
    } finally {
      fs.rmSync(output, { recursive: true, force: true })
    }
  })
})
