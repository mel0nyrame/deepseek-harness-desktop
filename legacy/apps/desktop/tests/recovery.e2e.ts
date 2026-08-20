/**
 * Keyless development recovery journey for the bundled Host: a seeded
 * configuration failure lands the lifecycle in the failed state with an
 * actionable detail, one controlled restart after repairing the profile
 * reaches the running phase, the Session surface is usable again over the
 * fresh generation, and the single quit owner leaves the process tree
 * quiescent. No Electron primitives participate — this is the fast
 * development seam for the same journey the packaged `--record-recovery`
 * acceptance records with a real window.
 */

import { existsSync } from 'node:fs'
import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopLifecycle } from '../src/lifecycle.ts'
import { DshSupervisor, type DshChild } from '../src/supervisor.ts'
import { createProcessTreeLadder } from '../src/process-tree.ts'
import { prepareBrokenProfile, prepareSmokeProfile } from '../src/smoke.ts'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CLI_BIN = join(REPO_ROOT, 'apps/cli/lib/bin.js')
const REPLAY_FIXTURE = join(REPO_ROOT, 'examples/acp-agent/tests/snapshots/bash-tool-turn/session.jsonl')
const REPLAY_PROVIDER = join(REPO_ROOT, 'packages/test-support/llm-replay')
const RECORDED_PROMPT = 'Use the bash tool to run exactly: echo TERMINAL_OK. Then reply with the single word DONE and stop.'

/** Seed a profile through the smoke helpers, which require `$DSH_HOME`. */
function withHarnessHome<T>(home: string, seed: () => T): T {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return seed()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

function seedBrokenProfile(home: string): void {
  withHarnessHome(home, () => { prepareBrokenProfile() })
}

function seedRepairedProfile(home: string): void {
  withHarnessHome(home, () => { prepareSmokeProfile(REPLAY_FIXTURE, REPLAY_PROVIDER) })
}

interface StreamRecord {
  readonly method: string
  readonly payload: Record<string, unknown>
}

function envelope(rpcId: string, method: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload })
}

async function unary(
  supervisor: DshSupervisor,
  rpcId: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await supervisor.request({
    type: 'request',
    id: rpcId,
    url: `dsh://app/api/${method}`,
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: envelope(rpcId, method, payload),
  })
  expect(response.status).toBe(200)
  const parsed = JSON.parse(response.body) as {
    type: string
    result: { ok: true; value: unknown } | { ok: false; error: unknown }
  }
  expect(parsed.type).toBe('server-response')
  expect(parsed.result.ok).toBe(true)
  if (!parsed.result.ok) throw new Error(`desktop recovery unary ${method} failed: ${JSON.stringify(parsed.result.error)}`)
  return parsed.result.value as Record<string, unknown>
}

