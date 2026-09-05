import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { finished } from 'node:stream/promises'

export type AgentCheckPreset = 'quick' | 'focused' | 'workspace' | 'package' | 'all'

export interface AgentCheckOptions {
  readonly preset: AgentCheckPreset
  readonly planOnly: boolean
  readonly verbose: boolean
  readonly tests: readonly string[]
  readonly name?: string
  readonly help: boolean
}

export interface AgentCheckStep {
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  readonly isolatePackageOutput?: boolean
}

const ROOT = path.resolve(import.meta.dirname, '..')
const DESKTOP_DIRECTORY = path.join(ROOT, 'apps', 'desktop')
const PACKAGE_OUTPUT = path.join(DESKTOP_DIRECTORY, 'dist')
const PRESETS = new Set<AgentCheckPreset>(['quick', 'focused', 'workspace', 'package', 'all'])

function usage(): string {
  return [
    'Usage: pnpm run test:agent -- [preset] [options]',
    '',
    'Presets:',
    '  all        workspace checks, package build, and installed-product gate (default)',
    '  workspace  CI workspace check with existing package output isolated',
    '  package    package build and installed-product gate',
    '  focused    build and run paths supplied by --test',
    '  quick      typecheck, lint, and diff whitespace check',
    '',
    'Options:',
    '  --test <path>   focused test path; repeat for more paths',
    '  --name <text>   Vitest test-name filter for the focused preset',
    '  --plan          print the resolved steps without running them',
    '  --verbose       stream full command output in addition to log files',
    '  --help          print this help',
    '',
    'Examples:',
    '  pnpm run test:agent',
    '  pnpm run test:agent -- workspace',
    '  pnpm run test:agent -- focused --test tests/desktop-native-window.test.ts --name "wide resize"',
  ].join('\n')
}

/** Parse and validate one agent-check invocation. */
export function parseAgentCheckArguments(argv: readonly string[]): AgentCheckOptions {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv
  const { values, positionals } = parseArgs({
    args: [...normalized],
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean' },
      plan: { type: 'boolean' },
      verbose: { type: 'boolean' },
      test: { type: 'string', multiple: true },
      name: { type: 'string' },
    },
  })
  if (positionals.length > 1) throw new Error(`expected at most one preset, received: ${positionals.join(' ')}`)
  const presetValue = positionals[0] ?? 'all'
  if (!PRESETS.has(presetValue as AgentCheckPreset)) throw new Error(`unknown preset: ${presetValue}`)
  const preset = presetValue as AgentCheckPreset
  const tests = values.test ?? []
  if (preset === 'focused' && tests.length === 0 && values.help !== true) {
    throw new Error('the focused preset requires at least one --test')
  }
  if (preset !== 'focused' && (tests.length > 0 || values.name !== undefined)) {
    throw new Error('--test and --name require the focused preset')
  }
  return {
    preset,
    planOnly: values.plan ?? false,
    verbose: values.verbose ?? false,
    tests,
    ...(values.name === undefined ? {} : { name: values.name }),
    help: values.help ?? false,
  }
}

/** Resolve the ordered commands for one validated invocation. */
export function agentCheckPlan(options: AgentCheckOptions): AgentCheckStep[] {
  const diff: AgentCheckStep = { label: 'diff', command: 'git', args: ['diff', '--check'] }
  if (options.preset === 'quick') {
    return [
      { label: 'typecheck', command: 'pnpm', args: ['run', 'typecheck'] },
      { label: 'lint', command: 'pnpm', args: ['run', 'lint'] },
      diff,
    ]
  }
  if (options.preset === 'focused') {
    return [
      { label: 'build', command: 'pnpm', args: ['run', 'build'] },
      {
        label: 'focused tests',
        command: 'pnpm',
        args: [
          'exec', 'vitest', 'run', ...options.tests,
          ...(options.name === undefined ? [] : ['-t', options.name]),
        ],
      },
      diff,
    ]
  }
  const workspace: AgentCheckStep = {
    label: 'workspace',
    command: 'pnpm',
    args: ['run', 'check'],
    isolatePackageOutput: true,
  }
  const packageBuild: AgentCheckStep = { label: 'package', command: 'pnpm', args: ['run', 'package'] }
  const installed: AgentCheckStep = {
    label: 'installed product', command: 'pnpm', args: ['run', 'test:package'],
  }
  if (options.preset === 'workspace') return [workspace, diff]
  if (options.preset === 'package') return [packageBuild, installed, diff]
  return [workspace, packageBuild, installed, diff]
}

function commandLine(step: AgentCheckStep): string {
  return [step.command, ...step.args]
    .map(value => /\s/.test(value) ? JSON.stringify(value) : value)
    .join(' ')
}

