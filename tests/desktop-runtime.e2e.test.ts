import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeRuntimeOutput, scrubRuntimeEnvironment } from '../scripts/runtime-output.js'

const ROOT = resolve(import.meta.dirname, '..')
const RUNTIME = join(ROOT, '.artifacts', 'runtime-e2e')
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'terminal-turn', 'session.jsonl')
const temporaryDirectories = new Set<string>()

function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.add(directory)
  return directory
}

function electronExecutable(): string {
  const packageRoot = join(ROOT, 'apps', 'desktop', 'node_modules', 'electron')
  const pathFile = join(packageRoot, 'path.txt')
  if (!existsSync(pathFile)) {
    execFileSync(process.execPath, [join(packageRoot, 'install.js')], { cwd: ROOT })
  }
  const relative = readFileSync(pathFile, 'utf8').trim()
  return join(packageRoot, 'dist', relative)
}

function launch(home: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(electronExecutable(), [RUNTIME, ...args], {
    cwd: home,
    env: {
      ...scrubRuntimeEnvironment(process.env),
      DSH_HOME: home,
      DSH_DESKTOP_RUNTIME_ROOT: RUNTIME,
    },
    encoding: 'utf8',
    timeout: 180_000,
  })
}

function textOutput(value: string | Buffer | null): string {
  return typeof value === 'string' ? value : value?.toString('utf8') ?? ''
}

function ownedProcesses(home: string): string {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter(line => line.includes(home))
    .join('\n')
}

beforeAll(() => {
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    'run', 'runtime:assemble', '--', '--output', RUNTIME,
  ], {
    cwd: ROOT,
    env: { ...scrubRuntimeEnvironment(process.env), CI: 'true' },
    stdio: 'pipe',
  })
}, 120_000)

afterAll(() => {
  removeRuntimeOutput(RUNTIME)
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
})

describe('integrated Electron runtime', () => {
  it('renders one ordered keyless terminal turn over the real embedded DSH child', () => {
    const home = temporary('dsh-desktop-e2e-home-')
    const frames = temporary('dsh-desktop-e2e-frames-')

    const result = launch(home, ['--tracer', '--replay-file', FIXTURE, '--frames-dir', frames])

    expect(result.error).toBeUndefined()
    expect(result.status, textOutput(result.stderr)).toBe(0)
    expect(textOutput(result.stdout)).toContain('TRACER_OK no-loopback-listener')
    expect(textOutput(result.stdout)).toContain('TRACER_LAYOUT centered-system-status')
    expect(textOutput(result.stdout)).toContain('TRACER_STATE complete')
    expect(textOutput(result.stdout)).toMatch(/TRACER_VISIBLE terminal-result \d+ bright pixel/)
    expect(textOutput(result.stdout)).toContain('TRACER_OK terminal-session')
    const completed = readdirSync(frames).find(file => file.endsWith('-complete.png'))
    expect(completed).toBeDefined()
    const png = readFileSync(join(frames, completed as string))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    expect(width).toBeGreaterThanOrEqual(900)
    expect(height).toBeGreaterThanOrEqual(640)
    expect(png.byteLength).toBeGreaterThan(20_000)
    expect(ownedProcesses(home)).toBe('')
  }, 180_000)

  it('joins a child when Electron quits during startup', () => {
    const home = temporary('dsh-desktop-startup-quit-')

    const result = launch(home, ['--quit-during-startup'])

    expect(result.error).toBeUndefined()
    expect(result.status, textOutput(result.stderr)).toBe(0)
    expect(ownedProcesses(home)).toBe('')
  }, 30_000)

  it('restarts once after configuration failure and leaves no owned process', () => {
    const home = temporary('dsh-desktop-config-failure-')
    const profile = join(home, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'cordis.patch.yml'), '- insert: [not valid yaml\n  trailing:')

    const result = launch(home, [])

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(textOutput(result.stderr)).toContain('initial child generation failed; restarting once')
    expect(textOutput(result.stderr)).toContain('startup failed')
    expect(ownedProcesses(home)).toBe('')
  }, 30_000)
})
