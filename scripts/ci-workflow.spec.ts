import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = '${{ runner.temp }}/setup-pnpm'

describe('CI workflow', () => {
  it('isolates every pnpm action setup destination per runner', () => {
    const workflow: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError('CI workflow must define jobs')

    const setups = Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
      if (!isRecord(job) || !Array.isArray(job.steps)) return []
      return job.steps.flatMap((step) => {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) return []
        return [{ jobName, step }]
      })
    })

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      expect(step, `${jobName} must not share pnpm/action-setup's default destination`).toMatchObject({
        with: { dest: runnerPrivatePnpmDestination },
      })
    }
  })

  it('keeps pull requests fast and reserves exhaustive platform checks for release tags', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)
      || !isRecord(workflow.jobs['pr-node'])
      || !isRecord(workflow.jobs['pr-python-sdk'])
      || !isRecord(workflow.jobs['pr-checks-passed'])
      || !isRecord(workflow.jobs['tag-static'])
      || !isRecord(workflow.jobs['tag-coverage'])
      || !isRecord(workflow.jobs['tag-snapshots'])
      || !isRecord(workflow.jobs['tag-artifacts'])
      || !isRecord(workflow.jobs['tag-node-compat'])
      || !isRecord(workflow.jobs['tag-python-sdk'])
      || !isRecord(workflow.jobs['tag-python-runtime'])
      || !isRecord(workflow.jobs['tag-windows-native'])
      || !isRecord(workflow.jobs['tag-checks-passed'])) {
      throw new TypeError('CI workflow must define the PR essentials and exhaustive tag jobs')
    }

    const prNode = workflow.jobs['pr-node']
    const prPython = workflow.jobs['pr-python-sdk']
    const prAggregate = workflow.jobs['pr-checks-passed']
    const tagStatic = workflow.jobs['tag-static']
    const tagCoverage = workflow.jobs['tag-coverage']
    const tagSnapshots = workflow.jobs['tag-snapshots']
    const tagArtifacts = workflow.jobs['tag-artifacts']
    const tagCompat = workflow.jobs['tag-node-compat']
    const tagPython = workflow.jobs['tag-python-sdk']
    const tagRuntime = workflow.jobs['tag-python-runtime']
    const tagWindows = workflow.jobs['tag-windows-native']
    const tagAggregate = workflow.jobs['tag-checks-passed']
    if (!Array.isArray(prNode.steps)
      || !Array.isArray(prPython.steps)
      || !Array.isArray(prAggregate.needs)
      || !Array.isArray(tagSnapshots.steps)
      || !Array.isArray(tagAggregate.needs)) {
      throw new TypeError('CI jobs must define their steps and aggregate dependencies')
    }

    const prCommands = prNode.steps.filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(prCommands.map(step => step.run)).toContain('pnpm run check:ci:pr')
    expect(prCommands.map(step => step.run)).not.toContain('pnpm run check:ci:coverage')
    expect(prNode.if).toBe("github.event_name == 'pull_request'")
    expect(prPython.if).toBe("github.event_name == 'pull_request'")
    expect(prAggregate.needs).toEqual(['pr-node', 'pr-python-sdk'])

