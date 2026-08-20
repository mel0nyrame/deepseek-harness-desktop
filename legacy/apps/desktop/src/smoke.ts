import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DshSupervisor } from './supervisor.ts'

/** Desktop profile manifest: the shipped template's three bundle layers. */
const PROFILE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-desktop-app',
]

/**
 * Keyless replay rows layered over the desktop profile: no adapter calls the
 * network. The primary fixture binds to the first live session; each child
 * fixture binds to the next live session in first-model-call order (the
 * llm-replay binding contract). The composed `session-title-llm` row is
 * disabled for the same reason the Web scaffold disables it: its
 * fire-and-forget auxiliary title call would race the loop for the session's
 * replay cursor.
 */
export function replayPatch(replayFile: string, childFiles: readonly string[]): string {
  return [
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    '- insert:',
    '    - id: llm-replay',
    '      name: \'@deepseek-ai/dsh-llm-replay\'',
    '      config:',
    '        file: ' + JSON.stringify(replayFile),
    ...(childFiles.length === 0 ? [] : [
      '        childFiles:',
      ...childFiles.map(child => '          - ' + JSON.stringify(child)),
    ]),
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
 * @param replayFile - absolute path of the primary recorded replay session.
 * @param replayProviderDir - absolute package dir of `@deepseek-ai/dsh-llm-replay`.
 * @param childFiles - additional recorded sessions bound to later live sessions.
 * @returns the harness home the profile was written under.
 */
export function prepareSmokeProfile(
  replayFile: string,
  replayProviderDir: string,
  childFiles: readonly string[] = [],
): string {
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
  writeFileSync(join(profileDir, 'cordis.patch.yml'), replayPatch(replayFile, childFiles))
  const fallback = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-llm-replay')
  mkdirSync(dirname(fallback), { recursive: true })
  rmSync(fallback, { recursive: true, force: true })
  symlinkSync(replayProviderDir, fallback, 'dir')
  return home
}

/**
 * Seed a desktop profile whose `cordis.patch.yml` cannot parse, so the bundled
 * Host fails configuration at startup. This is the deterministic configuration
 * failure the recovery acceptance journey exercises; {@link prepareSmokeProfile}
 * repairs it with a valid keyless replay profile.
 */
export function prepareBrokenProfile(): string {
  const home = process.env.DSH_HOME
  if (home === undefined || home.trim() === '') {
    throw new Error('desktop recovery requires an explicit DSH_HOME so it never touches the owner\'s ~/.dsh')
  }
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: PROFILE_BUNDLES } },
  }, undefined, 2))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- insert: [not valid yaml\n  trailing:')
  return home
}

export const RECORDED_PROMPT = 'Use the bash tool to run exactly: echo TERMINAL_OK. Then reply with the single word DONE and stop.'

/**
 * The recorded question turn: the model asks exactly one multi-select question
 * and finishes with DONE after the human answers. Mirrors the Web
 * `question-composer` fixture verbatim so the replayed turn and the live
 * prompt agree.
 */
export const QUESTION_PROMPT = 'Use the ask_user_question tool to ask me exactly one multi-select question with id "color", question "Which color do you prefer?", header "Pick one", and two options: label "Blue" with description "A cool recessive hue that reads as calm and trustworthy in long reading sessions and dense dashboards.", and label "Green" with description "A restful mid-spectrum hue with the highest perceived brightness, easiest on the eye over long sessions." Set multi_select to true. After I answer, reply with the single word DONE and stop.'

/** The answer the recorded question turn expects; the driver replies it over the wire. */
export const QUESTION_ANSWER = { answers: [{ id: 'color', selected: ['Blue'], custom: 'Include accessibility notes' }] }

/**
 * Unrelated deterministic tokens the recorded approval turn writes through the
 * escalated bash command. The formula matches the Web `approval-composer`
 * fixture so the replayed command text is the literal the prompt spells out.
 */
const TOKENS = Array.from({ length: 220 }, (_, index) => `tok${((index + 1) * 7919 % 99991).toString(36)}`).join(' ')
export const APPROVAL_PROMPT = `Write a file named notes.txt in the workspace containing exactly this text on one line: ${TOKENS}. Use one bash command with the literal text inline. Then reply with the single word DONE and stop.`
export const APPROVAL_FILE = 'notes.txt'

