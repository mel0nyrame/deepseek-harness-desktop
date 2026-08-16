import { describe, expect, it, vi } from 'vitest'
import { createNativeActionHandler } from '../src/native-actions.ts'

describe('desktop native action handler', () => {
  it('selects one directory and opens one available absolute path', async () => {
    const reportFailure = vi.fn(async () => {})
    const handler = createNativeActionHandler({
      pickDirectory: vi.fn(async () => '/workspace/alpha'),
      pathAvailable: vi.fn(async () => true),
      openPath: vi.fn(async () => ''),
      reportFailure,
    })

    await expect(handler({ type: 'pick-directory' }, new AbortController().signal)).resolves.toEqual({
      ok: true, value: { type: 'pick-directory', path: '/workspace/alpha' },
    })
    await expect(handler({ type: 'open-path', path: '/workspace/alpha/readme.md' }, new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { type: 'open-path', opened: true } })
    expect(reportFailure).not.toHaveBeenCalled()
  })

  it.each([
    ['relative path', 'notes/readme.md', 'invalid-path'],
    ['missing target', '/missing/readme.md', 'unavailable'],
  ] as const)('rejects a %s actionably', async (_label, path, code) => {
    const reportFailure = vi.fn(async () => {})
    const handler = createNativeActionHandler({
      pickDirectory: vi.fn(async () => null),
      pathAvailable: vi.fn(async () => false),
      openPath: vi.fn(async () => ''),
      reportFailure,
    })

    await expect(handler({ type: 'open-path', path }, new AbortController().signal)).resolves.toMatchObject({
      ok: false, error: { code },
    })
    expect(reportFailure).toHaveBeenCalledOnce()
  })

  it('reports the operating-system failure text and contains reporting failures', async () => {
    const reportFailure = vi.fn(async () => { throw new Error('window closing') })
    const handler = createNativeActionHandler({
      pickDirectory: vi.fn(async () => null),
      pathAvailable: vi.fn(async () => true),
      openPath: vi.fn(async () => 'no application is registered'),
      reportFailure,
    })

    await expect(handler({ type: 'open-path', path: '/workspace/data.xyz' }, new AbortController().signal))
      .resolves.toEqual({
        ok: false,
        error: { code: 'failed', message: 'no application is registered' },
      })
    expect(reportFailure).toHaveBeenCalledWith('/workspace/data.xyz', 'no application is registered')
  })

  it('settles cancellation without waiting for an uncloseable native dialog', async () => {
    const chooser = Promise.withResolvers<string | null>()
    const handler = createNativeActionHandler({
      pickDirectory: () => chooser.promise,
      pathAvailable: vi.fn(async () => true),
      openPath: vi.fn(async () => ''),
      reportFailure: vi.fn(async () => {}),
    })
    const abort = new AbortController()
    const pending = handler({ type: 'pick-directory' }, abort.signal)

    abort.abort()

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    chooser.resolve('/late')
  })

  it('does not start a path handoff after cancellation wins the availability race', async () => {
    const availability = Promise.withResolvers<boolean>()
    const openPath = vi.fn(async () => '')
    const handler = createNativeActionHandler({
      pickDirectory: vi.fn(async () => null),
      pathAvailable: () => availability.promise,
      openPath,
      reportFailure: vi.fn(async () => {}),
    })
    const abort = new AbortController()
    const pending = handler({ type: 'open-path', path: '/workspace/a.txt' }, abort.signal)

    availability.resolve(true)
    queueMicrotask(() => { abort.abort() })

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(openPath).not.toHaveBeenCalled()
  })
})