describe.skipIf(process.platform === 'win32' || !existsSync(CLI_BIN))('desktop Host recovery (built development entry)', () => {
  let home: string | undefined
  let lifecycle: DesktopLifecycle | undefined
  let childProcesses: ChildProcess[] = []

  afterEach(async () => {
    if (lifecycle !== undefined) {
      await lifecycle.stop().catch((stopError: unknown) => {
        // afterEach cleanup is best-effort: a failed test already owns the
        // verdict, and the remaining child cleanup below still runs.
        console.error('desktop recovery cleanup stop failed:', stopError)
      })
      lifecycle = undefined
    }
    for (const process of childProcesses) {
      if (process.exitCode === null && process.signalCode === null) {
        const exited = new Promise<void>((resolve) => { process.once('exit', () => { resolve() }) })
        process.kill('SIGKILL')
        await exited
      }
    }
    childProcesses = []
    if (home !== undefined) await rm(home, { recursive: true, force: true })
    home = undefined
  })

  function spawnChild(): ChildProcess {
    const homeDir = home
    if (homeDir === undefined) throw new Error('desktop recovery: no harness home set')
    const childProcess = fork(CLI_BIN, ['--profile', 'desktop'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DSH_HOME: homeDir,
        DSH_AGENTS_HOME: join(homeDir, '.agents'),
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'keyless-desktop-no-call',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      detached: true,
    })
    childProcess.stdout?.on('data', () => {})
    childProcess.stderr?.on('data', () => {})
    childProcesses.push(childProcess)
    return childProcess
  }

  it('recovers from a seeded configuration failure and returns to a usable Session', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-desktop-recovery-'))
    seedBrokenProfile(home)
    const stderrTails: string[] = []
    lifecycle = new DesktopLifecycle({
      spawn: () => {
        const childProcess = spawnChild()
        const tail: string[] = []
        stderrTails.push('')
        childProcess.stderr?.on('data', (chunk: Buffer) => {
          tail.push(String(chunk))
          if (tail.length > 40) tail.shift()
        })
        const tree = createProcessTreeLadder()
        const supervisor = new DshSupervisor(childProcess as unknown as DshChild, {
          startupTimeoutMs: 60_000,
          shutdownTimeoutMs: 10_000,
          bundleRoot: REPO_ROOT,
          ...(tree === undefined ? {} : { tree }),
        })
        return { supervisor, childPid: childProcess.pid, tail: () => tail.join('') }
      },
    })

    // Startup failure: the broken profile must land the defined failed state
    // with an actionable detail — not a hang, a crash of Electron main, or a
    // silently blank window.
    await lifecycle.start()
    expect(lifecycle.phase).toBe('failed')
    expect(lifecycle.failure?.kind).toBe('startup-failed')
    expect(lifecycle.failure?.detail?.trim() ?? '').not.toBe('')
    // The failed generation is gone, leaving nothing behind.
    const failedChild = childProcesses[0]!
    expect(failedChild.exitCode).toBe(1)

    // One controlled restart after repairing the configuration.
    seedRepairedProfile(home)
    await lifecycle.restart()
    expect(lifecycle.phase).toBe('running')
    const supervisor = lifecycle.current()!.supervisor
    const childPid = lifecycle.current()!.childPid!

    // The Session surface is usable again over the fresh generation: create a
    // Session, run the recorded terminal turn, and observe the ordered
    // streamed result.
    const created = await unary(supervisor, 'recovery-create', 'session.create', {})
    const sessionId = created['sessionId']
    expect(typeof sessionId).toBe('string')

    const records: StreamRecord[] = []
    let streamFailure: string | undefined
    supervisor.onStream((message) => {
      if (message.id !== 'recovery-mux') return
      if (message.type === 'stream-message') {
        const frame = message.message as { method: string; payload: Record<string, unknown> }
        records.push({ method: frame.method, payload: frame.payload })
      } else if (message.type === 'stream-error') {
        streamFailure = message.message
      }
    })
    supervisor.subscribe('recovery-mux', 'mux')

    const prompted = await unary(supervisor, 'recovery-prompt', 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: RECORDED_PROMPT }],
    })
    expect(prompted['accepted']).toBe(true)

    const deadline = Date.now() + 60_000
    for (;;) {
      const events = records
        .filter(record => record.method === 'session/event')
        .map(record => record.payload['event'] as { type: string })
      const hasToolResult = events.some(event => event.type === 'tool/result')
      const hasTurnEnd = events.some(event => event.type === 'turn/end')
      if (streamFailure !== undefined) throw new Error(`desktop recovery mux stream failed: ${streamFailure}`)
      if (hasToolResult && hasTurnEnd) break
      if (Date.now() > deadline) {
        throw new Error(`desktop recovery scenario did not settle; records: ${JSON.stringify(records).slice(0, 4000)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    // Quit through the single lifecycle owner: the tree becomes quiescent and
    // the recovered child exits 0 through graceful SIGTERM.
    const report = await lifecycle.stop()
    expect(report.quiescent).toBe(true)
    expect(report.escalated).toBe(false)
    expect(childProcesses[1]!.exitCode).toBe(0)
    const descendants = spawnSync('pgrep', ['-P', String(childPid)], { encoding: 'utf8' })
    expect(descendants.error).toBeUndefined()
    expect(descendants.status).toBe(1)
  }, 180_000)
})
