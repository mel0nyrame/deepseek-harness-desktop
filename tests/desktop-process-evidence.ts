import { execFileSync } from 'node:child_process'

export interface ProcessIdentity {
  readonly pid: number
  readonly started: string
}

export interface ProcessOutput {
  readonly stdout: string | Buffer | null
  readonly stderr: string | Buffer | null
}

const PROCESS_START = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12]\d|3[01]) \d{2}:\d{2}:\d{2} \d{4}$/

/** A malformed evidence error that retains every identity parsed before the failure. */
export class ProcessEvidenceError extends Error {
  readonly identities: readonly ProcessIdentity[]

  constructor(message: string, identities: readonly ProcessIdentity[], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.identities = identities
  }
}

/** Convert captured subprocess output to text without changing its content. */
export function textOutput(value: string | Buffer | null): string {
  return typeof value === 'string' ? value : value?.toString('utf8') ?? ''
}

/** Parse every desktop process identity, failing on malformed process-boundary input. */
export function processIdentities(result: ProcessOutput): ProcessIdentity[] {
  const prefix = 'DESKTOP_PROCESS_IDENTITY '
  const identities = new Map<string, ProcessIdentity>()
  let malformed: { line: string; cause?: unknown } | undefined
  for (const line of `${textOutput(result.stdout)}\n${textOutput(result.stderr)}`.split('\n')) {
    if (!line.startsWith(prefix)) continue
    let value: unknown
    try {
      value = JSON.parse(line.slice(prefix.length))
    } catch (error) {
      malformed ??= { line, cause: error }
      continue
    }
    if (typeof value !== 'object' || value === null) {
      malformed ??= { line }
      continue
    }
    const { pid, started } = value as Partial<ProcessIdentity>
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0
      || typeof started !== 'string' || !PROCESS_START.test(started)) {
      malformed ??= { line }
      continue
    }
    identities.set(`${String(pid)}\0${started}`, { pid, started })
  }
  if (malformed !== undefined) {
    throw new ProcessEvidenceError(
      `invalid desktop process identity: ${malformed.line}`,
      [...identities.values()],
      malformed.cause,
    )
  }
  return [...identities.values()]
}

/** Return exact process identities that still name a live non-zombie process. */
export function liveProcessIdentities(
  identities: readonly ProcessIdentity[],
): ProcessIdentity[] {
  return identities.filter((identity) => {
    try {
      const output = execFileSync('/bin/ps', [
        '-p', String(identity.pid), '-o', 'lstart=', '-o', 'stat=',
      ], { encoding: 'utf8' }).trim()
      const state = output.startsWith(identity.started)
        ? output.slice(identity.started.length).trim()
        : ''
      return state !== '' && !state.startsWith('Z')
    } catch (error) {
      if ((error as { status?: unknown }).status === 1) return false
      throw error
    }
  })
}

/** Kill leaked exact identities and wait until none remain live. */
export function terminateProcessIdentities(
  identities: readonly ProcessIdentity[],
  timeoutMs = 5_000,
): void {
  for (const identity of liveProcessIdentities(identities)) {
    try {
      process.kill(identity.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const survivors = liveProcessIdentities(identities)
    if (survivors.length === 0) return
    if (Date.now() >= deadline) {
      throw new Error(`desktop processes did not reach quiescence: ${JSON.stringify(survivors)}`)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}
