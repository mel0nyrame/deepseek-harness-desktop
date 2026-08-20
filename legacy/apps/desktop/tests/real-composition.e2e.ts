/**
 * Keyless development tracer bullet for the Electron desktop product slice:
 * one real DSH child boots the shipped `desktop` profile (base + Web product +
 * desktop overlay with every browser transport row disabled) under an IPC
 * channel, and this test drives it through exactly the surface Electron main
 * uses — the {@link DshSupervisor} protocol. The scenario is the shared
 * interaction-parity driver {@link runSmokeScenario}: one durable Workspace,
 * three Sessions (terminal, question, approval), and reconstruction of every
 * model-visible input from the durable Session logs.
 *
 * The replay fixtures record real turns whose model chunks call the real
 * tools; the tool execution itself is live — real sandboxed subprocesses under
 * the dedicated DSH child, never inside the test process. The question and
 * approval answers are this driver's own gestures through the carrier's
 * `/api/respond` endpoint, the same wire reaction the renderer sends.
 * No HTTP listener participates: the desktop patch disables `web-startup`,
 * `webserver`, `web-runtime`, and `client-hmr`, and the test asserts the child
 * never prints a serving URL.
 *
 * Requires the built Web client bundles (the ready handshake reports each
 * client entry's bundle path), so the e2e lane runs after `pnpm run build`.
 *
 * The test plays Electron main over the supervisor protocol rather than
 * launching a window: the renderer side of the tracer bullet (preload bridge,
 * client boot, ordered stream rendering, the real approval and question
 * panels) is covered by the carrier-contract suite, the supervisor/preload
 * unit tests, and the packaged recording journey.
 */

import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DshSupervisor, type DshChild } from '../src/supervisor.ts'
import { desktopRpc } from '../src/acceptance.ts'
import { replayPatch, runSmokeReopen, runSmokeScenario } from '../src/smoke.ts'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CLI_BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const TERMINAL_FIXTURE = join(REPO_ROOT, 'examples/acp-agent/tests/snapshots/bash-tool-turn/session.jsonl')
const QUESTION_FIXTURE = join(REPO_ROOT, 'apps/web/tests/snapshots/question-composer/session.jsonl')
const APPROVAL_FIXTURE = join(REPO_ROOT, 'apps/web/tests/snapshots/approval-composer/session.jsonl')

/** Desktop profile manifest: the shipped template's three bundle layers. */
const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-desktop-app',
]

/** The shared keyless replay patch: primary fixture plus both child fixtures. */
const REPLAY_PATCH = replayPatch(TERMINAL_FIXTURE, [QUESTION_FIXTURE, APPROVAL_FIXTURE])

interface World {
  readonly home: string
  readonly process: ChildProcess
  readonly child: DshChild
  readonly supervisor: DshSupervisor
  readonly stdout: string[]
}

async function launchChild(home?: string): Promise<World> {
  const resolvedHome = home ?? await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-'))
  const profileDir = join(resolvedHome, 'profiles', 'desktop')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: PROFILE_BUNDLES } },
  }, undefined, 2))
  await writeFile(join(profileDir, 'cordis.patch.yml'), REPLAY_PATCH)
  const stdout: string[] = []
  const childProcess = fork(CLI_BIN, ['--profile', 'desktop'], {
    cwd: REPO_ROOT,
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      DSH_HOME: resolvedHome,
      DSH_AGENTS_HOME: join(resolvedHome, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'keyless-desktop-no-call',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // Same wire choice as Electron main: the desktop protocol is JSON-shaped,
    // and `advanced` serialization breaks across differing embedded V8 versions.
    serialization: 'json',
  })
  childProcess.stdout?.on('data', (chunk: Buffer) => { stdout.push(String(chunk)) })
  childProcess.stderr?.on('data', (chunk: Buffer) => { stdout.push(String(chunk)) })
  const child = childProcess as unknown as DshChild
  return {
    home: resolvedHome,
    process: childProcess,
    child,
    supervisor: new DshSupervisor(child, { startupTimeoutMs: 60_000, bundleRoot: REPO_ROOT }),
    stdout,
  }
}