interface StreamRecord {
  readonly method: string
  readonly rpcId: string
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

/**
 * Execute one slash command through the carrier's `commands/execute` Remote
 * endpoint — the same Typert remote call the Web client's `session.command`
 * sends. Returns the command's settled business result.
 */
async function executeCommand(
  supervisor: DshSupervisor,
  sessionId: string,
  line: string,
): Promise<{ kind: string; text: string }> {
  const response = await supervisor.request({
    type: 'request',
    id: `smoke-command-${line}`,
    url: 'dsh://app/api/commands/execute',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `smoke-command-${line}`,
      method: 'commands/execute',
      payload: { args: { agentId: sessionId, line } },
    }),
  })
  if (response.status !== 200) throw new Error(`desktop smoke commands/execute returned status ${String(response.status)}`)
  const parsed = JSON.parse(response.body) as {
    type: string
    result: { ok: true; value: unknown } | { ok: false; error: unknown }
  }
  if (parsed.type !== 'server-response' || !parsed.result.ok) {
    throw new Error(`desktop smoke commands/execute failed: ${JSON.stringify(parsed)}`)
  }
  const value = parsed.result.value as { result?: { kind?: unknown; text?: unknown } }
  const commandResult = value.result
  if (commandResult === undefined
    || typeof commandResult.kind !== 'string'
    || typeof commandResult.text !== 'string') {
    throw new Error(`desktop smoke commands/execute returned a malformed result: ${JSON.stringify(value)}`)
  }
  return { kind: commandResult.kind, text: commandResult.text }
}

/**
 * Answer one server-request interaction (approval or question) through the
 * carrier's `/api/respond` endpoint, echoing the request's rpcId. The receipt
 * (`accepted: true`) is the carrier's own settlement, not a server-response
 * envelope.
 */
