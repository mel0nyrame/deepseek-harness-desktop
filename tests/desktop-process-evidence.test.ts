import { execFileSync, spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  liveProcessIdentities,
  ProcessEvidenceError,
  processIdentities,
  terminateProcessIdentities,
  type ProcessIdentity,
} from './desktop-process-evidence.js'

const children = new Map<number, ProcessIdentity>()

afterEach(() => {
  terminateProcessIdentities([...children.values()])
  children.clear()
})

describe('desktop process evidence', () => {
  it.each([
    'DESKTOP_PROCESS_IDENTITY not-json',
    'DESKTOP_PROCESS_IDENTITY {"pid":0,"started":"now"}',
    'DESKTOP_PROCESS_IDENTITY {"pid":42,"started":"now"}',
    'DESKTOP_PROCESS_IDENTITY {"pid":42,"started":""}',
  ])('rejects malformed process-boundary input', (line) => {
    expect(() => processIdentities({ stdout: line, stderr: '' })).toThrow(
      'invalid desktop process identity',
    )
  })

  it('retains valid identities for cleanup when another identity is malformed', () => {
    const identity = { pid: 42, started: 'Mon Sep  1 12:34:56 2026' }
    const valid = `DESKTOP_PROCESS_IDENTITY ${JSON.stringify(identity)}`
    try {
      processIdentities({ stdout: `${valid}\nDESKTOP_PROCESS_IDENTITY invalid`, stderr: '' })
      throw new Error('expected malformed process evidence to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessEvidenceError)
      expect((error as ProcessEvidenceError).identities).toEqual([identity])
    }
  })

  it('deduplicates identities and waits for leaked processes to stop', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    if (child.pid === undefined) throw new Error('test child has no pid')
    const started = execFileSync('/bin/ps', [
      '-p', String(child.pid), '-o', 'lstart=',
    ], { encoding: 'utf8' }).trim()
    const identity: ProcessIdentity = { pid: child.pid, started }
    children.set(child.pid, identity)
    const line = `DESKTOP_PROCESS_IDENTITY ${JSON.stringify(identity)}`

    expect(processIdentities({ stdout: `${line}\n${line}`, stderr: '' })).toEqual([identity])
    expect(liveProcessIdentities([identity])).toEqual([identity])

    terminateProcessIdentities([identity])

    expect(liveProcessIdentities([identity])).toEqual([])
    children.delete(child.pid)
  })
})