describe.skipIf(process.platform === 'win32')('desktop real composition', () => {
  let world: World | undefined

  afterEach(async () => {
    if (world === undefined) return
    if (world.process.exitCode === null && world.process.signalCode === null) {
      const exited = new Promise<void>((resolve) => { world!.process.once('exit', () => { resolve() }) })
      world.child.kill('SIGKILL')
      await exited
    }
    await rm(world.home, { recursive: true, force: true })
    world = undefined
  })

  it.skipIf(process.platform !== 'darwin')('registers the macOS sidebar glass settings namespace', async () => {
    world = await launchChild()
    try {
      await world.supervisor.start()
    } catch (error) {
      throw new Error(`${String(error)}; child output:\n${world.stdout.join('').slice(-8000)}`, { cause: error })
    }
    const inventory = await desktopRpc(world.supervisor, 'desktop-inventory', 'pluginInventory/list', { args: {} })
    const inventoryEntries = inventory['entries']
    expect(Array.isArray(inventoryEntries)).toBe(true)
    const inventoryRows = inventoryEntries as Array<{
      entryId?: unknown
      enabled?: unknown
      fiberPhase?: unknown
      moduleName?: unknown
    }>
    const sidebarGlassEntries = inventoryRows.filter(entry => (
      String(entry.entryId).includes('sidebar-glass') || String(entry.moduleName).includes('sidebar-glass')
    ))
    expect(sidebarGlassEntries).toEqual([{
      entryId: 'include:ui-sidebar-glass-macos',
      enabled: true,
      fiberPhase: 'active',
      moduleName: '@deepseek-ai/dsh-client-ui-theme/sidebar-glass',
    }])
    const described = await desktopRpc(world.supervisor, 'desktop-settings', 'settings.describe', {})
    const namespaces = described['namespaces']
    expect(Array.isArray(namespaces)).toBe(true)
    expect(
      (namespaces as Array<{ ns?: unknown }>).map(namespace => namespace.ns),
      `child output:\n${world.stdout.join('').slice(-8000)}`,
    )
      .toContain('ui-sidebar-glass-macos')
    await world.supervisor.stop()
    expect(world.child.exitCode).toBe(0)
  }, 90_000)

  it('creates a Workspace, streams ordered turns for terminal, question, and approval sessions, and reconstructs every input', async () => {
    world = await launchChild()
    const { home, child, supervisor, stdout } = world

    // The shared scenario drives readiness, the no-listener probe, the durable
    // Workspace, the three turns (with question/approval answered over the
    // carrier), and durable reconstruction. Every stage prints one SMOKE_OK
    // marker; a failure throws.
    await runSmokeScenario(supervisor, world.process.pid ?? 0, home)

    // No browser-facing HTTP listener: the desktop patch disables every web
    // transport row, so the child must never announce a serving URL.
    expect(stdout.join('')).not.toContain('observing at')
    expect(stdout.join('')).not.toContain('http://127.0.0.1')

    // Quit: terminate-and-join waits for the owned DSH child to exit (exit
    // code 0 proves the SIGTERM shutdown completed, not a crash). The tracer
    // commands are synchronous, so no descendant outlives the tool calls; a
    // surviving direct child of the exited DSH process would still show up
    // here. PTY-level quiescence assertions belong to the packaged-app smoke,
    // which runs node-pty scenarios on installed artifacts.
    await supervisor.stop()
    expect(child.exitCode).toBe(0)
    expect(world.process.exitCode).toBe(0)
    const descendants = spawnSync('pgrep', ['-P', String(world.process.pid)], { encoding: 'utf8' })
    expect(descendants.error).toBeUndefined()
    expect(descendants.status).toBe(1)

    // Reopen: a second child over the SAME durable home reconstructs the
    // Workspace and all three Sessions from the existing persistence with no
    // model call — the same assertion the packaged `--smoke-reopen` launch
    // carries.
    world = await launchChild(home)
    await runSmokeReopen(world.supervisor, home)
    await world.supervisor.stop()
    expect(world.child.exitCode).toBe(0)
    expect(world.process.exitCode).toBe(0)
    const reopenedDescendants = spawnSync('pgrep', ['-P', String(world.process.pid)], { encoding: 'utf8' })
    expect(reopenedDescendants.error).toBeUndefined()
    expect(reopenedDescendants.status).toBe(1)
  }, 240_000)
})