async function respond(
  supervisor: DshSupervisor,
  rpcId: string,
  value: Record<string, unknown>,
): Promise<void> {
  const response = await supervisor.request({
    type: 'request',
    id: `smoke-respond-${rpcId}`,
    url: 'dsh://app/api/respond',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
  })
  if (response.status !== 200) throw new Error(`desktop smoke respond returned status ${String(response.status)}`)
  const receipt = JSON.parse(response.body) as { accepted?: unknown; reason?: unknown }
  if (receipt.accepted !== true) {
    throw new Error(`desktop smoke respond was not accepted: ${JSON.stringify(receipt)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`desktop smoke assertion failed: ${message}`)
}

interface FrameEvent {
  readonly type: string
  readonly seq?: number
  readonly data?: Record<string, unknown>
}

/** Session events carried on the mux stream for one live session. */
function sessionEvents(records: readonly StreamRecord[], sessionId: string): FrameEvent[] {
  return records
    .filter(record => record.method === 'session/event' && record.payload['sessionId'] === sessionId)
    .map(record => record.payload['event'] as FrameEvent)
}

/** Wait until one predicate over the mux stream becomes true, or fail on stream error. */
async function waitFor(
  records: readonly StreamRecord[],
  streamFailure: string | undefined,
  description: string,
  predicate: (records: readonly StreamRecord[]) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate(records)) return
    if (streamFailure !== undefined) throw new Error(`desktop smoke mux stream failed: ${streamFailure}`)
    if (Date.now() > deadline) {
      throw new Error(`desktop smoke timed out waiting for ${description}; records: ${JSON.stringify(records).slice(0, 4000)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/** Wait for one turn to end cleanly and return its session events. */
async function waitForCompletedTurn(
  records: readonly StreamRecord[],
  streamFailure: string | undefined,
  sessionId: string,
): Promise<FrameEvent[]> {
  await waitFor(records, streamFailure, `turn end for ${sessionId}`, (current) => {
    const events = sessionEvents(current, sessionId)
    return events.some(event => event.type === 'turn/end')
  }, 120_000)
  const events = sessionEvents(records, sessionId)
  const turnEnd = events.findLast(event => event.type === 'turn/end')
  const reason = turnEnd?.data?.['reason'] as { kind?: unknown } | undefined
  assert(reason?.kind === 'completed', `the ${sessionId} turn completed without error (observed ${JSON.stringify(reason)})`)
  return events
}

/** Join the last tool result's text parts into one string ('' when absent). */
export function toolResultText(events: readonly { type: string; data?: unknown }[]): string {
  const dataOf = (data: unknown): Record<string, unknown> | undefined =>
    typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined
  const result = events.findLast(event => event.type === 'tool/result' && dataOf(event.data)?.['message'] !== undefined)
  const message = dataOf(result?.data)?.['message'] as { content?: Array<{ type?: unknown; content?: unknown[] }> } | undefined
  return message?.content
    ?.filter(part => part.type === 'tool-result')
    .flatMap(part => part.content ?? [])
    .filter(entry => typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'text')
    .map(entry => (entry as { text: string }).text)
    .join('') ?? ''
}

interface SmokeState {
  readonly workspacePath: string
  readonly sessionIds: { readonly terminal: string; readonly question: string; readonly approval: string }
}

/** DSH_HOME-relative file carrying the durable records the reopen launch asserts. */
const SMOKE_REOPEN_STATE_FILE = 'smoke-reopen-state.json'

function writeReopenState(home: string, state: SmokeState): void {
  writeFileSync(join(home, SMOKE_REOPEN_STATE_FILE), JSON.stringify(state))
}

function readReopenState(home: string): SmokeState {
  const path = join(home, SMOKE_REOPEN_STATE_FILE)
  if (!existsSync(path)) throw new Error(`desktop smoke reopen: ${path} is missing; run --smoke first`)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`desktop smoke reopen: ${path} is malformed; run --smoke first to rewrite it`)
  }
  const state = parsed as Record<string, unknown>
  const sessionIds = state['sessionIds'] as Record<string, unknown> | undefined
  if (typeof state['workspacePath'] !== 'string'
    || sessionIds === undefined
    || typeof sessionIds['terminal'] !== 'string'
    || typeof sessionIds['question'] !== 'string'
    || typeof sessionIds['approval'] !== 'string') {
    throw new Error(`desktop smoke reopen: ${path} is malformed; run --smoke first to rewrite it`)
  }
  return {
    workspacePath: state['workspacePath'],
    sessionIds: {
      terminal: sessionIds['terminal'],
      question: sessionIds['question'],
      approval: sessionIds['approval'],
    },
  }
}

/**
 * Drive the interaction-parity scenario over a booted supervisor. Prints one
 * `SMOKE_OK` line per verified stage so the outer driver can attribute failures
 * precisely; every failure throws and becomes a non-zero application exit.
 * The caller (the lifecycle owner) stops the child and prints the quit
 * verdict, so this scenario never claims shutdown on its own.
 *
 * Stages: readiness and the no-listener probe; durable Workspace creation and
 * idempotent reopen; the ordered terminal turn; a question turn answered over
 * the carrier; an approval turn (sandbox escalation) answered over the
 * carrier; and reconstruction of every model-visible input from the durable
 * Session logs. The stage result is also recorded as the reopen state file
 * the `--smoke-reopen` launch consumes.
 * @param supervisor - supervisor wrapping the spawned DSH child.
 * @param childPid - the DSH child's operating-system process id, for the listener probe.
 * @param home - the harness home the scenario works under (the child's `$DSH_HOME`).
 */
export async function runSmokeScenario(supervisor: DshSupervisor, childPid: number, home: string): Promise<void> {
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

  const records: StreamRecord[] = []
  let streamFailure: string | undefined
  supervisor.onStream((message) => {
    if (message.id !== 'smoke-mux') return
    if (message.type === 'stream-message') {
      const frame = message.message as { method: string; rpcId: string; payload: Record<string, unknown> }
      records.push({ method: frame.method, rpcId: frame.rpcId, payload: frame.payload })
    } else if (message.type === 'stream-error') {
      streamFailure = message.message
    }
  })
  supervisor.subscribe('smoke-mux', 'mux')

  // Durable Workspace: create over an existing directory, then reopen the
  // same path idempotently — one registration, no duplicate product state.
  // The service stores the canonical (realpath) spelling; keep that returned
  // value so the reopen comparison uses the same canon.
  const smokeWorkspaceDir = join(home, 'smoke-workspace')
  mkdirSync(smokeWorkspaceDir, { recursive: true })
  const created = await unary(supervisor, 'smoke-workspace-create', 'workspace.create', { path: smokeWorkspaceDir })
  assert(created['created'] === true, 'workspace.create registered a new workspace')
  const workspace = created['workspace'] as Record<string, unknown>
  const workspaceId = workspace['workspaceId']
  assert(typeof workspaceId === 'string', 'workspace.create returned a workspace id')
  assert(typeof workspace['path'] === 'string', 'workspace.create returned its canonical path')
  const workspacePath = workspace['path']
  const reopened = await unary(supervisor, 'smoke-workspace-reopen', 'workspace.create', { path: workspacePath })
  assert(reopened['created'] === false, 'reopening the same path resolves the existing workspace')
  assert((reopened['workspace'] as Record<string, unknown>)['workspaceId'] === workspaceId, 'the reopen returns the same workspace id')
  const listed = await unary(supervisor, 'smoke-workspace-list', 'workspace.list', {})
  const workspaceItems = listed['items'] as Array<Record<string, unknown>>
  assert(workspaceItems.some(item => item['workspaceId'] === workspaceId), 'workspace.list carries the smoke workspace')
  console.log('SMOKE_OK workspace')

  // Terminal turn: the recorded bash turn streams ordered events and ends cleanly.
  const terminalCreated = await unary(supervisor, 'smoke-session-create', 'session.create', { workspaceId })
  const terminalSessionId = terminalCreated['sessionId']
  assert(typeof terminalSessionId === 'string', 'session.create returned a session id')
  console.log('SMOKE_OK session')

  const prompted = await unary(supervisor, 'smoke-prompt', 'session.prompt', {
    sessionId: terminalSessionId,
    mode: 'queue',
    content: [{ type: 'text', text: RECORDED_PROMPT }],
  })
  assert(prompted['accepted'] === true, 'the recorded prompt was accepted')
  const terminalEvents = await waitForCompletedTurn(records, streamFailure, terminalSessionId)

  const types = terminalEvents.map(event => event.type)
  for (const expected of ['turn/start', 'tool/call', 'tool/result', 'turn/end', 'session/title']) {
    assert(types.includes(expected), `mux stream carried ${expected}`)
  }
  let previousSeq: number | undefined
  for (const event of terminalEvents) {
    if (event.seq === undefined) continue
    if (previousSeq === undefined) {
      previousSeq = event.seq
      continue
    }
    assert(event.seq > previousSeq, 'event sequence numbers are monotonically increasing')
    previousSeq = event.seq
  }
  const toolCall = terminalEvents.find(event => event.type === 'tool/call') as unknown as { data: { name: string } }
  assert(toolCall.data.name === 'bash', 'the recorded turn calls the bash tool')
  assert(toolResultText(terminalEvents).includes('TERMINAL_OK'), 'the terminal tool result streams TERMINAL_OK')
  console.log('SMOKE_OK terminal')

  // Question turn: the model asks one multi-select question; the driver
  // answers through the carrier's respond endpoint and the turn settles.
  const questionCreated = await unary(supervisor, 'smoke-question-create', 'session.create', {})
  const questionSessionId = questionCreated['sessionId']
  assert(typeof questionSessionId === 'string', 'session.create returned a question session id')
  await unary(supervisor, 'smoke-question-prompt', 'session.prompt', {
    sessionId: questionSessionId,
    mode: 'queue',
    content: [{ type: 'text', text: QUESTION_PROMPT }],
  })
  await waitFor(records, streamFailure, 'the question request', current => current.some(record =>
    record.method === 'question/requested' && record.payload['sessionId'] === questionSessionId), 120_000)
  const questionRequest = records.find(record =>
    record.method === 'question/requested' && record.payload['sessionId'] === questionSessionId) as StreamRecord
  await respond(supervisor, questionRequest.rpcId, {
    sessionId: questionSessionId,
    answer: QUESTION_ANSWER,
  })
  await waitFor(records, streamFailure, 'the question resolution', current => current.some(record =>
    record.method === 'question/resolved'
    && record.payload['sessionId'] === questionSessionId
    && record.payload['outcome'] === 'answered'), 120_000)
  const questionEvents = await waitForCompletedTurn(records, streamFailure, questionSessionId)
  assert(
    questionEvents.some(event => event.type === 'tool/call' && (event.data?.['name'] as string) === 'ask_user_question'),
    'the question turn calls the ask_user_question tool',
  )
  const questionToolResult = toolResultText(questionEvents)
  const expectedAnswer = JSON.stringify(QUESTION_ANSWER)
  assert(questionToolResult.includes(expectedAnswer), 'the question tool result carries the recorded answer')
  console.log('SMOKE_OK question')

  // Approval turn: switch the session to the read-only preset through the
  // shipped /permission command, then the replayed escalation asks for
  // approval; the driver answers allowed-once and the escalated command runs.
  const approvalWorkspace = join(home, 'approval-workspace')
  mkdirSync(approvalWorkspace, { recursive: true })
  const approvalCreated = await unary(supervisor, 'smoke-approval-create', 'session.create', { cwd: approvalWorkspace })
  const approvalSessionId = approvalCreated['sessionId']
  assert(typeof approvalSessionId === 'string', 'session.create returned an approval session id')
  const permission = await executeCommand(supervisor, approvalSessionId, '/permission read-only')
  assert(permission.kind === 'success', 'the /permission read-only command executed')
  await unary(supervisor, 'smoke-approval-prompt', 'session.prompt', {
    sessionId: approvalSessionId,
    mode: 'queue',
    content: [{ type: 'text', text: APPROVAL_PROMPT }],
  })
  await waitFor(records, streamFailure, 'the approval request', current => current.some(record =>
    record.method === 'approval/requested' && record.payload['sessionId'] === approvalSessionId), 120_000)
  const approvalRequest = records.find(record =>
    record.method === 'approval/requested' && record.payload['sessionId'] === approvalSessionId) as StreamRecord
  assert(approvalRequest.payload['toolName'] === 'bash', 'the approval asks about the bash tool')
  await respond(supervisor, approvalRequest.rpcId, {
    sessionId: approvalSessionId,
    approvalId: approvalRequest.payload['approvalId'],
    outcome: 'allowed-once',
  })
  await waitFor(records, streamFailure, 'the approval resolution', current => current.some(record =>
    record.method === 'approval/resolved'
    && record.payload['sessionId'] === approvalSessionId
    && record.payload['outcome'] === 'allowed-once'), 120_000)
  const approvalEvents = await waitForCompletedTurn(records, streamFailure, approvalSessionId)
  const approvalFile = join(approvalWorkspace, APPROVAL_FILE)
  assert(existsSync(approvalFile), 'the escalated command wrote notes.txt into the session workspace')
  assert(readFileSync(approvalFile, 'utf8').trim().startsWith('tok63z'), 'notes.txt carries the recorded token line')
  assert(
    approvalEvents.some(event => event.type === 'approval/asked' && event.data?.['toolName'] === 'bash'),
    'the session log records the approval question',
  )
  assert(
    approvalEvents.some(event => event.type === 'approval/decided' && event.data?.['outcome'] === 'allowed-once'),
    'the session log records the allowed-once decision',
  )
  console.log('SMOKE_OK approval')

  // Reconstruction: every model-visible input survives in the durable session
  // logs, and the sessions remain listed through the existing persistence.
  const listedSessions = await unary(supervisor, 'smoke-session-list', 'session.list', {})
  const sessionItems = listedSessions['items'] as Array<Record<string, unknown>>
  for (const id of [terminalSessionId, questionSessionId, approvalSessionId]) {
    assert(sessionItems.some(item => item['sessionId'] === id), `session.list carries ${id}`)
  }
  const history = await unary(supervisor, 'smoke-history-terminal', 'session.history', {
    sessionId: terminalSessionId, maxMessages: 50,
  })
  const historyEvents = ((history['events'] as Array<{ event: FrameEvent }>).map(entry => entry.event))
  assert(
    historyEvents.some(event => event.type === 'user/message'
      && JSON.stringify(event.data?.['content']).includes(RECORDED_PROMPT)),
    'the terminal session log reconstructs the recorded prompt',
  )
  assert(
    historyEvents.some(event => event.type === 'tool/result' && JSON.stringify(event.data?.['message']).includes('TERMINAL_OK')),
    'the terminal session log reconstructs the tool result',
  )
  const approvalHistory = await unary(supervisor, 'smoke-history-approval', 'session.history', {
    sessionId: approvalSessionId, maxMessages: 50,
  })
  const approvalHistoryEvents = ((approvalHistory['events'] as Array<{ event: FrameEvent }>).map(entry => entry.event))
  assert(
    approvalHistoryEvents.some(event => event.type === 'approval/asked')
    && approvalHistoryEvents.some(event => event.type === 'approval/decided'),
    'the approval session log reconstructs the approval audit pair',
  )
  assert(
    approvalHistoryEvents.some(event => event.type === 'user/message'
      && JSON.stringify(event.data?.['content']).includes('notes.txt')),
    'the approval session log reconstructs its prompt',
  )
  const settings = await unary(supervisor, 'smoke-settings', 'settings.describe', {})
  assert(Array.isArray(settings['namespaces']), 'settings.describe returns the settings registry')
  console.log('SMOKE_OK reconstruction')

  writeReopenState(home, {
    workspacePath,
    sessionIds: { terminal: terminalSessionId, question: questionSessionId, approval: approvalSessionId },
  })
}

/**
 * Reopen mode: a second application launch over the same `$DSH_HOME` proves
 * the desktop product reopens the durable Workspace and Sessions the first
 * launch created — same persistence, no carrier-specific replay, no model
 * calls. Reads {@link SMOKE_REOPEN_STATE_FILE} written by
 * {@link runSmokeScenario} and asserts the durable records reconstruct.
 * @param supervisor - supervisor wrapping the spawned DSH child.
 * @param home - the harness home whose durable records are reopened.
 */
export async function runSmokeReopen(supervisor: DshSupervisor, home: string): Promise<void> {
  const ready = await supervisor.start()
  assert(ready.graph.entries.length > 0, 'the child announced an empty client graph')
  const state = readReopenState(home)
  const { sessionIds } = state
  console.log('SMOKE_OK reopen-ready')

  // Persistence settles write-behind; poll briefly for all three sessions.
  const deadline = Date.now() + 30_000
  let items: Array<Record<string, unknown>> = []
  for (;;) {
    const listed = await unary(supervisor, 'reopen-session-list', 'session.list', {})
    items = listed['items'] as Array<Record<string, unknown>>
    if ([sessionIds.terminal, sessionIds.question, sessionIds.approval]
      .every(id => items.some(item => item['sessionId'] === id))) break
    if (Date.now() > deadline) {
      throw new Error(`desktop smoke reopen: sessions did not reappear; items: ${JSON.stringify(items).slice(0, 2000)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  console.log('SMOKE_OK reopen-sessions')

  const listed = await unary(supervisor, 'reopen-workspace-list', 'workspace.list', {})
  const workspaces = listed['items'] as Array<Record<string, unknown>>
  const workspace = workspaces.find(item => item['path'] === state.workspacePath)
  assert(workspace !== undefined, 'workspace.list carries the smoke workspace after restart')
  const workspaceSessions = workspace['sessionIds'] as unknown[]
  assert(
    Array.isArray(workspaceSessions) && workspaceSessions.includes(sessionIds.terminal),
    'the reopened workspace still accounts the terminal session',
  )
  console.log('SMOKE_OK reopen-workspace')

  const terminalHistory = await unary(supervisor, 'reopen-history-terminal', 'session.history', {
    sessionId: sessionIds.terminal, maxMessages: 50,
  })
  const terminalEvents = ((terminalHistory['events'] as Array<{ event: FrameEvent }>).map(entry => entry.event))
  assert(
    terminalEvents.some(event => event.type === 'user/message'
      && JSON.stringify(event.data?.['content']).includes(RECORDED_PROMPT)),
    'the reopened terminal session reconstructs its prompt',
  )
  assert(
    terminalEvents.some(event => event.type === 'turn/end'
      && (event.data?.['reason'] as { kind?: unknown } | undefined)?.kind === 'completed'),
    'the reopened terminal session keeps its completed turn',
  )
  console.log('SMOKE_OK reopen-terminal-history')

  const approvalHistory = await unary(supervisor, 'reopen-history-approval', 'session.history', {
    sessionId: sessionIds.approval, maxMessages: 50,
  })
  const approvalEvents = ((approvalHistory['events'] as Array<{ event: FrameEvent }>).map(entry => entry.event))
  assert(
    approvalEvents.some(event => event.type === 'approval/asked')
    && approvalEvents.some(event => event.type === 'approval/decided'),
    'the reopened approval session reconstructs the audit pair',
  )
  console.log('SMOKE_OK reopen-approval-history')
}
