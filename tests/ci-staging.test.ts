import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOWS = path.join(ROOT, '.github', 'workflows')

const ORDINARY_PR_COMMANDS = ['pnpm install --frozen-lockfile', 'pnpm run typecheck', 'pnpm run lint', 'pnpm run test']
const PACKAGING_PATHS = [
  'apps/**',
  'packages/**',
  'runtime/**',
  'scripts/**',
  'patches/**',
  'tests/fixtures/**',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.github/workflows/packaging.yml',
]
const RELEASE_SECRET_NAMES = [
  'MAC_SIGNING_IDENTITY',
  'MAC_CERTIFICATE_P12',
  'MAC_CERTIFICATE_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
]

function loadWorkflow(name: string): { raw: string; document: Record<string, any> } {
  const raw = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8')
  return { raw, document: parseYaml(raw) as Record<string, any> }
}

function stepCommands(job: { steps?: Array<{ run?: string }> }): string[] {
  return (job.steps ?? []).map(step => (step.run ?? '').trim())
}

describe('CI staging', () => {
  it('runs only the fast workspace checks as ordinary pull-request CI', () => {
    const { document } = loadWorkflow('ci.yml')
    const triggers = document.on ?? document.true
    expect(Object.keys(triggers)).toEqual(expect.arrayContaining(['pull_request', 'push']))
    expect(Object.keys(document.jobs)).toEqual(['workspace'])
    const commands = stepCommands(document.jobs.workspace)
    for (const command of ORDINARY_PR_COMMANDS) {
      expect(commands.some(run => run.includes(command)), command).toBe(true)
    }
    expect(commands.some(run => run.includes('pnpm run package'))).toBe(false)
    expect(commands.some(run => run.includes('test:package'))).toBe(false)
  })

  it('runs the packaging gate when app-artifact inputs change and on the default branch', () => {
    const { document } = loadWorkflow('packaging.yml')
    const triggers = document.on ?? document.true
    expect(triggers.pull_request.paths).toEqual(PACKAGING_PATHS)
    expect(triggers.push).toEqual({ branches: ['master'] })
    expect(triggers['workflow_dispatch']).toBeDefined()

    const job = document.jobs['package-macos']
    expect(job['runs-on']).toMatch(/^macos-/)
    const commands = stepCommands(job)
    expect(commands.some(run => run.includes('pnpm install --frozen-lockfile'))).toBe(true)
    expect(commands.some(run => run.includes('pnpm run package'))).toBe(true)
    const smoke = job.steps.find((step: { run?: string }) => step.run?.includes('pnpm run test:package'))
    expect(smoke?.env?.DSH_DESKTOP_PACKAGE_REQUIRED).toBe('1')
    const upload = job.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact'))
    expect(String(upload?.with?.path)).toContain('.dmg')
  })

  it('keeps the packaging gate credential-free', () => {
    const { raw } = loadWorkflow('packaging.yml')
    expect(raw).not.toContain('secrets.')
  })

  it('defines ad-hoc release evidence for labeled release pull requests on arm64 and x64', () => {
    const { document } = loadWorkflow('release.yml')
    const triggers = document.on ?? document.true
    expect(triggers.pull_request.types).toContain('labeled')

    const preview = document.jobs.preview
    expect(preview.if).toContain("contains(github.event.pull_request.labels.*.name, 'release')")
    expect(preview.if).toContain("github.event_name == 'pull_request'")
    const arches = preview.strategy.matrix.include.map((entry: { arch: string }) => entry.arch)
    expect(arches).toEqual(['arm64', 'x64'])
    expect(arches.map((arch: string, index: number) => preview.strategy.matrix.include[index].runner)).toEqual([
      'macos-15',
      'macos-15-intel',
    ])
    expect(stepCommands(preview).some(run => run.includes('pnpm run package'))).toBe(true)
    expect(preview.env).toBeUndefined()
  })

  it('reserves signing and notarization for tag and dispatch runs behind required secrets', () => {
    const { raw, document } = loadWorkflow('release.yml')
    const release = document.jobs.release
    expect(release.if).toContain("startsWith(github.ref, 'refs/tags/v')")
    expect(release.if).toContain("github.event_name == 'workflow_dispatch'")
    expect(release.if).not.toContain("'pull_request'")

    const guard = release.steps.find((step: { name?: string }) => step.name === 'Require configured signing and notarization credentials')
    expect(guard).toBeDefined()
    expect(guard?.run).toContain('refusing an unsigned release build')
    expect(guard?.run).toContain('refusing an unnotarized release build')

    const build = release.steps.find((step: { name?: string }) => step.name === 'Build signed and notarized release artifacts')
    expect(build).toBeDefined()
    expect(release.env).toBeUndefined()
    for (const step of release.steps) {
      const secretNames = new Set<string>()
      for (const [name, value] of Object.entries(step.env ?? {})) {
        const match = String(value).match(/^\$\{\{ secrets\.([A-Z0-9_]+) \}\}$/)
        if (match !== null) secretNames.add(match[1] as string)
        else expect(String(value), `${step.name}: ${name} must not disguise a secret expression`).not.toContain('secrets.')
      }
      const expected = step === guard || step === build ? RELEASE_SECRET_NAMES : []
      expect([...secretNames].toSorted(), `${step.name}: secret scope`).toEqual([...expected].toSorted())
    }

    // Credentials exist only as repository/Actions secrets: no cert material,
    // no password literals anywhere in the workflow file.
    expect(raw).not.toContain('BEGIN')
    expect(raw).toMatch(/refusing an unsigned release build/)

    const arches = release.strategy.matrix.include.map((entry: { arch: string }) => entry.arch)
    expect(arches).toEqual(['arm64', 'x64'])
  })

  it('never exposes the real-API key to any workflow and keeps checkouts credential-free', () => {
    for (const name of ['ci.yml', 'packaging.yml', 'release.yml']) {
      const { raw, document } = loadWorkflow(name)
      expect(raw, `${name}: real-API key stays local`).not.toContain('DEEPSEEK_API_KEY')
      for (const job of Object.values(document.jobs) as Array<{ steps?: Array<{ with?: { 'persist-credentials'?: unknown } }> }>) {
        for (const step of job.steps ?? []) {
          if (step.with?.['persist-credentials'] !== undefined) {
            expect(step.with['persist-credentials'], `${name}: checkout persist-credentials`).toBe(false)
          }
        }
      }
    }
  })
})
