import { describe, expect, it } from 'vitest'
import { agentCheckPlan, parseAgentCheckArguments } from '../scripts/agent-check.js'

describe('agent check runner', () => {
  it('serializes workspace and installed-product verification by default', () => {
    const options = parseAgentCheckArguments([])
    expect(options.preset).toBe('all')
    expect(agentCheckPlan(options)).toEqual([
      { label: 'workspace', command: 'pnpm', args: ['run', 'check'], isolatePackageOutput: true },
      { label: 'package', command: 'pnpm', args: ['run', 'package'] },
      { label: 'installed product', command: 'pnpm', args: ['run', 'test:package'] },
      { label: 'diff', command: 'git', args: ['diff', '--check'] },
    ])
  })

  it('builds before a focused test and forwards its name filter', () => {
    const options = parseAgentCheckArguments([
      'focused', '--test', 'tests/desktop-native-window.test.ts', '--name', 'wide resize',
    ])
    expect(agentCheckPlan(options)).toEqual([
      { label: 'build', command: 'pnpm', args: ['run', 'build'] },
      {
        label: 'focused tests',
        command: 'pnpm',
        args: [
          'exec', 'vitest', 'run', 'tests/desktop-native-window.test.ts', '-t', 'wide resize',
        ],
      },
      { label: 'diff', command: 'git', args: ['diff', '--check'] },
    ])
  })

  it('rejects incomplete or misplaced focused-test options', () => {
    expect(() => parseAgentCheckArguments(['focused'])).toThrow('requires at least one --test')
    expect(() => parseAgentCheckArguments(['quick', '--test', 'tests/example.test.ts']))
      .toThrow('--test and --name require the focused preset')
  })
})
