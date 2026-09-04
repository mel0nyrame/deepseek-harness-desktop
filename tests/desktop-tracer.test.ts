import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTracerInvocation, prepareTracerProfile } from '../apps/desktop/src/tracer.js'

const temporaryDirectories = new Set<string>()

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-tracer-'))
  temporaryDirectories.add(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.clear()
})

describe('desktop tracer inputs', () => {
  it('retains ordered replay files for the isolated real-product UI journey', () => {
    const root = temporary()
    const workspace = join(root, 'deepseek-harness')
    const frames = join(root, 'frames')
    const replayFiles = [1, 2, 3, 4].map(index => join(root, `session-${String(index)}.jsonl`))
    mkdirSync(workspace)
    for (const replayFile of replayFiles) writeFileSync(replayFile, '{}\n')

    expect(parseTracerInvocation([
      'electron', 'app', '--tracer-ui', workspace,
      '--replay-file', replayFiles[0] as string,
      '--replay-child-file', replayFiles[1] as string,
      '--replay-child-file', replayFiles[2] as string,
      '--replay-child-file', replayFiles[3] as string,
      '--frames-dir', frames,
    ])).toEqual({
      kind: 'ui',
      pickedDirectory: workspace,
      replayFile: replayFiles[0],
      replayChildFiles: replayFiles.slice(1),
      framesDir: frames,
    })
  })

  it('rejects a UI journey without every replay script it consumes', () => {
    const root = temporary()
    const workspace = join(root, 'deepseek-harness')
    const frames = join(root, 'frames')
    const replayFiles = [1, 2, 3].map(index => join(root, `session-${String(index)}.jsonl`))
    mkdirSync(workspace)
    for (const replayFile of replayFiles) writeFileSync(replayFile, '{}\n')

    expect(() => parseTracerInvocation([
      'electron', 'app', '--tracer-ui', workspace,
      '--replay-file', replayFiles[0] as string,
      '--replay-child-file', replayFiles[1] as string,
      '--replay-child-file', replayFiles[2] as string,
      '--frames-dir', frames,
    ])).toThrow('desktop UI tracer requires exactly three --replay-child-file values')
  })

  it('writes deterministic replay and UI preferences only inside the tracer home', () => {
    const root = temporary()
    const home = join(root, 'home')
    const provider = join(root, 'provider')
    const replayFiles = [1, 2, 3, 4].map(index => join(root, `session-${String(index)}.jsonl`))
    mkdirSync(provider)
    for (const replayFile of replayFiles) writeFileSync(replayFile, '{}\n')

    prepareTracerProfile(home, provider, replayFiles[0] as string, {
      acknowledgeWelcome: true,
      replayPaceMs: 80,
      replayChildFiles: replayFiles.slice(1),
      locale: 'en',
      appearance: 'light',
    })

    const patch = readFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain(`file: ${JSON.stringify(replayFiles[0])}`)
    expect(patch).toContain(`- ${JSON.stringify(replayFiles[1])}`)
    expect(patch).toContain(`- ${JSON.stringify(replayFiles[2])}`)
    expect(patch).toContain(`- ${JSON.stringify(replayFiles[3])}`)
    expect(patch).toContain('paceMs: 80')
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe([
      'locale:',
      '  preference: en',
      'ui-theme:',
      '  preference: light',
      'ui-onboarding:',
      '  welcomeNoticeVersion: 2026-08-13.1',
      '',
    ].join('\n'))
    expect(existsSync(join(root, 'settings.yaml'))).toBe(false)
  })
})
