/**
 * Platform process-tree inspection for the terminate-and-join shutdown ladder.
 * Electron-free by design: the ladder implementation is a pure function of an
 * injectable `ps` boundary, so unit tests drive deterministic tables while the
 * real macOS/Linux path uses `/bin/ps`. The DSH child runs as the leader of its
 * own process group (`detached`), so group membership stays identifiable after
 * the immediate parent dies and gets reparented; PTY session leaders keep a
 * distinct group and are reached through the snapshot of live descendants.
 */

import { execFileSync } from 'node:child_process'

/** One inspected process row. */
export interface ProcessTreeEntry {
  readonly pid: number
  readonly pgid: number
  /** Process start identity (`ps lstart`), used to defeat pid reuse. */
  readonly started: string
  /** Visible command line, for actionable cleanup reporting. */
  readonly command: string
}

/** A snapshot of the processes owned by one supervised root. */
export interface ProcessTreeSnapshot {
  readonly rootPid: number
  /** Whether the root process row was still alive (not exited or zombie). */
  readonly rootPresent: boolean
  /** Every owned process: live descendants plus process-group members. */
  readonly owned: readonly ProcessTreeEntry[]
}

/**
 * Termination surface of the shutdown ladder. Implementations must never
 * signal the caller's own process group, and `survivors` must exclude
 * processes whose identity changed since the snapshot (pid reuse).
 */
export interface ProcessTreeLadder {
  /** Enumerate the root's live descendants and process-group members. */
  snapshot(rootPid: number): ProcessTreeSnapshot
  /** Signal the process group of every entry once per distinct group. */
  signalGroups(entries: readonly ProcessTreeEntry[], signal: 'SIGTERM' | 'SIGKILL'): void
  /** Which snapshot entries still run (zombies excluded). */
  survivors(snapshot: ProcessTreeSnapshot): ProcessTreeEntry[]
}

const PS_COLUMNS = ['pid=,ppid=,pgid=,lstart=,stat=,command']

interface PsRow extends ProcessTreeEntry {
  readonly parentPid: number
  readonly state: string
}

function parsePsTable(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of output.split('\n')) {
    // pid, ppid, pgid are space-padded numbers; lstart is a fixed-format
    // timestamp with spaces; the rest is the state column plus the command.
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const [, pidRaw, parentPidRaw, pgidRaw, started, state, commandRaw] = match
    if (pidRaw === undefined || parentPidRaw === undefined || pgidRaw === undefined
      || started === undefined || state === undefined || commandRaw === undefined) continue
    const pid = Number(pidRaw)
    const parentPid = Number(parentPidRaw)
    const pgid = Number(pgidRaw)
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(pgid)) continue
    rows.push({ pid, parentPid, pgid, started, state, command: commandRaw.trim() })
  }
  return rows
}

/**
 * Real POSIX ladder backed by `ps -axo pid=,ppid=,pgid=,lstart=,stat=,command`.
 * Works on macOS and Linux; the Windows product target is deferred, so callers
 * fall back to child-only termination there.
 */
export class PosixProcessTreeLadder implements ProcessTreeLadder {
  constructor(private readonly table: () => PsRow[] = () => parsePsTable(execFileSync('/bin/ps', ['-axo', ...PS_COLUMNS], { encoding: 'utf8' }))) {}

  snapshot(rootPid: number): ProcessTreeSnapshot {
    const rows = this.table()
    const byParent = new Map<number, PsRow[]>()
    for (const row of rows) {
      const siblings = byParent.get(row.parentPid)
      if (siblings === undefined) byParent.set(row.parentPid, [row])
      else siblings.push(row)
    }
    const owned = new Map<number, PsRow>()
    const adopt = (row: PsRow): void => {
      if (owned.has(row.pid)) return
      owned.set(row.pid, row)
      for (const child of byParent.get(row.pid) ?? []) adopt(child)
    }
    for (const row of rows) if (row.pid === rootPid) adopt(row)
    // Group members stay identifiable after the immediate parent exits and is
    // reparented: they retain the group the root led.
    for (const row of rows) if (row.pgid === rootPid) adopt(row)
    owned.delete(rootPid)
    const rootRow = rows.find(row => row.pid === rootPid)
    return {
      rootPid,
      rootPresent: rootRow !== undefined && !rootRow.state.startsWith('Z'),
      owned: [...owned.values()],
    }
  }

  signalGroups(entries: readonly ProcessTreeEntry[], signal: 'SIGTERM' | 'SIGKILL'): void {
    const signaled = new Set<number>()
    for (const entry of entries) {
      if (signaled.has(entry.pgid)) continue
      signaled.add(entry.pgid)
      // Never signal the supervisor's own group, which this ladder shares
      // with the rest of Electron main.
      if (entry.pgid === process.pid) continue
      try {
        process.kill(-entry.pgid, signal)
      } catch (error) {
        // ESRCH: the group emptied between the scan and the signal — the
        // process this group represented is already gone.
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ESRCH') throw error
      }
    }
  }

  survivors(snapshot: ProcessTreeSnapshot): ProcessTreeEntry[] {
    const rows = this.table()
    const alive = new Map(rows.map(row => [row.pid, row]))
    return snapshot.owned.filter((entry) => {
      const row = alive.get(entry.pid)
      return row !== undefined && !row.state.startsWith('Z') && row.started === entry.started
    })
  }
}

/**
 * Create the platform ladder, or undefined where process groups cannot be
 * inspected (Windows, whose desktop target is deferred).
 * @param platform - target Node platform.
 * @returns the ladder for POSIX platforms.
 */
export function createProcessTreeLadder(platform: NodeJS.Platform = process.platform): ProcessTreeLadder | undefined {
  if (platform === 'darwin' || platform === 'linux') return new PosixProcessTreeLadder()
  return undefined
}
