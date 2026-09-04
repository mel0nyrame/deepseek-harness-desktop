import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readPackagedAppEvidence } from '../scripts/artifact-evidence.js'
import { scrubRuntimeEnvironment } from '../scripts/runtime-output.js'
import {
  liveProcessIdentities,
  ProcessEvidenceError,
  processIdentities,
  terminateProcessIdentities,
  type ProcessIdentity,
} from './desktop-process-evidence.js'
import { assertOfficialUiEvidence, type UiEvidence } from './desktop-ui-evidence-contract.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUTPUT = path.join(ROOT, 'apps', 'desktop', 'dist')
const REQUIRED = process.env.DSH_DESKTOP_PACKAGE_REQUIRED === '1'
const SMOKE_TIMEOUT_MS = Number(process.env.DSH_DESKTOP_SMOKE_TIMEOUT_MS ?? 240_000)
const UNREACHABLE_PROXY = 'http://127.0.0.1:1'

function packagedApp(): string | undefined {
  if (!fs.existsSync(OUTPUT)) return undefined
  for (const entry of fs.readdirSync(OUTPUT).toSorted()) {
    const candidate = path.join(OUTPUT, entry, 'DSH Desktop.app')
    if (entry.startsWith('mac') && fs.existsSync(candidate)) return candidate
  }
  return undefined
}

function installedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...scrubRuntimeEnvironment(process.env),
    DSH_HOME: home,
    DSH_DESKTOP_NETWORK_GUARD: networkGuard,
    DSH_DESKTOP_PROCESS_EVIDENCE: '1',
    DSH_DESKTOP_NETWORK_GUARD_LOG: networkGuardLog,
    // execArgv injection only reaches the supervisor-forked runtime child;
    // NODE_OPTIONS covers direct ELECTRON_RUN_AS_NODE spawns (negative control).
    NODE_OPTIONS: `--require=${networkGuard}`,
    HTTP_PROXY: UNREACHABLE_PROXY,
    HTTPS_PROXY: UNREACHABLE_PROXY,
    ALL_PROXY: UNREACHABLE_PROXY,
    http_proxy: UNREACHABLE_PROXY,
    https_proxy: UNREACHABLE_PROXY,
    all_proxy: UNREACHABLE_PROXY,
    NO_PROXY: '',
    no_proxy: '',
    NPM_CONFIG_OFFLINE: 'true',
    PNPM_CONFIG_OFFLINE: 'true',
  }
  delete environment.DSH_DESKTOP_RUNTIME_ROOT
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.NODE_PATH
  return environment
}

function launchInstalled(binary: string, args: readonly string[]): ReturnType<typeof spawnSync> {
  fs.writeFileSync(networkGuardLog, '')
  return spawnSync(binary, args, {
    cwd: temporary,
    env: installedEnvironment(),
    encoding: 'utf8',
    timeout: SMOKE_TIMEOUT_MS,
  })
}

function runtimeRootEvidence(output: string): string {
  const prefix = 'DESKTOP_RUNTIME_ROOT '
  const lines = output.split('\n').filter(line => line.startsWith(prefix))
  if (lines.length !== 1) throw new Error(`expected one desktop runtime root, found ${String(lines.length)}`)
  const value: unknown = JSON.parse((lines[0] as string).slice(prefix.length))
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`invalid desktop runtime root: ${String(value)}`)
  }
  return value
}

