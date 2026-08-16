/**
 * Process-tree ladder coverage over injected ps tables: descendant BFS, group
 * membership that outlives the immediate parent, zombie exclusion, start-time
 * identity against pid reuse, group-signal dedupe, and the own-group guard.
 */

import { describe, expect, it, vi } from 'vitest'
import { PosixProcessTreeLadder, createProcessTreeLadder, type ProcessTreeEntry } from '../src/process-tree.ts'

function ladderOf(rows: string): PosixProcessTreeLadder {
  return new PosixProcessTreeLadder(() => parseRows(rows))
}

/** Parse a minimal hand-written ps table (pid ppid pgid lstart stat command). */
function parseRows(rows: string): Array<ProcessTreeEntry & { parentPid: number; state: string }> {
  // Reuse the real parser through the public class boundary is not possible
  // (it is private), so build rows directly from the canonical column format.
  return rows.trim().split('\n').filter(line => line.trim() !== '').map((line) => {
    const trimmed = line.trim()
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(\S+)\s+(.*)$/.exec(trimmed)
    if (match === null) throw new Error(`bad fixture row: ${trimmed}`)
    return {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      pgid: Number(match[3]),
      started: match[4] as string,
      state: match[5] as string,
      command: match[6] as string,
    }
  })
}

// Fixture columns: pid ppid pgid lstart stat command.
const TABLE = `
  400    1   400 Fri Aug 14 12:00:01 2026 S    dsh-host
  401  400   400 Fri Aug 14 12:00:02 2026 S    bash -c sleep 300
  402  401   400 Fri Aug 14 12:00:03 2026 S    sleep 300
  404  401   404 Fri Aug 14 12:00:04 2026 Ss   login -pf user
  405    1   400 Fri Aug 14 12:00:06 2026 S    orphaned-grandchild
  406    1   406 Fri Aug 14 12:00:07 2026 S    unrelated
  407  402   400 Fri Aug 14 12:00:08 2026 Z    dead-zombie
`

describe('POSIX process-tree ladder', () => {
  it('snapshots live descendants plus group members that outlived their parent', () => {
    const ladder = ladderOf(TABLE)
    const snapshot = ladder.snapshot(400)
    const pids = snapshot.owned.map(entry => entry.pid).sort((a, b) => a - b)
    // 401/402/404: descendants (404 is a PTY session leader under the tree);
    // 405: reparented but still in the root's group; 406: unrelated group;
    // 407: zombie descendant — in the snapshot but not a survivor.
    expect(pids).toEqual([401, 402, 404, 405, 407])
    expect(ladder.survivors(snapshot).map(entry => entry.pid)).toEqual([401, 402, 404, 405])
  })

  it('excludes a recycled pid whose start identity changed', () => {
    const ladder = ladderOf(TABLE)
    const snapshot = ladder.snapshot(400)
    const recycled = new PosixProcessTreeLadder(() => parseRows(`
      400    1   400 Fri Aug 14 12:00:01 2026 S    dsh-host
      401  400   400 Fri Aug 14 13:00:00 2026 S    different-process
    `))
    expect(recycled.survivors(snapshot).map(entry => entry.pid)).toEqual([])
  })

  it('signals each distinct group once and never the caller own group', () => {
    const ladder = ladderOf(TABLE)
    const snapshot = ladder.snapshot(400)
    const killed: Array<[number, string]> = []
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      killed.push([pid, signal as string])
      return true
    })
    try {
      ladder.signalGroups(ladder.survivors(snapshot), 'SIGKILL')
      expect(killed).toEqual([
        [-400, 'SIGKILL'],
        [-404, 'SIGKILL'],
      ])
    } finally {
      kill.mockRestore()
    }
  })

  it('keeps own-group processes out of the signal list', () => {
    const own = process.pid
    const ladder = new PosixProcessTreeLadder(() => parseRows(`
      400    1   ${String(own)} Fri Aug 14 12:00:01 2026 S    main
    `))
    const snapshot = ladder.snapshot(400)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      ladder.signalGroups(ladder.survivors(snapshot), 'SIGTERM')
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })

  it('creates the real ladder on POSIX and none on Windows', () => {
    expect(createProcessTreeLadder('darwin')).toBeInstanceOf(PosixProcessTreeLadder)
    expect(createProcessTreeLadder('linux')).toBeInstanceOf(PosixProcessTreeLadder)
    expect(createProcessTreeLadder('win32')).toBeUndefined()
  })
})
