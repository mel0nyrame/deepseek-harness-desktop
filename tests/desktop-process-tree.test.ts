import { describe, expect, it, vi } from 'vitest'
import {
  PosixProcessTreeLadder,
  createProcessTreeLadder,
  type ProcessTreeEntry,
} from '../apps/desktop/src/process-tree.js'

type ProcessRow = ProcessTreeEntry & { readonly parentPid: number; readonly state: string }

function rows(source: string): ProcessRow[] {
  return source.trim().split('\n').filter(line => line.trim() !== '').map((line) => {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(\S+)\s+(.*)$/.exec(line.trim())
    if (match === null) throw new Error(`bad process fixture row: ${line.trim()}`)
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

function ladder(source: string): PosixProcessTreeLadder {
  return new PosixProcessTreeLadder(() => rows(source))
}

const TABLE = `
  400    1   400 Fri Aug 14 12:00:01 2026 S    dsh-host
  401  400   400 Fri Aug 14 12:00:02 2026 S    bash -c sleep 300
  402  401   400 Fri Aug 14 12:00:03 2026 S    sleep 300
  404  401   404 Fri Aug 14 12:00:04 2026 Ss   login -pf user
  405    1   400 Fri Aug 14 12:00:06 2026 S    orphaned-grandchild
  406    1   406 Fri Aug 14 12:00:07 2026 S    unrelated
  407  402   400 Fri Aug 14 12:00:08 2026 Z    dead-zombie
`

describe('POSIX desktop process-tree ladder', () => {
  it('snapshots descendants and reparented root-group members', () => {
    const tree = ladder(TABLE)
    const snapshot = tree.snapshot(400)

    expect(snapshot.owned.map(entry => entry.pid).toSorted((a, b) => a - b)).toEqual([
      401, 402, 404, 405, 407,
    ])
    expect(tree.survivors(snapshot).map(entry => entry.pid)).toEqual([401, 402, 404, 405])
  })

  it('excludes a recycled pid whose start identity changed', () => {
    const snapshot = ladder(TABLE).snapshot(400)
    const recycled = ladder(`
      400    1   400 Fri Aug 14 12:00:01 2026 S    dsh-host
      401  400   400 Fri Aug 14 13:00:00 2026 S    different-process
    `)

    expect(recycled.survivors(snapshot)).toEqual([])
  })

  it('signals each owned group once and never the supervisor group', () => {
    const tree = ladder(TABLE)
    const snapshot = tree.snapshot(400)
    const killed: Array<[number, string | number | undefined]> = []
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      killed.push([pid, signal])
      return true
    })
    try {
      tree.signalGroups(tree.survivors(snapshot), 'SIGKILL')
      expect(killed).toEqual([
        [-400, 'SIGKILL'],
        [-404, 'SIGKILL'],
      ])

      const ownGroup = new PosixProcessTreeLadder(() => rows(`
        500    1   500 Fri Aug 14 12:00:01 2026 S    dsh-host
        501  500   ${String(process.pid)} Fri Aug 14 12:00:02 2026 S    shared-group-child
      `))
      ownGroup.signalGroups(ownGroup.survivors(ownGroup.snapshot(500)), 'SIGTERM')
      expect(killed).toHaveLength(2)
    } finally {
      kill.mockRestore()
    }
  })

  it('creates a real ladder only on supported POSIX targets', () => {
    expect(createProcessTreeLadder('darwin')).toBeInstanceOf(PosixProcessTreeLadder)
    expect(createProcessTreeLadder('linux')).toBeInstanceOf(PosixProcessTreeLadder)
    expect(createProcessTreeLadder('win32')).toBeUndefined()
  })
})
