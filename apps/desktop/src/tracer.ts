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
    /** Official Client journey over replay plus the native directory provider. */
    readonly kind: 'ui'
    readonly replayFile: string
    readonly replayChildFiles: readonly string[]
    readonly pickedDirectory: string
    readonly framesDir: string
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

function parseRepeatedAbsoluteFiles(argv: readonly string[], option: string): string[] {
  const files: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== option) continue
    const file = argv[index + 1]
    if (file === undefined || !isAbsolute(file) || !existsSync(file)) {
      throw new Error(`desktop UI tracer requires every ${option} value to be an existing absolute file`)
    }
    files.push(file)
  }
  return files
}

/** Parse and validate the optional integrated-runtime tracer invocation. */
export function parseTracerInvocation(argv: readonly string[]): TracerInvocation | undefined {
  const uiIndex = argv.indexOf('--tracer-ui')
  const nativeIndex = argv.indexOf('--tracer-native')
  const marker = argv.indexOf('--tracer')
  if (uiIndex < 0 && nativeIndex < 0 && marker < 0) return undefined
  const framesDir = parseFramesDir(argv)
  const withFramesDir = (): { framesDir?: string } => framesDir === undefined ? {} : { framesDir }

  if (uiIndex >= 0) {
    const pickedDirectory = argv[uiIndex + 1]
    if (pickedDirectory === undefined || !isAbsolute(pickedDirectory) || !existsSync(pickedDirectory)) {
      throw new Error('desktop UI tracer requires an existing absolute --tracer-ui directory')
    }
    const replayIndex = argv.indexOf('--replay-file')
    const replayFile = replayIndex < 0 ? undefined : argv[replayIndex + 1]
    if (replayFile === undefined || !isAbsolute(replayFile) || !existsSync(replayFile)) {
      throw new Error('desktop UI tracer requires an existing absolute --replay-file')
    }
    if (framesDir === undefined) throw new Error('desktop UI tracer requires an absolute --frames-dir')
    const replayChildFiles = parseRepeatedAbsoluteFiles(argv, '--replay-child-file')
    if (replayChildFiles.length !== 3) {
      throw new Error('desktop UI tracer requires exactly three --replay-child-file values')
    }
    return {
      kind: 'ui', replayFile,
      replayChildFiles,
      pickedDirectory, framesDir,
    }
  }

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

function replayPatch(replayFile: string, paceMs?: number, childFiles: readonly string[] = []): string {
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
    ...(childFiles.length === 0 ? [] : [
      '        childFiles:',
      ...childFiles.map(file => `          - ${JSON.stringify(file)}`),
    ]),
    ...(paceMs === undefined ? [] : [`        paceMs: ${String(paceMs)}`]),
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

/**
 * Mount replay through the user-overlay seam in an isolated tracer home.
 * Writes the replay patch and optional first-run UI preferences inside `home`.
 * `acknowledgeWelcome` gates creation of a missing settings file; locale and
 * appearance are written only with that new file. Replay pacing and child files
 * are delegated to the keyless replay provider.
 */
export function prepareTracerProfile(
  home: string,
  replayProvider: string,
  replayFile: string,
  options: {
    readonly acknowledgeWelcome?: boolean
    readonly replayPaceMs?: number
    readonly replayChildFiles?: readonly string[]
    readonly locale?: 'en' | 'zh'
    readonly appearance?: 'light' | 'dark' | 'system'
  } = {},
): void {
  if (!isAbsolute(home) || !isAbsolute(replayProvider)) {
    throw new Error('desktop tracer profile paths must be absolute')
  }
  const profileDir = join(home, 'profiles', 'desktop')
  const fallback = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm-replay')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    replayPatch(replayFile, options.replayPaceMs, options.replayChildFiles),
  )
  const settingsPath = join(home, 'settings.yaml')
  if (options.acknowledgeWelcome === true && !existsSync(settingsPath)) {
    writeFileSync(settingsPath, [
      ...(options.locale === undefined ? [] : ['locale:', `  preference: ${options.locale}`]),
      ...(options.appearance === undefined ? [] : ['ui-theme:', `  preference: ${options.appearance}`]),
      'ui-onboarding:',
      '  welcomeNoticeVersion: 2026-08-13.1',
      '',
    ].join('\n'))
  }
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
