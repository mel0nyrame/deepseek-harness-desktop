/** Electron-free process-tree inspection for deterministic runtime cleanup. */

import { execFileSync } from 'node:child_process'

/** One snapshotted member of the supervised process tree. */
export interface ProcessTreeEntry {
  readonly pid: number
  readonly pgid: number
  readonly started: string
  readonly command: string
}

/** Owned descendants captured while the DSH root is still alive. */
export interface ProcessTreeSnapshot {
  readonly rootPid: number
  readonly rootPresent: boolean
  readonly owned: readonly ProcessTreeEntry[]
}

/** Process-group termination and identity-safe liveness checks. */
export interface ProcessTreeLadder {
  snapshot(rootPid: number): ProcessTreeSnapshot
  signalGroups(entries: readonly ProcessTreeEntry[], signal: 'SIGTERM' | 'SIGKILL'): void
  survivors(snapshot: ProcessTreeSnapshot): ProcessTreeEntry[]
}

interface ProcessRow extends ProcessTreeEntry {
  readonly parentPid: number
  readonly state: string
}

const PS_COLUMNS = ['pid=,ppid=,pgid=,lstart=,stat=,command']

function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const [, pidValue, parentValue, groupValue, started, state, command] = match
    if (pidValue === undefined || parentValue === undefined || groupValue === undefined
      || started === undefined || state === undefined || command === undefined) continue
    const pid = Number(pidValue)
    const parentPid = Number(parentValue)
    const pgid = Number(groupValue)
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(pgid)) continue
    rows.push({ pid, parentPid, pgid, started, state, command: command.trim() })
  }
  return rows
}

/** POSIX implementation backed by one `ps` table per operation. */
export class PosixProcessTreeLadder implements ProcessTreeLadder {
  private readonly table: () => ProcessRow[]

  constructor(table: () => ProcessRow[] = () => parseProcessTable(
    execFileSync('/bin/ps', ['-axo', ...PS_COLUMNS], { encoding: 'utf8' }),
  )) {
    this.table = table
  }

  snapshot(rootPid: number): ProcessTreeSnapshot {
    const rows = this.table()
    const byParent = new Map<number, ProcessRow[]>()
    for (const row of rows) {
      const children = byParent.get(row.parentPid)
      if (children === undefined) byParent.set(row.parentPid, [row])
      else children.push(row)
    }
    const owned = new Map<number, ProcessRow>()
    const adopt = (row: ProcessRow): void => {
      if (owned.has(row.pid)) return
      owned.set(row.pid, row)
      for (const child of byParent.get(row.pid) ?? []) adopt(child)
    }
    for (const row of rows) if (row.pid === rootPid || row.pgid === rootPid) adopt(row)
    owned.delete(rootPid)
    const root = rows.find(row => row.pid === rootPid)
    return {
      rootPid,
      rootPresent: root !== undefined && !root.state.startsWith('Z'),
      owned: [...owned.values()],
    }
  }

  signalGroups(entries: readonly ProcessTreeEntry[], signal: 'SIGTERM' | 'SIGKILL'): void {
    const signaled = new Set<number>()
    for (const entry of entries) {
      if (entry.pgid === process.pid || signaled.has(entry.pgid)) continue
      signaled.add(entry.pgid)
      try {
        process.kill(-entry.pgid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }

  survivors(snapshot: ProcessTreeSnapshot): ProcessTreeEntry[] {
    const alive = new Map(this.table().map(row => [row.pid, row]))
    return snapshot.owned.filter((entry) => {
      const current = alive.get(entry.pid)
      return current !== undefined && current.started === entry.started && !current.state.startsWith('Z')
    })
  }
}

/** Return the real cleanup ladder on supported desktop targets. */
export function createProcessTreeLadder(
  platform: NodeJS.Platform = process.platform,
): ProcessTreeLadder | undefined {
  return platform === 'darwin' || platform === 'linux' ? new PosixProcessTreeLadder() : undefined
}