function duration(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1_000).toFixed(1)}s`
}

function logTail(logFile: string): string {
  const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split(/\r?\n/)
  return lines.slice(-80).join('\n')
}

async function runStep(
  step: AgentCheckStep,
  index: number,
  total: number,
  logDirectory: string,
  verbose: boolean,
): Promise<void> {
  const startedAt = Date.now()
  const logFile = path.join(logDirectory, `${String(index).padStart(2, '0')}-${step.label.replaceAll(' ', '-')}.log`)
  console.log(`AGENT_CHECK STEP ${String(index)}/${String(total)} ${step.label}: ${commandLine(step)}`)
  const output = fs.createWriteStream(logFile, { flags: 'wx' })
  const child = spawn(step.command, [...step.args], {
    cwd: ROOT,
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(output, { end: false })
  child.stderr.pipe(output, { end: false })
  if (verbose) {
    child.stdout.pipe(process.stdout, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
  }
  const heartbeat = setInterval(() => {
    console.log(`AGENT_CHECK WAIT ${step.label} elapsed=${duration(startedAt)}`)
  }, 15_000)
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once('error', error => resolve({ code: null, signal: null, error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearInterval(heartbeat)
  output.end()
  await finished(output)
  if (result.error === undefined && result.code === 0) {
    console.log(`AGENT_CHECK PASS ${step.label} elapsed=${duration(startedAt)} log=${path.relative(ROOT, logFile)}`)
    return
  }
  console.error(`AGENT_CHECK FAIL ${step.label} elapsed=${duration(startedAt)} log=${path.relative(ROOT, logFile)}`)
  console.error('AGENT_CHECK LOG_TAIL_BEGIN')
  console.error(logTail(logFile))
  console.error('AGENT_CHECK LOG_TAIL_END')
  if (result.error !== undefined) throw new Error(`${step.label} failed to spawn: ${result.error.message}`)
  throw new Error(`${step.label} failed (${result.code === null ? `signal ${result.signal ?? 'unknown'}` : `exit code ${String(result.code)}`})`)
}

async function withPackageOutputIsolated(run: () => Promise<void>): Promise<void> {
  if (!fs.existsSync(PACKAGE_OUTPUT)) {
    await run()
    return
  }
  const heldOutput = path.join(DESKTOP_DIRECTORY, `dist.agent-check-hold-${String(process.pid)}`)
  if (fs.existsSync(heldOutput)) throw new Error(`package-output hold already exists: ${heldOutput}`)
  fs.renameSync(PACKAGE_OUTPUT, heldOutput)
  console.log(`AGENT_CHECK ISOLATE ${path.relative(ROOT, PACKAGE_OUTPUT)}`)
  let runFailed = false
  let runError: unknown
  try {
    await run()
  } catch (error) {
    runFailed = true
    runError = error
  }
  if (fs.existsSync(PACKAGE_OUTPUT)) {
    throw new Error(`cannot restore package output because ${PACKAGE_OUTPUT} was recreated`)
  }
  fs.renameSync(heldOutput, PACKAGE_OUTPUT)
  console.log(`AGENT_CHECK RESTORE ${path.relative(ROOT, PACKAGE_OUTPUT)}`)
  if (runFailed) throw runError
}

async function main(): Promise<void> {
  let options: AgentCheckOptions
  try {
    options = parseAgentCheckArguments(process.argv.slice(2))
  } catch (error) {
    console.error(`agent-check: ${error instanceof Error ? error.message : String(error)}\n`)
    console.error(usage())
    process.exitCode = 1
    return
  }
  if (options.help) {
    console.log(usage())
    return
  }
  const steps = agentCheckPlan(options)
  if (options.planOnly) {
    console.log(`AGENT_CHECK PLAN preset=${options.preset}`)
    for (const [index, step] of steps.entries()) {
      console.log(`${String(index + 1)}. ${step.label}: ${commandLine(step)}${step.isolatePackageOutput === true ? ' [package output isolated]' : ''}`)
    }
    return
  }
  const startedAt = Date.now()
  const logDirectory = path.join(
    ROOT,
    '.artifacts',
    'agent-check',
    `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${String(process.pid)}`,
  )
  fs.mkdirSync(logDirectory, { recursive: true })
  console.log(`AGENT_CHECK START preset=${options.preset} log=${path.relative(ROOT, logDirectory)}`)
  try {
    for (const [index, step] of steps.entries()) {
      const execute = async (): Promise<void> => {
        await runStep(step, index + 1, steps.length, logDirectory, options.verbose)
      }
      if (step.isolatePackageOutput === true) await withPackageOutputIsolated(execute)
      else await execute()
    }
    console.log(`AGENT_CHECK RESULT PASS preset=${options.preset} elapsed=${duration(startedAt)} log=${path.relative(ROOT, logDirectory)}`)
  } catch (error) {
    console.error(`AGENT_CHECK RESULT FAIL preset=${options.preset} elapsed=${duration(startedAt)} reason=${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href) await main()
