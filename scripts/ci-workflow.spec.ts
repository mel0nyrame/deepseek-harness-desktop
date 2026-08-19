import { existsSync, readFileSync } from 'node:fs'
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
    expect(workflow.on).toEqual({ pull_request: null, push: { tags: ['v*'] } })
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

    const tagOnly = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
    for (const job of [tagStatic, tagCoverage, tagSnapshots, tagArtifacts, tagCompat, tagPython, tagRuntime, tagWindows]) {
      expect(job.if).toBe(tagOnly)
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
  it('starts only after successful exhaustive CI for a pushed v* tag', () => {
    const workflow = loadWorkflow('.github/workflows/release.yml')
    expect(workflow.on).toEqual({ workflow_run: { workflows: ['CI'], types: ['completed'] } })
    expect(workflow.permissions).toEqual({ actions: 'write', contents: 'write' })
    expect(workflow.concurrency).toEqual({
      group: 'desktop-release-${{ github.event.workflow_run.head_branch }}',
      'cancel-in-progress': false,
    })

    const resolveJob = workflowJob(workflow, 'resolve')
    expect(resolveJob.if).toBe("github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && startsWith(github.event.workflow_run.head_branch, 'v')")
    expect(resolveJob.outputs).toEqual({
      tag: '${{ steps.release.outputs.tag }}',
      version: '${{ steps.release.outputs.version }}',
      prerelease: '${{ steps.release.outputs.prerelease }}',
      sha: '${{ steps.release.outputs.sha }}',
    })
    if (!Array.isArray(resolveJob.steps)) throw new TypeError('release resolve job must define steps')
    const resolveSteps = resolveJob.steps.filter(isRecord)
    expect(resolveSteps.find(step => step.uses === 'actions/checkout@v6')).toMatchObject({
      with: { ref: '${{ github.event.workflow_run.head_branch }}', 'persist-credentials': false },
    })
    const releaseStep = resolveSteps.find(step => step.id === 'release')
    expect(releaseStep).toMatchObject({
      env: {
        TAG: '${{ github.event.workflow_run.head_branch }}',
        HEAD_SHA: '${{ github.event.workflow_run.head_sha }}',
      },
    })
    expect(JSON.stringify(releaseStep)).toContain('GITHUB_OUTPUT')
    expect(JSON.stringify(releaseStep)).toContain('prerelease')
    expect(JSON.stringify(releaseStep)).toContain('semver')
    expect(JSON.stringify(releaseStep)).toContain('sha=$HEAD_SHA')
  })

  it('reads exact-version highlights and builds verified release assets for both architectures', () => {
    const workflow = loadWorkflow('.github/workflows/release.yml')
    const notes = workflowJob(workflow, 'notes')
    const dmg = workflowJob(workflow, 'dmg')
    expect(notes.needs).toBe('resolve')
    expect(dmg.needs).toEqual(['resolve', 'notes'])
    if (!Array.isArray(notes.steps) || !Array.isArray(dmg.steps)
      || !isRecord(dmg.strategy) || !isRecord(dmg.strategy.matrix) || !Array.isArray(dmg.strategy.matrix.include)) {
      throw new TypeError('release notes and dmg jobs must define steps and a dmg matrix')
    }

    const notesSteps = notes.steps.filter(isRecord)
    expect(notesSteps.find(step => step.uses === 'actions/checkout@v6')).toMatchObject({
      with: { ref: '${{ needs.resolve.outputs.tag }}', 'fetch-depth': 0, 'persist-credentials': false },
    })
    expect(notesSteps.find(step => step.name === 'Verify the CI-tested release commit')).toMatchObject({
      env: { EXPECTED_SHA: '${{ needs.resolve.outputs.sha }}' },
    })
    expect(JSON.stringify(notesSteps)).toContain('.github/release-notes/${version}.md')
    expect(JSON.stringify(notesSteps)).toContain('::error::')

    expect(dmg.strategy.matrix.include).toEqual([
      { runner: 'macos-26-intel', arch: 'x64' },
      { runner: 'macos-26', arch: 'arm64' },
    ])
    expect(dmg['timeout-minutes']).toBe(60)
    const dmgSteps = dmg.steps.filter(isRecord)
    expect(dmgSteps.find(step => step.uses === 'actions/checkout@v6')).toMatchObject({
      with: { ref: '${{ needs.resolve.outputs.tag }}', 'fetch-depth': 0, 'persist-credentials': false },
    })
    expect(dmgSteps.find(step => step.name === 'Verify the CI-tested release commit')).toMatchObject({
      env: { EXPECTED_SHA: '${{ needs.resolve.outputs.sha }}' },
    })
    const runs = dmgSteps.filter((step): step is Record<string, unknown> & { run: string } => typeof step.run === 'string')
    expect(runs.map(step => step.run)).toContain('pnpm --filter @deepseek-ai/dsh-desktop run package:skip-build')
    expect(runs.map(step => step.run)).toContain('pnpm exec vitest run --config vitest.e2e.config.ts apps/desktop/tests/packaged-smoke.e2e.ts')
    const mountSmoke = dmgSteps.find(step => step.name === 'Mount the dmg and run the keyless packaged-app smoke')
    if (!mountSmoke || typeof mountSmoke.run !== 'string') {
      throw new TypeError('release dmg job must mount the dmg before the smoke')
    }
    expect(mountSmoke.run).toContain('hdiutil attach -nobrowse -readonly "$dmg"')
    expect(mountSmoke.run).toContain('codesign --verify --deep --strict "$mount/DSH Desktop.app"')
    expect(mountSmoke.run).toContain('DSH_DESKTOP_APP_DIR="$mount/DSH Desktop.app"')
    expect(dmgSteps.find(step => step.name === 'Detach the dmg')).toMatchObject({ if: 'always()' })
    const prepare = dmgSteps.find(step => step.name === 'Prepare release assets')
    if (!prepare || typeof prepare.run !== 'string') {
      throw new TypeError('release dmg job must prepare checksummed assets')
    }
    expect(prepare.run).toContain('DSH.Desktop-${version}-${{ matrix.arch }}.dmg')
    expect(prepare.run).toContain('shasum -a 256')
    expect(dmgSteps.find(step => step.uses === 'actions/upload-artifact@v4')).toMatchObject({
      with: {
        name: 'dsh-desktop-${{ matrix.arch }}-release',
        path: 'release-assets/*',
        'if-no-files-found': 'error',
      },
    })
  })

  it('updates one release with exactly four assets, then bumps Homebrew only for stable versions', () => {
    const workflow = loadWorkflow('.github/workflows/release.yml')
    const release = workflowJob(workflow, 'release')
    const homebrew = workflowJob(workflow, 'homebrew')
    expect(release.needs).toEqual(['resolve', 'notes', 'dmg'])
    if (!Array.isArray(release.steps) || !Array.isArray(homebrew.steps)) {
      throw new TypeError('release and Homebrew jobs must define steps')
    }
    const releaseSteps = release.steps.filter(isRecord)
    expect(releaseSteps.find(step => step.uses === 'actions/checkout@v6')).toMatchObject({
      with: { ref: '${{ needs.resolve.outputs.tag }}', 'fetch-depth': 0, 'persist-credentials': false },
    })
    expect(releaseSteps.find(step => step.name === 'Verify the CI-tested release commit')).toMatchObject({
      env: { EXPECTED_SHA: '${{ needs.resolve.outputs.sha }}' },
    })
    const publish = releaseSteps.find(step => step.name === 'Create or update the GitHub Release')
    expect(publish).toMatchObject({ env: { GH_REPO: '${{ github.repository }}' } })
    expect(JSON.stringify(publish)).toContain('DSH Desktop v${version}')
    expect(JSON.stringify(publish)).toContain('generate-notes')
    expect(JSON.stringify(publish)).toContain('prerelease')
    expect(JSON.stringify(publish)).toContain('gh release edit')
    expect(JSON.stringify(publish)).toContain('gh release create')
    expect(JSON.stringify(publish)).toContain('gh release upload')
    expect(JSON.stringify(publish)).toContain("--jq '.assets[].id'")
    expect(JSON.stringify(publish)).toContain('releases/assets/$asset_id')
    expect(JSON.stringify(publish)).toContain('git/ref/tags/$tag')
    expect(JSON.stringify(publish)).toContain('git/tags/$object_sha')
    expect(JSON.stringify(publish)).toContain('HEAD_SHA')
    for (const asset of [
      'DSH.Desktop-${version}-arm64.dmg',
      'DSH.Desktop-${version}-arm64.dmg.sha256',
      'DSH.Desktop-${version}-x64.dmg',
      'DSH.Desktop-${version}-x64.dmg.sha256',
    ]) expect(JSON.stringify(publish)).toContain(asset)

    expect(homebrew.needs).toEqual(['resolve', 'release'])
    expect(homebrew.if).toBe("needs.resolve.outputs.prerelease == 'false'")
    const brewSteps = homebrew.steps.filter(isRecord)
    expect(JSON.stringify(brewSteps)).toContain('Homebrew tap mel0nyrame/homebrew-dsh is unavailable')
    expect(brewSteps.find(step => step.uses === 'actions/checkout@v6')).toMatchObject({
      with: {
        repository: 'mel0nyrame/homebrew-dsh',
        ref: 'main',
        path: 'homebrew-dsh',
        'ssh-key': '${{ secrets.DSH_TAP_DEPLOY_KEY }}',
      },
    })
    const updateCask = brewSteps.find(step => step.name === 'Update and push the stable cask')
    if (!updateCask || typeof updateCask.run !== 'string') {
      throw new TypeError('Homebrew job must update and push the stable cask')
    }
    expect(updateCask).toMatchObject({
      env: {
        TAG: '${{ needs.resolve.outputs.tag }}',
        HEAD_SHA: '${{ needs.resolve.outputs.sha }}',
      },
    })
    expect(updateCask.run).toContain('ruby scripts/update-cask.rb "$version"')
    expect(updateCask.run).toContain('git/ref/tags/$TAG')
    expect(updateCask.run).toContain('git push origin HEAD:main')
    expect(existsSync(resolve(root, '.github/workflows/desktop-release.yml'))).toBe(false)
  })
})
<<<<<<< HEAD
describe('Python runtime build workflows', () => {
=======

describe('DeepSeek e2e workflow', () => {
  it('prepares bubblewrap from the pinned payload without a package transaction', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const steps = e2e.steps.filter(isRecord)
    expect(steps.find(step => step.name === 'Prepare bubblewrap (unrestrict userns)')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(JSON.stringify(steps)).not.toContain('apt-get')
  })
})

describe('Python release workflows', () => {
  it('keeps complete wheel validation separate from protected public publication', () => {
    const workflow = loadWorkflow('.github/workflows/python-release.yml')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const build = workflowJob(workflow, 'build')
    const pythonCompat = workflowJob(workflow, 'python-compat')
    const validate = workflowJob(workflow, 'validate')
    const publishRuntime = workflowJob(workflow, 'publish-runtime')
    const publishSdk = workflowJob(workflow, 'publish-sdk')
    if (!isRecord(dispatch.inputs)
      || !isRecord(dispatch.inputs.publish)
      || !Array.isArray(pythonCompat.steps)
      || !Array.isArray(validate.steps)
      || !Array.isArray(publishRuntime.steps)
      || !Array.isArray(publishSdk.steps)) {
      throw new TypeError('Python release workflow must define publish input and release steps')
    }

    expect(dispatch.inputs.publish).toMatchObject({ type: 'boolean', default: false })
    expect(pullRequest).toEqual({ types: ['labeled'] })
    expect(build).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' || github.event.label.name == 'python-release-dry-run'",
      uses: './.github/workflows/build-exe-for-python-sdk.yml',
      with: {
        targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64',
        release: true,
      },
    })
    expect(pythonCompat.strategy).toMatchObject({ matrix: { python: ['3.10', '3.14'] } })
    const pythonCompatSteps = JSON.stringify(pythonCompat.steps)
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_sdk-$VERSION-py3-none-any.whl')
    expect(pythonCompatSteps).toContain('dist/deepseek_harness_runtime_bin-$VERSION-py3-none-manylinux_2_28_x86_64.whl')
    expect(pythonCompatSteps).not.toContain('--find-links')
    const validateSteps = JSON.stringify(validate.steps)
    const authorize = validate.steps.filter(isRecord).find(step => step.name === 'Authorize publication request')
    if (!isRecord(authorize) || typeof authorize.run !== 'string') {
      throw new TypeError('Python release validation must authorize publication requests')
    }
    expect(validateSteps).toContain('PUBLIC_PYPI_RELEASE_ENABLED')
    expect(authorize).toMatchObject({
      env: {
        PYPI_PUBLISHER_REPOSITORY: '${{ vars.PYPI_PUBLISHER_REPOSITORY }}',
        REPOSITORY: '${{ github.repository }}',
      },
    })
    expect(authorize.run).toContain('[ "$REPOSITORY" = "$PYPI_PUBLISHER_REPOSITORY" ]')
    expect(validateSteps).toContain('100000000')
    expect(publishRuntime).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: 'validate',
      environment: 'pypi-runtime',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    expect(publishSdk).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.publish",
      needs: ['validate', 'publish-runtime'],
      environment: 'pypi',
      permissions: { contents: 'read', 'id-token': 'write' },
    })
    const runtimeSteps = publishRuntime.steps.filter(isRecord)
    const sdkSteps = publishSdk.steps.filter(isRecord)
    const runtimePublish = runtimeSteps.find(step => step.name === 'Publish runtime wheels')
    const sdkPublish = sdkSteps.find(step => step.name === 'Publish SDK wheel')
    const runtimeHashes = runtimeSteps.find(step => step.name === 'Verify release artifact hashes')
    const sdkHashes = sdkSteps.find(step => step.name === 'Verify release artifact hashes')
    expect([...runtimeSteps, ...sdkSteps].some(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )).toBe(false)
    expect([...runtimeSteps, ...sdkSteps].filter(
      step => step.uses === 'pypa/gh-action-pypi-publish@release/v1',
    )).toHaveLength(2)
    expect(runtimePublish).toMatchObject({
      with: { 'packages-dir': 'dist/runtime/', attestations: false },
    })
    expect(sdkPublish).toMatchObject({
      with: { 'packages-dir': 'dist/sdk/', attestations: false },
    })
    expect(runtimeHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
    expect(sdkHashes).toMatchObject({ run: 'cd dist && sha256sum -c SHA256SUMS' })
  })

>>>>>>> upstream/master
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
    const workflowJson = JSON.stringify(workflow)
    expect(workflowJson).toContain('macosx_14_0_arm64')
    expect(workflowJson).toContain('dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$SDK_WHEEL')
    expect(workflowJson).toContain('/work/dist-python/$RUNTIME_WHEEL')
    expect(workflowJson).not.toContain('--find-links dist-python')
    expect(workflowJson).not.toContain('--find-links /work/dist-python')
    expect(manylinuxAddon).toMatchObject({ if: "runner.os == 'Linux'" })
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_x86_64')
    expect(JSON.stringify(manylinuxAddon)).toContain('manylinux_2_28_aarch64')
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
