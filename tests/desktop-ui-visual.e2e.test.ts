import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const outputDirectories = new Set<string>()

function electronExecutable(): string {
  const packageRoot = join(ROOT, 'apps', 'desktop', 'node_modules', 'electron')
  const pathFile = join(packageRoot, 'path.txt')
  if (!existsSync(pathFile)) {
    execFileSync(process.execPath, [join(packageRoot, 'install.js')], { cwd: ROOT })
  }
  return join(packageRoot, 'dist', readFileSync(pathFile, 'utf8').trim())
}

beforeAll(() => {
  execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    '--filter', '@dsh-desktop/ui', 'run', 'build',
  ], { cwd: ROOT, stdio: 'pipe' })
})

afterAll(() => {
  for (const directory of outputDirectories) rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'darwin')('desktop UI visual evidence', () => {
  it('renders formal desktop contributions with the published sidebar in Electron', () => {
    const output = mkdtempSync(join(tmpdir(), 'dsh-desktop-ui-evidence-'))
    outputDirectories.add(output)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(electronExecutable(), [
      join(ROOT, 'tests', 'fixtures', 'ui-visual-evidence.mjs'),
      output,
    ], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    })

    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    const line = result.stdout.split('\n').find(candidate => candidate.startsWith('UI_VISUAL_EVIDENCE '))
    expect(line).toBeDefined()
    const evidence = JSON.parse((line as string).slice('UI_VISUAL_EVIDENCE '.length))
    expect(evidence).toEqual([
      expect.objectContaining({
        appearance: 'dark', material: 'glass-dark', collapsed: 'false',
        officialNewSession: 'New session', officialCount: '3', collapseVisible: true, revealVisible: false,
      }),
      expect.objectContaining({
        appearance: 'light', material: 'glass-light', collapsed: 'true',
        officialCount: '3', collapseVisible: false, revealVisible: true,
      }),
      expect.objectContaining({
        appearance: 'light', transparency: 'opaque', material: 'opaque', collapsed: 'false',
        officialNewSession: 'New session', officialCount: '3', collapseVisible: true, revealVisible: false,
      }),
    ])
    const frames = ['ui-expanded-dark.png', 'ui-collapsed-light.png', 'ui-expanded-opaque.png']
      .map(file => readFileSync(join(output, file)))
    expect(frames.every(frame => frame.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')).toBe(true)
    expect(frames.every(frame => frame.byteLength > 20_000)).toBe(true)
    expect(frames[0]?.equals(frames[1] as Buffer)).toBe(false)
    expect(frames[1]?.equals(frames[2] as Buffer)).toBe(false)
  }, 60_000)
})
