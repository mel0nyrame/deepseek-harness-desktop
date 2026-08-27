import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export { TERMINAL_TRACER_PROMPT } from './tracer-contract.js'

/** Deterministic keyless tracer inputs parsed from the Electron command line. */
export type TracerInvocation =
  | {
    /** One ordered keyless terminal turn through the real bundled child. */
    readonly kind: 'terminal'
    readonly replayFile: string
    readonly framesDir?: string
  }
  | {
    /** Native directory selection plus path opening over the full desktop stack. */
    readonly kind: 'native'
    readonly pickedDirectory: string
    readonly openedPath: string
    readonly framesDir?: string
  }

function parseFramesDir(argv: readonly string[]): string | undefined {
  const framesIndex = argv.indexOf('--frames-dir')
  const framesDir = framesIndex < 0 ? undefined : argv[framesIndex + 1]
  if (framesDir === undefined) return undefined
  if (!isAbsolute(framesDir)) throw new Error('desktop tracer --frames-dir must be absolute')
  return framesDir
}

/** Parse and validate the optional integrated-runtime tracer invocation. */
export function parseTracerInvocation(argv: readonly string[]): TracerInvocation | undefined {
  const nativeIndex = argv.indexOf('--tracer-native')
  const marker = argv.indexOf('--tracer')
  if (nativeIndex < 0 && marker < 0) return undefined
  const framesDir = parseFramesDir(argv)
  const withFramesDir = (): { framesDir?: string } => framesDir === undefined ? {} : { framesDir }

  if (nativeIndex >= 0) {
    const pickedDirectory = argv[nativeIndex + 1]
    if (pickedDirectory === undefined || !isAbsolute(pickedDirectory)) {
      throw new Error('desktop native tracer requires an absolute --tracer-native directory')
    }
    if (!existsSync(pickedDirectory)) {
      throw new Error(`desktop native tracer directory does not exist: ${pickedDirectory}`)
    }
    const openIndex = argv.indexOf('--tracer-open-path')
    const openedPath = openIndex < 0 ? pickedDirectory : argv[openIndex + 1]
    if (openedPath === undefined || !isAbsolute(openedPath) || !existsSync(openedPath)) {
      throw new Error('desktop native tracer requires an existing absolute --tracer-open-path')
    }
    return { kind: 'native', pickedDirectory, openedPath, ...withFramesDir() }
  }

  const replayIndex = argv.indexOf('--replay-file')
  const replayFile = replayIndex < 0 ? undefined : argv[replayIndex + 1]
  if (replayFile === undefined || !isAbsolute(replayFile) || !existsSync(replayFile)) {
    throw new Error('desktop tracer requires an existing absolute --replay-file')
  }
  return { kind: 'terminal', replayFile, ...withFramesDir() }
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
