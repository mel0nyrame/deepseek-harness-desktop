/**
 * Keyless packaged-app tracer bullet, run inside Electron main: the same
 * Session → terminal command → streamed output → quit-cleanup scenario the
 * development e2e drives, replayed against the installed bundle. The smoke
 * driver (`tests/packaged-smoke.e2e.ts`) launches the packaged application
 * with `--smoke --smoke-replay <file>` and asserts this module's exit code,
 * output markers, and process-tree quiescence — proving the production
 * runtime closure, the Electron-ABI node-pty addon, the real spawn helper,
 * and terminate-and-join all work outside the source tree.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DshSupervisor } from './supervisor.ts'

/** Desktop profile manifest: the shipped template's three bundle layers. */
const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-desktop-app',
]

/** Keyless replay rows layered over the desktop profile: no adapter calls the network. */
function replayPatch(replayFile: string): string {
  return [
    '- id: llm-deepseek',
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

/**
 * Prepare the keyless smoke profile under the child's `$DSH_HOME`. Smoke mode
 * refuses to run without an explicit harness home: it must never touch the
 * machine owner's real `~/.dsh`. The keyless replay provider is not part of
 * the `dsh` installation's dependency graph, so the loader (which resolves
 * profile entries from `$DSH_HOME/profiles/node_modules` through the ordinary
 * parent-walk) cannot see it unless the application seeds the documented
 * fallback directory with its own dependency.
 * @param replayFile - absolute path of the recorded replay session.
 * @param replayProviderDir - absolute package dir of `@deepseek-ai/dsh-llm-replay`.
 * @returns the harness home the profile was written under.
 */
export function prepareSmokeProfile(replayFile: string, replayProviderDir: string): string {
  const home = process.env.DSH_HOME
  if (home === undefined || home.trim() === '') {
    throw new Error('desktop smoke requires an explicit DSH_HOME so it never touches the owner\'s ~/.dsh')
  }
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: PROFILE_BUNDLES } },
  }, undefined, 2))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), replayPatch(replayFile))
  const fallback = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm-replay')
  mkdirSync(dirname(fallback), { recursive: true })
  rmSync(fallback, { recursive: true, force: true })
  symlinkSync(replayProviderDir, fallback, 'dir')
  return home
}

const RECORDED_PROMPT = 'Use the bash tool to run exactly: echo TERMINAL_OK. Then reply with the single word DONE and stop.'

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
  if (response.status !== 200) throw new Error(`desktop smoke ${method} returned status ${String(response.status)}`)
  const parsed = JSON.parse(response.body) as {
    type: string
    result: { ok: true; value: unknown } | { ok: false; error: unknown }
  }
  if (parsed.type !== 'server-response') throw new Error(`desktop smoke ${method} returned ${parsed.type}`)
  if (!parsed.result.ok) throw new Error(`desktop smoke ${method} failed: ${JSON.stringify(parsed.result.error)}`)
  return parsed.result.value as Record<string, unknown>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`desktop smoke assertion failed: ${message}`)
}

/**
 * Drive the tracer scenario over a booted supervisor, then stop the child.
 * Prints one `SMOKE_OK` line per verified stage so the outer driver can
 * attribute failures precisely; every failure throws and becomes a non-zero
 * application exit.
 * @param supervisor - supervisor wrapping the spawned DSH child.
 * @param childPid - the DSH child's operating-system process id, for the listener probe.
 */
export async function runSmokeScenario(supervisor: DshSupervisor, childPid: number): Promise<void> {
  const ready = await supervisor.start()
  assert(ready.graph.entries.length > 0, 'the child announced an empty client graph')
  assert(
    ready.bundles.map(bundle => bundle.id).join(',') === ready.graph.entries.map(entry => entry.id).join(','),
    'every client entry has a bundle path',
  )
  for (const bundle of ready.bundles) {
    assert(!bundle.path.includes('.asar'), `bundle ${bundle.id} lives outside archives`)
  }
  console.log('SMOKE_OK ready')

  // No browser-facing HTTP listener: probe the live child's TCP sockets
  // directly (the desktop patch disables every web transport row).
  const listeners = spawnSync('lsof', ['-a', '-p', String(childPid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
  assert(listeners.error === undefined, 'the lsof probe ran')
  assert(listeners.stdout.trim() === '', 'the DSH child opens no TCP listener')
  console.log('SMOKE_OK no-tcp-listener')

  const created = await unary(supervisor, 'smoke-create', 'session.create', {})
  const sessionId = created['sessionId']
  assert(typeof sessionId === 'string', 'session.create returned a session id')
  console.log('SMOKE_OK session')

  const records: StreamRecord[] = []
  let streamFailure: string | undefined
  supervisor.onStream((message) => {
    if (message.id !== 'smoke-mux') return
    if (message.type === 'stream-message') {
      const frame = message.message as { method: string; payload: Record<string, unknown> }
      records.push({ method: frame.method, payload: frame.payload })
    } else if (message.type === 'stream-error') {
      streamFailure = message.message
    }
  })
  supervisor.subscribe('smoke-mux', 'mux')

  const prompted = await unary(supervisor, 'smoke-prompt', 'session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: RECORDED_PROMPT }],
  })
  assert(prompted['accepted'] === true, 'the recorded prompt was accepted')

  const deadline = Date.now() + 60_000
  for (;;) {
    const events = records
      .filter(record => record.method === 'session/event')
      .map(record => record.payload['event'] as { type: string })
    const hasToolResult = events.some(event => event.type === 'tool/result')
    const hasTurnEnd = events.some(event => event.type === 'turn/end')
    if (streamFailure !== undefined) throw new Error(`desktop smoke mux stream failed: ${streamFailure}`)
    if (hasToolResult && hasTurnEnd) break
    if (Date.now() > deadline) {
      throw new Error(`desktop smoke scenario did not settle; records: ${JSON.stringify(records).slice(0, 4000)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  const events = records
    .filter(record => record.method === 'session/event')
    .map(record => record.payload['event'] as { type: string; seq: number; data?: unknown })
  const types = events.map(event => event.type)
  for (const expected of ['turn/start', 'tool/call', 'tool/result', 'turn/end']) {
    assert(types.includes(expected), `mux stream carried ${expected}`)
  }
  let previousSeq: number | undefined
  for (const event of events) {
    if (previousSeq === undefined) {
      previousSeq = event.seq
      continue
    }
    assert(event.seq > previousSeq, 'event sequence numbers are monotonically increasing')
    previousSeq = event.seq
  }
  const toolCall = events.find(event => event.type === 'tool/call') as { data: { name: string } }
  assert(toolCall.data.name === 'bash', 'the recorded turn calls the bash tool')
  const toolResult = events.find(event => event.type === 'tool/result') as {
    data: { message: { content: Array<{ type: string; content: unknown[] }> } }
  }
  const terminalText = toolResult.data.message.content
    .filter(part => part.type === 'tool-result')
    .flatMap(part => part.content)
    .filter(entry => typeof entry === 'object' && entry !== null && (entry as { type?: string }).type === 'text')
    .map(entry => (entry as { text: string }).text)
    .join('')
  assert(terminalText.includes('TERMINAL_OK'), 'the terminal tool result streams TERMINAL_OK')
  console.log('SMOKE_OK terminal')

  await supervisor.stop()
  console.log('SMOKE_OK quit')
}
