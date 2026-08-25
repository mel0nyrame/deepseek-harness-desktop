import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export { TERMINAL_TRACER_PROMPT } from './tracer-contract.js'

/** Deterministic keyless tracer inputs parsed from the Electron command line. */
export interface TracerInvocation {
  readonly replayFile: string
  readonly framesDir?: string
}

/** Parse and validate the optional integrated-runtime tracer invocation. */
export function parseTracerInvocation(argv: readonly string[]): TracerInvocation | undefined {
  const marker = argv.indexOf('--tracer')
  if (marker < 0) return undefined
  const replayIndex = argv.indexOf('--replay-file')
  const replayFile = replayIndex < 0 ? undefined : argv[replayIndex + 1]
  if (replayFile === undefined || !isAbsolute(replayFile) || !existsSync(replayFile)) {
    throw new Error('desktop tracer requires an existing absolute --replay-file')
  }
  const framesIndex = argv.indexOf('--frames-dir')
  const framesDir = framesIndex < 0 ? undefined : argv[framesIndex + 1]
  if (framesDir !== undefined && !isAbsolute(framesDir)) {
    throw new Error('desktop tracer --frames-dir must be absolute')
  }
  return { replayFile, ...(framesDir === undefined ? {} : { framesDir }) }
}

function replayPatch(replayFile: string): string {
  return [
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    '- insert:',
    '    - id: llm-replay',
    "      name: '@deepseek-ai/dsh-llm-replay'",
    '      config:',
    `        file: ${JSON.stringify(replayFile)}`,
    '        providers:',
    '          - id: deepseek-official',
    '            name: DeepSeek',
    '            models:',
    '              - id: deepseek-v4-flash',
    '                name: DeepSeek-V4-Flash',
    '                contextWindow: 128000',
    '',
  ].join('\n')
}

/** Mount the packaged replay adapter through the user-overlay seam in an isolated tracer home. */
export function prepareTracerProfile(home: string, replayProvider: string, replayFile: string): void {
  if (!isAbsolute(home) || !isAbsolute(replayProvider)) {
    throw new Error('desktop tracer profile paths must be absolute')
  }
  const profileDir = join(home, 'profiles', 'desktop')
  const fallback = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm-replay')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), replayPatch(replayFile))
  mkdirSync(dirname(fallback), { recursive: true })
  if (existsSync(fallback)) {
    if (!lstatSync(fallback).isSymbolicLink()) {
      throw new Error(`desktop tracer replay fallback is not a symbolic link: ${fallback}`)
    }
    const existing = readlinkSync(fallback)
    if (existing === replayProvider) return
    unlinkSync(fallback)
  }
  symlinkSync(replayProvider, fallback, 'dir')
}
