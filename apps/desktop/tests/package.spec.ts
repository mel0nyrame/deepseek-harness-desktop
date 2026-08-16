import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverArtifacts, gatekeeperIsHardGate, signEvidenceSteps } from '../scripts/artifact-evidence.ts'

const BUILDER_YML = fileURLToPath(new URL('../electron-builder.yml', import.meta.url))

describe('macOS artifact evidence', () => {
  it('keeps the builder ad-hoc signed, dmg-delivered, and unpublishing', async () => {
    const config = yaml.load(await readFile(BUILDER_YML, 'utf8')) as {
      publish: string
      mac: { identity: string; hardenedRuntime: boolean; target: string[] }
    }
    expect(config.publish).toBe('never')
    expect(config.mac.identity).toBe('-')
    expect(config.mac.hardenedRuntime).toBe(false)
    expect(config.mac.target).toEqual(['dmg', 'dir'])
  })

  it('gates application bundles through codesign and enforces Gatekeeper under Developer ID signing', () => {
    const steps = signEvidenceSteps('/out/mac-arm64/DSH Desktop.app', true)
    expect(steps).toEqual([
      {
        label: 'signature verification',
        command: 'codesign',
        args: ['--verify', '--deep', '--strict', '--verbose=2', '/out/mac-arm64/DSH Desktop.app'],
        required: true,
      },
      {
        label: 'signature identity',
        command: 'codesign',
        args: ['-d', '--verbose=2', '/out/mac-arm64/DSH Desktop.app'],
        required: false,
      },
      {
        label: 'gatekeeper assessment',
        command: 'spctl',
        args: ['--assess', '--type', 'execute', '--verbose=4', '/out/mac-arm64/DSH Desktop.app'],
        required: true,
      },
    ])
  })

  it('records the Gatekeeper verdict as evidence only under ad-hoc signing', () => {
    const steps = signEvidenceSteps('/out/mac-arm64/DSH Desktop.app', false)
    expect(steps.map(step => [step.label, step.required])).toEqual([
      ['signature verification', true],
      ['signature identity', false],
      ['gatekeeper assessment', false],
    ])
  })

  it('gates disk images through hdiutil and Gatekeeper open assessment', () => {
    const steps = signEvidenceSteps('/out/DSH Desktop-0.1.0-rc.5-arm64.dmg', true)
    expect(steps).toEqual([
      {
        label: 'dmg integrity',
        command: 'hdiutil',
        args: ['verify', '/out/DSH Desktop-0.1.0-rc.5-arm64.dmg'],
        required: true,
      },
      {
        label: 'dmg gatekeeper assessment',
        command: 'spctl',
        args: ['--assess', '--type', 'open', '--verbose=4', '/out/DSH Desktop-0.1.0-rc.5-arm64.dmg'],
        required: true,
      },
    ])
  })

  it('records the dmg Gatekeeper verdict as evidence only under ad-hoc signing', () => {
    const steps = signEvidenceSteps('/out/DSH Desktop-0.1.0-rc.5-arm64.dmg', false)
    expect(steps.map(step => [step.label, step.required])).toEqual([
      ['dmg integrity', true],
      ['dmg gatekeeper assessment', false],
    ])
  })

  describe('gatekeeperIsHardGate', () => {
    it('records the verdict as evidence for unsigned and ad-hoc identities', () => {
      expect(gatekeeperIsHardGate(undefined)).toBe(false)
      expect(gatekeeperIsHardGate(null)).toBe(false)
      expect(gatekeeperIsHardGate('-')).toBe(false)
    })

    it('enforces the verdict once a Developer ID identity signs', () => {
      expect(gatekeeperIsHardGate('Developer ID Application: DeepSeek (TEAM1234)')).toBe(true)
    })
  })

  describe('discoverArtifacts', () => {
    let outDir: string | undefined
    afterEach(async () => {
      if (outDir !== undefined) await rm(outDir, { recursive: true, force: true })
      outDir = undefined
    })

    it('finds the bundle below the mac-prefixed dir and the dmg beside it', async () => {
      outDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-products-'))
      await mkdir(join(outDir, 'mac-arm64', 'DSH Desktop.app'), { recursive: true })
      await writeFile(join(outDir, 'DSH Desktop-0.1.0-rc.5-arm64.dmg'), '')
      await writeFile(join(outDir, 'DSH Desktop-0.1.0-rc.5-arm64.dmg.blockmap'), '')

      const artifacts = discoverArtifacts([
        'mac-arm64',
        'DSH Desktop-0.1.0-rc.5-arm64.dmg',
        'DSH Desktop-0.1.0-rc.5-arm64.dmg.blockmap',
        'builder-debug.yml',
      ], outDir)
      expect(artifacts).toEqual([
        join(outDir, 'mac-arm64', 'DSH Desktop.app'),
        join(outDir, 'DSH Desktop-0.1.0-rc.5-arm64.dmg'),
      ])
    })

    it('ignores mac-prefixed entries that hold no application bundle', async () => {
      outDir = await mkdtemp(join(tmpdir(), 'dsh-desktop-products-'))
      await writeFile(join(outDir, 'mac-builder-state.txt'), '')
      expect(discoverArtifacts(['mac-builder-state.txt'], outDir)).toEqual([])
    })
  })
})