<<<<<<< HEAD
    const tagOnly = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
    for (const job of [tagStatic, tagCoverage, tagSnapshots, tagArtifacts, tagCompat, tagPython, tagRuntime, tagWindows]) {
      expect(job.if).toBe(tagOnly)
=======
    // Required PR job: Wine on ubuntu-latest, runs wine-windows-gates.sh.
    expect(windows['runs-on']).toBe('ubuntu-latest')
    expect(windows.name).toBe('windows node 24 / wine blocking')
    expect(windows.if).toBe("github.event_name == 'pull_request'")
    expect(commandSteps.some(step => step.run.includes('wine-windows-gates.sh'))).toBe(true)

    // windows-native: non-blocking native job with failover, runs windows-complete.
    // Its pool is resolved by the Windows-specific switch.
    expect(typeof windowsNative['runs-on']).toBe('string')
    expect(windowsNative['runs-on']).toContain('DSH_CI_FAILOVER_WINDOWS')
    expect(windowsNative['runs-on']).not.toContain('DSH_CI_FAILOVER_LINUX')
    expect(windowsNative['runs-on']).toContain('self-hosted')
    expect(windowsNative['runs-on']).toContain('dsh-win-ci')
    expect(windowsNative['runs-on']).toContain('dsh-windows-2025-16core')
    expect(windowsNative.name).toBe('windows node 24 / native complete')
    expect(windowsNative.if).toBe("github.event_name == 'pull_request'")
    expect(windowsNative.env).toMatchObject({
      DSH_COVERAGE_TEST_TIMEOUT_MS: '30000',
    })
    const nativeCommandSteps = (windowsNative.steps as unknown[]).filter((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
    ))
    expect(nativeCommandSteps.map(step => step.run)).toContain('pnpm run check:ci:windows-complete')

    // wine-apt-cache: master-only, seeds the Wine apt cache.
    expect(wineAptCache.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(wineAptCache['runs-on']).toBe('ubuntu-latest')

    // serial-windows: master-only standby, self-hosted, non-blocking.
    expect(serialWindows.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/master'")
    expect(serialWindows['runs-on']).toEqual(['self-hosted', 'dsh-win-ci', 'windows'])
    expect(serialWindows.name).toBe('serial / windows (self-hosted standby)')

    // Aggregate: Wine `windows` required, native `windows-native` excluded.
    expect(aggregate.needs).toContain('windows')
    expect(aggregate.needs).not.toContain('windows-native')
    expect(aggregate.needs).not.toContain('serial-windows')

    // Linux failover is a separate switch: the three required Linux workers
    // and the verdict job resolve their pool through DSH_CI_FAILOVER_LINUX,
    // never the Windows switch.
    for (const [jobName, job] of [['node-24', node24], ['node-24-coverage', node24Coverage], ['node-24-consumers', node24Consumers]] as const) {
      expect(typeof job['runs-on']).toBe('string')
      expect(job['runs-on'], `${jobName} runs-on must use the Linux failover switch`).toContain('DSH_CI_FAILOVER_LINUX')
      expect(job['runs-on'], `${jobName} runs-on must not use the Windows failover switch`).not.toContain('DSH_CI_FAILOVER_WINDOWS')
      expect(job['runs-on']).toContain('vm-backup')
>>>>>>> upstream/master
    }
    expect(tagRuntime).toMatchObject({
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64',
        release: true,
      },
    })
    expect(tagSnapshots['timeout-minutes']).toBe(30)
    const tagSteps = tagSnapshots.steps as unknown[]
    const playwright = tagSteps.find((step): step is Record<string, unknown> => isRecord(step) && step.name === 'Install Playwright Chromium')
    expect(playwright).toMatchObject({ 'timeout-minutes': 10 })
    expect(tagAggregate.needs).toEqual([
      'tag-static',
      'tag-coverage',
      'tag-snapshots',
      'tag-artifacts',
      'tag-node-compat',
      'tag-python-sdk',
      'tag-python-runtime',
      'tag-windows-native',
    ])

    expect(workflow.jobs).not.toHaveProperty('windows')
    expect(workflow.jobs).not.toHaveProperty('wine-apt-cache')
  })

  it('cancels superseded runs on the same ref', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.concurrency)) {
      throw new TypeError('CI workflow must define jobs and a workflow-level concurrency block')
    }

    expect(workflow.concurrency['cancel-in-progress']).toBe(true)
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('requires the complete release-shaped Python runtime matrix on release tags', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const pythonRuntime = workflowJob(workflow, 'tag-python-runtime')
    const aggregate = workflowJob(workflow, 'tag-checks-passed')
    if (!Array.isArray(aggregate.needs)) {
      throw new TypeError('CI aggregate must define required job dependencies')
    }

    expect(pythonRuntime).toMatchObject({
      if: "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
      name: 'tag / release-shaped Python runtimes',
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64',
        release: true,
      },
    })
    expect(aggregate.needs).toContain('tag-python-runtime')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('Desktop release workflow', () => {
  it('builds both architectures on v* tags only, without pull-request cost', () => {
    const workflow = loadWorkflow('.github/workflows/desktop-release.yml')
    expect(workflow.on).toEqual({ push: { tags: ['v*'] } })
    const job = workflowJob(workflow, 'desktop-artifacts')
    if (!isRecord(job.strategy) || !isRecord(job.strategy.matrix) || !Array.isArray(job.strategy.matrix.include)) {
      throw new TypeError('Desktop release workflow must define an include matrix')
    }
    expect(job.strategy.matrix.include).toEqual([
      { runner: 'macos-26-intel', arch: 'x64' },
      { runner: 'macos-26', arch: 'arm64' },
    ])
    expect(job['timeout-minutes']).toBe(60)
    if (!Array.isArray(job.steps)) throw new TypeError('Desktop release workflow must define steps')
    const steps = job.steps.filter(isRecord)
    const pnpmSetup = steps.find(step => typeof step.uses === 'string' && step.uses.startsWith('pnpm/action-setup@'))
    expect(pnpmSetup).toMatchObject({ with: { dest: runnerPrivatePnpmDestination } })
    const runs = steps.filter((step): step is Record<string, unknown> & { run: string } => typeof step.run === 'string')
    expect(runs.map(step => step.run)).toContain('pnpm --filter @deepseek-ai/dsh-desktop run package:skip-build')
    expect(runs.map(step => step.run)).toContain('pnpm exec vitest run --config vitest.e2e.config.ts apps/desktop/tests/packaged-smoke.e2e.ts')
    // The mount-launch evidence the release criteria require: the artifact
    // mounted from the produced dmg must verify and pass the keyless
    // scenario. Only that scenario runs from the image — first-paint timing
    // assertions flake off a read-only HFS mount — and the mount is always
    // detached.
    const mountSmoke = steps.find(step => step.name === 'Mount the dmg and run the keyless packaged-app smoke')
    if (!mountSmoke || typeof mountSmoke.run !== 'string') {
      throw new TypeError('Desktop release workflow must mount the dmg before the smoke')
    }
    expect(mountSmoke.run).toContain('hdiutil attach -nobrowse -readonly "$dmg"')
    expect(mountSmoke.run).toContain('codesign --verify --deep --strict "$mount/DSH Desktop.app"')
    expect(mountSmoke.run).toContain('DSH_DESKTOP_APP_DIR="$mount/DSH Desktop.app"')
    expect(mountSmoke.run).toContain("-t 'runs the keyless interaction-parity scenario'")
    const detach = steps.find(step => step.name === 'Detach the dmg')
    expect(detach).toMatchObject({ if: 'always()' })
    const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4')
    expect(upload).toMatchObject({
      with: {
        name: 'dsh-desktop-${{ matrix.arch }}-dmg',
        path: 'apps/desktop/dist/*.dmg',
        'if-no-files-found': 'error',
      },
    })
    // upload-artifact must hold the actions scope: the restrictive
    // permissions block resets every unspecified scope to none.
    expect(workflow.permissions).toMatchObject({ contents: 'read', actions: 'write' })
    // The PR lane already smokes one arm64 runner; this matrix doubles
    // macOS runner minutes on a private repository, so it must stay off
    // pull requests and branch pushes entirely.
    expect(JSON.stringify(workflow.on)).not.toContain('pull_request')
  })
})
describe('Python runtime build workflows', () => {
  it('exposes the native wheel builder to the release caller with normalized versions', () => {
    const workflow = loadWorkflow('.github/workflows/build-exe-for-python-sdk.yml')
    const call = workflowEvent(workflow, 'workflow_call')
    const plan = workflowJob(workflow, 'plan')
    const build = workflowJob(workflow, 'build')
    if (!isRecord(call.inputs) || !Array.isArray(plan.steps) || !Array.isArray(build.steps)) {
      throw new TypeError('Python wheel builder must define workflow_call inputs and plan steps')
    }

    const buildSteps = build.steps.filter(isRecord)
    const manylinuxAddon = buildSteps.find(step => isRecord(step) && step.name === 'Rebuild Linux node-pty against manylinux 2.28')
    const macosCheck = buildSteps.find(step => isRecord(step) && step.name === 'Check macOS deployment target')
    const manylinuxSmoke = buildSteps.find(step => isRecord(step) && step.name === 'Run wheel in a manylinux 2.28 container')
    expect(call.inputs).toHaveProperty('targets')
    expect(call.inputs).toMatchObject({
      release: { type: 'boolean', default: false },
    })
    expect(call.inputs).not.toHaveProperty('ci')
    expect(workflow.concurrency).toMatchObject({
      group: 'build-single-exe-${{ github.workflow }}-${{ github.ref }}',
    })
    expect(plan.if).toBeUndefined()
    expect(JSON.stringify(plan.steps)).toContain('pep440_version')
    expect(JSON.stringify(workflow)).toContain('macosx_14_0_arm64')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
<<<<<<< HEAD
    if (!manylinuxAddon || typeof manylinuxAddon.run !== 'string') {
      throw new TypeError('manylinux node-pty rebuild must define a shell command')
    }
    const addonDirectory = manylinuxAddon.run.indexOf('addon_dir="$(realpath packages/subprocess/subprocess-local/node_modules/node-pty)"')
    const cleanBuild = manylinuxAddon.run.indexOf('rm -rf "$addon_dir/build"')
    const nodeGypResolve = manylinuxAddon.run.indexOf("rebuild.resolve('node-gyp/bin/node-gyp.js')")
    const rebuild = manylinuxAddon.run.indexOf('node "$node_gyp" rebuild')
    expect(addonDirectory).toBeGreaterThanOrEqual(0)
    expect(cleanBuild).toBeGreaterThan(addonDirectory)
    expect(nodeGypResolve).toBeGreaterThan(cleanBuild)
    expect(rebuild).toBeGreaterThan(nodeGypResolve)
    expect(manylinuxAddon.run).not.toContain('pnpm rebuild node-pty')
=======
    expect(JSON.stringify(manylinuxAddon)).toContain('npm_config_build_from_source=true pnpm run install')
>>>>>>> upstream/master
    expect(JSON.stringify(manylinuxAddon)).toContain('$HOME/setup-pnpm:$HOME/setup-pnpm:ro')
    expect(JSON.stringify(manylinuxAddon)).toContain('node-pty-glibc-versions.txt')
    expect(JSON.stringify(manylinuxAddon)).toContain('le 2.28')
    expect(macosCheck).toMatchObject({ if: "runner.os == 'macOS'" })
    expect(JSON.stringify(macosCheck)).toContain('scripts/check-macos-deployment-target.py')
    expect(JSON.stringify(macosCheck)).toContain('$EXE-spawn-helper')
    expect(manylinuxSmoke).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxSmoke)).toContain('-e DSH_TELEMETRY_DISABLED')
  })

  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('PLATFORM" = macos-arm64'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('"$EXE" "$EXE-spawn-helper"')
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowEvent(workflow: Record<string, unknown>, event: string): Record<string, unknown> {
  if (!isRecord(workflow.on) || !isRecord(workflow.on[event])) {
    throw new TypeError(`workflow must define the ${event} event`)
  }
  return workflow.on[event]
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
