/**
 * Keyless development tracer bullet for the Electron desktop product slice:
 * one real DSH child boots the shipped `desktop` profile (base + Web product +
 * desktop overlay with every browser transport row disabled) under an IPC
 * channel, and this test drives it through exactly the surface Electron main
 * uses — the {@link DshSupervisor} protocol. The scenario creates one Session,
 * sends the recorded bash-tool prompt through the real gateway, and observes
 * the ordered mux stream until the terminal-backed `echo TERMINAL_OK` tool
 * result and the turn settlement arrive. Quitting then terminates the child
 * and asserts the owned process tree is quiescent.
 *
 * The replay fixture (`examples/acp-agent/tests/snapshots/bash-tool-turn`)
 * records a turn whose model chunks call the real `bash` tool with
 * `echo TERMINAL_OK`; the tool execution itself is live — a real sandboxed
 * subprocess under the dedicated DSH child, never inside Electron main (which
 * this test plays). No HTTP listener participates: the desktop patch disables
 * `web-startup`, `webserver`, `web-runtime`, and `client-hmr`, and the test
 * asserts the child never prints a serving URL.
 *
 * Requires the built Web client bundles (the ready handshake reports each
 * client entry's bundle path), so the e2e lane runs after `pnpm run build`.
 *
 * The test plays Electron main over the supervisor protocol rather than
 * launching a window: the renderer side of the tracer bullet (preload bridge,
 * client boot, ordered stream rendering) is covered by the carrier-contract
 * suite and the supervisor/preload unit tests, and GUI acceptance against the
 * real window belongs to issue #4.
 */

import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DshSupervisor, type DshChild } from '../src/supervisor.ts'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CLI_BIN = join(REPO_ROOT, 'apps/cli/src/bin.ts')
const REPLAY_FIXTURE = join(REPO_ROOT, 'examples/acp-agent/tests/snapshots/bash-tool-turn/session.jsonl')
const RECORDED_PROMPT = 'Use the bash tool to run exactly: echo TERMINAL_OK. Then reply with the single word DONE and stop.'

/** Desktop profile manifest: the shipped template's three bundle layers. */
const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-desktop-app',
]

/** Keyless replay rows layered over the desktop profile: no adapter calls the network. */
const REPLAY_PATCH = [
  '- id: llm-deepseek',
  '  disabled: true',
  '- insert:',
  '    - id: llm-replay',
  "      name: '@deepseek-ai/dsh-llm-replay'",
  '      config:',
  `        file: ${JSON.stringify(REPLAY_FIXTURE)}`,
  '        providers:',
  '          - id: deepseek-official',
  '            name: DeepSeek',
  '            models:',
  '              - id: deepseek-v4-flash',
  '                name: DeepSeek-V4-Flash',
  '                contextWindow: 128000',
  '',
].join('\n')

interface StreamRecord {
  readonly method: string
  readonly payload: Record<string, unknown>
}

interface World {
  readonly home: string
  readonly process: ChildProcess
  readonly child: DshChild
  readonly supervisor: DshSupervisor
  readonly stdout: string[]
}

function envelope(rpcId: string, method: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload })
}