function runtimeTreeDigest(root: string): string {
  const hash = createHash('sha256')
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).toSorted((left, right) => (
      left.name.localeCompare(right.name)
    ))) {
      const candidate = path.join(directory, entry.name)
      hash.update(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}\0`)
      hash.update(`${path.relative(root, candidate)}\0`)
      if (entry.isDirectory()) visit(candidate)
      else if (entry.isSymbolicLink()) hash.update(`${fs.readlinkSync(candidate)}\0`)
      else hash.update(fs.readFileSync(candidate))
    }
  }
  visit(root)
  return hash.digest('hex')
}

function assertNetworkGuard(): void {
  const lines = fs.readFileSync(networkGuardLog, 'utf8').trim().split('\n')
  expect(lines.some(line => line.startsWith('loaded '))).toBe(true)
  expect(lines.filter(line => line.startsWith('attempted '))).toEqual([])
}

function assertInstalledUiEvidence(): void {
  const evidence = JSON.parse(
    fs.readFileSync(path.join(frames, 'evidence.json'), 'utf8'),
  ) as UiEvidence
  assertOfficialUiEvidence(evidence, frames, picked)
  for (const id of [
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-directory-picker-native',
    '@deepseek-ai/dsh-client-ui-input-trigger',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-workspace',
    '@dsh-desktop/ui',
  ]) expect(evidence.graph).toContain(id)
  expect(fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8'))
    .toContain('ui-sidebar-glass-macos:\n  enabled: false')
}

const sourceApp = packagedApp()
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installed-smoke-'))
const installedApp = path.join(temporary, 'DSH Desktop.app')
const home = path.join(temporary, 'home')
const picked = path.join(temporary, 'workspace', 'deepseek-harness')
const frames = path.join(temporary, 'frames')
const replays = [1, 2, 3].map(index => path.join(temporary, `session-${String(index)}.jsonl`))
const terminalReplay = path.join(temporary, 'terminal-session.jsonl')
const startupUserData = path.join(temporary, 'electron-startup')
const tracerUserData = path.join(temporary, 'electron-tracer')
const installedRuntime = path.join(installedApp, 'Contents', 'Resources', 'runtime')
const networkGuard = path.join(temporary, 'network-guard.cjs')
const networkGuardLog = path.join(temporary, 'network-guard.log')
let installedRuntimeDigest = ''

beforeAll(() => {
  if (sourceApp === undefined || process.platform !== 'darwin') return
  execFileSync('/usr/bin/ditto', [sourceApp, installedApp])
  fs.mkdirSync(home)
  fs.mkdirSync(picked, { recursive: true })
  fs.mkdirSync(frames)
  for (const [offset, replay] of replays.entries()) {
    fs.copyFileSync(
      path.join(ROOT, 'tests', 'fixtures', 'visual-acceptance', `session-${String(offset + 1)}.jsonl`),
      replay,
    )
  }
  fs.copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'terminal-turn', 'session.jsonl'), terminalReplay)
  fs.writeFileSync(networkGuard, [
    "const fs = require('node:fs')",
    "const log = process.env.DSH_DESKTOP_NETWORK_GUARD_LOG",
    "if (!log) throw new Error('missing desktop network guard log')",
    "fs.appendFileSync(log, `loaded ${process.pid}\\n`)",
    "const blocked = api => function () {",
    "  fs.appendFileSync(log, `attempted ${api} ${process.pid}\\n`)",
    "  throw new Error(`desktop test blocked network API: ${api}`)",
    "}",
    "const net = require('node:net')",
    "net.Socket.prototype.connect = blocked('net.Socket.connect')",
    "net.connect = blocked('net.connect')",
    "net.createConnection = blocked('net.createConnection')",
    "const tls = require('node:tls')",
    "tls.connect = blocked('tls.connect')",
    "const http = require('node:http')",
    "http.request = blocked('http.request')",
    "http.get = blocked('http.get')",
    "const https = require('node:https')",
    "https.request = blocked('https.request')",
    "https.get = blocked('https.get')",
    "const dgram = require('node:dgram')",
    "dgram.Socket.prototype.send = blocked('dgram.Socket.send')",
    "globalThis.fetch = blocked('fetch')",
    '',
  ].join('\n'))
  installedRuntimeDigest = runtimeTreeDigest(installedRuntime)
}, 120_000)

afterAll(() => {
  fs.rmSync(temporary, { recursive: true, force: true })
})

describe('installed desktop application', () => {
  it('requires a packaged application in the packaging gate', () => {
    expect(REQUIRED && (process.platform !== 'darwin' || sourceApp === undefined)).toBe(false)
  })

  it.skipIf(process.platform !== 'darwin' || sourceApp === undefined)(
    'proves the installed network guard blocks direct Node connections',
    () => {
      const binary = path.join(installedApp, 'Contents', 'MacOS', 'DSH Desktop')
      const environment = installedEnvironment()
      environment.ELECTRON_RUN_AS_NODE = '1'
      fs.writeFileSync(networkGuardLog, '')
      const result = spawnSync(binary, [
        '-e',
        "require('node:net').connect({ host: '127.0.0.1', port: 1 })",
      ], {
        cwd: temporary,
        env: environment,
        encoding: 'utf8',
        timeout: SMOKE_TIMEOUT_MS,
      })
      const lines = fs.readFileSync(networkGuardLog, 'utf8').trim().split('\n')

      expect(result.status).not.toBe(0)
      expect(lines.some(line => line.startsWith('loaded '))).toBe(true)
      expect(lines.some(line => line.startsWith('attempted net.'))).toBe(true)
    },
    30_000,
  )

  it.skipIf(process.platform !== 'darwin' || sourceApp === undefined)(
    'joins the embedded child when the installed shell quits during startup',
    () => {
      const binary = path.join(installedApp, 'Contents', 'MacOS', 'DSH Desktop')
      const result = launchInstalled(binary, [
        `--user-data-dir=${startupUserData}`,
        '--quit-during-startup',
      ])
      const output = `${result.stdout}\n${result.stderr}`
      let identities: readonly ProcessIdentity[] = []
      try {
        try {
          identities = processIdentities(result)
        } catch (error) {
          if (error instanceof ProcessEvidenceError) identities = error.identities
          throw error
        }
        expect(result.error, output.slice(0, 8_000)).toBeUndefined()
        expect(result.status, output.slice(0, 8_000)).toBe(0)
        expect(fs.realpathSync(runtimeRootEvidence(output))).toBe(fs.realpathSync(
          installedRuntime,
        ))
        expect(runtimeTreeDigest(installedRuntime)).toBe(installedRuntimeDigest)
        // The child is SIGTERM'd before Node bootstrap can execute the guard,
        // so guard evidence is asserted only in journeys that run the runtime.
        expect(identities.length).toBeGreaterThanOrEqual(1)
        expect(liveProcessIdentities(identities)).toEqual([])
      } finally {
        terminateProcessIdentities(identities)
      }
    },
    300_000,
  )

  it.skipIf(process.platform !== 'darwin' || sourceApp === undefined)(
    'runs deterministic published-Client sessions and the native provider outside the source tree',
    () => {
      const binary = path.join(installedApp, 'Contents', 'MacOS', 'DSH Desktop')
      const result = launchInstalled(binary, [
        `--user-data-dir=${tracerUserData}`,
        '--lang=en-US',
        '--tracer-ui', picked,
        '--replay-file', replays[0] as string,
        '--replay-child-file', replays[1] as string,
        '--replay-child-file', replays[2] as string,
        '--replay-child-file', terminalReplay,
        '--frames-dir', frames,
      ])
      const output = `${result.stdout}\n${result.stderr}`
      let identities: readonly ProcessIdentity[] = []
      try {
        try {
          identities = processIdentities(result)
        } catch (error) {
          if (error instanceof ProcessEvidenceError) identities = error.identities
          throw error
        }
        expect(path.relative(ROOT, installedApp).startsWith('..')).toBe(true)
        expect(result.error, output.slice(0, 8_000)).toBeUndefined()
        expect(result.status, output.slice(0, 8_000)).toBe(0)
        expect(fs.realpathSync(runtimeRootEvidence(output))).toBe(fs.realpathSync(
          installedRuntime,
        ))
        expect(output).toContain('TRACER_OK no-loopback-listener')
        expect(output).toContain('TRACER_OK official-client-ui')
        expect(output).toContain('DESKTOP_UI_EVIDENCE ')
        assertInstalledUiEvidence()
        expect(readPackagedAppEvidence(installedApp)).toMatchObject({
          appId: 'ai.deepseek.dsh-desktop',
          profile: 'desktop',
          runtimeDownloads: false,
        })
        expect(runtimeTreeDigest(installedRuntime)).toBe(installedRuntimeDigest)
        assertNetworkGuard()
        expect(identities.length).toBeGreaterThanOrEqual(1)
        expect(liveProcessIdentities(identities)).toEqual([])
      } finally {
        terminateProcessIdentities(identities)
      }
    },
    300_000,
  )
})
