import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PACKAGED_CHILD_EXEC_ARGV,
  packagedChildEnv,
  packagedRuntimeLayout,
  parseSidebarGlassAcceptanceInvocation,
  parseSmokeInvocation,
  parseSmokeReopenInvocation,
  RUNTIME_SUBDIR,
} from '../src/packaged-runtime.ts'

describe('packaged runtime layout', () => {
  const resources = resolve('Contents', 'Resources')
  const userData = resolve('Application Support', 'DSH Desktop')

  it('resolves every runtime artifact under the resources runtime subdirectory', () => {
    const layout = packagedRuntimeLayout(resources, userData)
    const root = join(resources, RUNTIME_SUBDIR, 'node_modules')
    expect(layout.cliEntry).toBe(join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    expect(layout.webDist).toBe(join(root, '@deepseek-ai', 'dsh-web-frontend', 'dist'))
    expect(layout.ptySpawnHelper).toBe(join(root, 'node-pty', 'build', 'Release', 'spawn-helper'))
    expect(layout.replayProvider).toBe(join(root, '@deepseek-ai', 'dsh-llm-replay'))
    expect(layout.cliEntry.startsWith(resources + sep)).toBe(true)
    expect(layout.ptySpawnHelper.includes('app.asar')).toBe(false)
  })

  it('uses the real user-data directory as the child working directory', () => {
    const layout = packagedRuntimeLayout(resources, userData)
    expect(layout.childCwd).toBe(userData)
    expect(layout.childCwd.includes('app.asar')).toBe(false)
  })
})

describe('packaged child environment', () => {
  it('runs the application binary as Node without touching the inherited environment', () => {
    const env = { DEEPSEEK_API_KEY: 'k', DSH_HOME: '/tmp/home' }
    const childEnv = packagedChildEnv(env, '/p/spawn-helper')
    expect(childEnv).not.toBe(env)
    expect(env).toEqual({ DEEPSEEK_API_KEY: 'k', DSH_HOME: '/tmp/home' })
    expect(childEnv['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(childEnv['DSH_NODE_PTY_SPAWN_HELPER']).toBe('/p/spawn-helper')
    expect(childEnv['DEEPSEEK_API_KEY']).toBe('k')
  })

  it('overrides stale helper and run-as-node values from the parent', () => {
    const childEnv = packagedChildEnv({ ELECTRON_RUN_AS_NODE: '0', DSH_NODE_PTY_SPAWN_HELPER: '/old' }, '/new')
    expect(childEnv['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(childEnv['DSH_NODE_PTY_SPAWN_HELPER']).toBe('/new')
  })

  it('exposes Node internals so the config-hot-reload watcher can load the internal ESM loader', () => {
    expect(PACKAGED_CHILD_EXEC_ARGV).toEqual(['--expose-internals'])
  })
})

describe('smoke invocation parsing', () => {
  it('ignores ordinary application launches', () => {
    expect(parseSmokeInvocation(['/bin/app'])).toBeUndefined()
    expect(parseSmokeInvocation(['/bin/app', '--smoke-replay', '/f.jsonl'])).toBeUndefined()
  })

  it('parses the smoke flag with its replay file and child replays', () => {
    expect(parseSmokeInvocation(['/bin/app', '--smoke', '--smoke-replay', '/f.jsonl']))
      .toEqual({ replayFile: '/f.jsonl', childReplays: [] })
    expect(parseSmokeInvocation([
      '/bin/app', '--smoke', '--smoke-replay', '/f.jsonl',
      '--smoke-child-replay', '/q.jsonl', '--smoke-child-replay', '/a.jsonl',
    ])).toEqual({ replayFile: '/f.jsonl', childReplays: ['/q.jsonl', '/a.jsonl'] })
  })

  it('rejects a replay flag without a following path', () => {
    expect(parseSmokeInvocation(['/bin/app', '--smoke', '--smoke-replay']))
      .toEqual({ childReplays: [] })
    expect(parseSmokeInvocation(['/bin/app', '--smoke', '--smoke-replay', '--other']))
      .toEqual({ childReplays: [] })
  })
})

describe('smoke reopen invocation parsing', () => {
  it('ignores ordinary application launches', () => {
    expect(parseSmokeReopenInvocation(['/bin/app'])).toBeUndefined()
    expect(parseSmokeReopenInvocation(['/bin/app', '--smoke-home', '/tmp/home'])).toBeUndefined()
  })

  it('parses the reopen flag with its home', () => {
    expect(parseSmokeReopenInvocation(['/bin/app', '--smoke-reopen', '--smoke-home', '/tmp/home']))
      .toEqual({ home: '/tmp/home' })
  })

  it('reports the reopen flag without a usable home so the boot path can fail loudly', () => {
    expect(parseSmokeReopenInvocation(['/bin/app', '--smoke-reopen'])).toEqual({ home: undefined })
    expect(parseSmokeReopenInvocation(['/bin/app', '--smoke-reopen', '--smoke-home'])).toEqual({ home: undefined })
  })
})

describe('sidebar glass acceptance invocation parsing', () => {
  it('ignores ordinary application launches', () => {
    expect(parseSidebarGlassAcceptanceInvocation(['/bin/app'])).toBeUndefined()
    expect(parseSidebarGlassAcceptanceInvocation(['/bin/app', '--sidebar-glass-phase', 'default-off']))
      .toBeUndefined()
  })

  it.each(['default-off', 'reopen-on', 'reopen-enabled'] as const)(
    'parses the %s phase',
    (phase) => {
      expect(parseSidebarGlassAcceptanceInvocation([
        '/bin/app', '--accept-sidebar-glass', '--sidebar-glass-phase', phase,
      ])).toEqual({ phase })
    },
  )

  it('reports an unusable phase so the boot path can fail loudly', () => {
    expect(parseSidebarGlassAcceptanceInvocation(['/bin/app', '--accept-sidebar-glass']))
      .toEqual({ phase: undefined })
    expect(parseSidebarGlassAcceptanceInvocation([
      '/bin/app', '--accept-sidebar-glass', '--sidebar-glass-phase', 'unknown',
    ])).toEqual({ phase: undefined })
  })
})