async function launchChild(): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-'))
  const profileDir = join(home, 'profiles', 'desktop')
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
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, '.agents'),
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
    home,
    process: childProcess,
    child,
    supervisor: new DshSupervisor(child, { startupTimeoutMs: 60_000, bundleRoot: REPO_ROOT }),
    stdout,
  }
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
  if (!parsed.result.ok) throw new Error(`desktop unary ${method} failed: ${JSON.stringify(parsed.result.error)}`)
  return parsed.result.value as Record<string, unknown>
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

  it('creates a Session, streams an ordered terminal-backed tool result, and quits quiescent', async () => {
    world = await launchChild()
    const { child, supervisor, stdout } = world

    // Readiness: the real composition settles and announces the client graph
    // with one bundle path per entry, so Electron main can serve the built UI.
    const ready = await supervisor.start()
    expect(ready.graph.entries.length).toBeGreaterThan(0)
    expect(ready.bundles.map(bundle => bundle.id)).toEqual(ready.graph.entries.map(entry => entry.id))

    // No browser-facing HTTP listener: probe the live child's TCP sockets
    // directly (the stdout URL line is a web-runtime behavior, a useful
    // secondary signal).
    expect(stdout.join('')).not.toContain('observing at')
    expect(stdout.join('')).not.toContain('http://127.0.0.1')
    const listeners = spawnSync('lsof', ['-a', '-p', String(world.process.pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
    expect(listeners.error).toBeUndefined()
    expect(listeners.stdout.trim()).toBe('')

    const created = await unary(supervisor, 'e2e-create', 'session.create', {})
    const sessionId = created['sessionId']
    expect(typeof sessionId).toBe('string')

    // Open the mux stream before prompting: Electron main forwards the child's
    // logical stream to the renderer through the preload bridge.
    const records: StreamRecord[] = []
    let streamFailure: string | undefined
    supervisor.onStream((message) => {
      if (message.id !== 'e2e-mux') return
      if (message.type === 'stream-message') {
        const frame = message.message as { method: string; payload: Record<string, unknown> }
        records.push({ method: frame.method, payload: frame.payload })
      } else if (message.type === 'stream-error') {
        streamFailure = message.message
      }
    })
    supervisor.subscribe('e2e-mux', 'mux')

    const prompted = await unary(supervisor, 'e2e-prompt', 'session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: RECORDED_PROMPT }],
    })
    expect(prompted['accepted']).toBe(true)

    // Wait for the recorded turn to settle: tool/call (bash) -> tool/result
    // carrying TERMINAL_OK -> turn/end, all delivered as ordered mux frames.
    const deadline = Date.now() + 60_000
    for (;;) {
      const events = records
        .filter(record => record.method === 'session/event')
        .map(record => record.payload['event'] as { type: string })
      const hasToolResult = events.some(event => event.type === 'tool/result')
      const hasTurnEnd = events.some(event => event.type === 'turn/end')
      if (streamFailure !== undefined) throw new Error(`desktop mux stream failed: ${streamFailure}`)
      if (hasToolResult && hasTurnEnd) break
      if (Date.now() > deadline) {
        throw new Error(`desktop scenario did not settle; records: ${JSON.stringify(records).slice(0, 4000)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const events = records
      .filter(record => record.method === 'session/event')
      .map(record => record.payload['event'] as { type: string; seq: number; data?: unknown })
    const types = events.map(event => event.type)
    expect(types).toContain('turn/start')
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')
    expect(types).toContain('turn/end')
    // Ordered streamed result: monotonically increasing event sequence.
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.seq).toBeGreaterThan(events[index - 1]!.seq)
    }
    const toolCall = events.find(event => event.type === 'tool/call') as { data: { name: string } }
    expect(toolCall.data.name).toBe('bash')
    const toolResult = events.find(event => event.type === 'tool/result') as {
      data: { message: { content: Array<{ type: string; content: unknown[] }> } }
    }
    const terminalText = toolResult.data.message.content
      .filter(part => part.type === 'tool-result')
      .flatMap(part => part.content)
      .filter(entry => typeof entry === 'object' && entry !== null && (entry as { type?: string }).type === 'text')
      .map(entry => (entry as { text: string }).text)
      .join('')
    expect(terminalText).toContain('TERMINAL_OK')

    // Quit: terminate-and-join waits for the owned DSH child to exit (exit
    // code 0 proves the SIGTERM shutdown completed, not a crash). The tracer
    // command is synchronous, so no descendant outlives the tool call; a
    // surviving direct child of the exited DSH process would still show up
    // here. PTY-level quiescence assertions belong to the packaged-app smoke
    // of issue #3, which runs node-pty scenarios on installed artifacts.
    await supervisor.stop()
    expect(child.exitCode).toBe(0)
    expect(world.process.exitCode).toBe(0)
    const descendants = spawnSync('pgrep', ['-P', String(world.process.pid)], { encoding: 'utf8' })
    expect(descendants.error).toBeUndefined()
    expect(descendants.status).toBe(1)
  }, 180_000)
})
