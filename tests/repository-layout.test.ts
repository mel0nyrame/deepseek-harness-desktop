import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The pinned official DSH source commit: tag `dsh-v0.1.0-rc.8` on deepseek-ai/deepseek-harness. */
const PINNED_UPSTREAM_COMMIT = '141eb6fef83422698aef7a981029e843e8161534'

const WORKSPACE_MEMBERS = new Set([
  '@dsh-desktop/shell',
  '@dsh-desktop/bundle',
  '@dsh-desktop/connection',
  '@dsh-desktop/native',
  '@dsh-desktop/ui',
])

/** All non-dsh- skills are preserved, per the workspace-decoupling Agent Note. */
const PRESERVED_SKILLS = [
  'code-review',
  'codebase-design',
  'diagnosing-bugs',
  'domain-modeling',
  'implement',
  'prototype',
  'record-browser-gif',
  'setup-matt-pocock-skills',
  'tdd',
  'to-spec',
  'to-tickets',
  'triage',
  'wayfinder',
  'writing-for-agents',
]

/** The deliberately retained dsh- skills; the dropped set is asserted absent. */
const RETAINED_DSH_SKILLS = [
  'dsh-archive-agent-notes',
  'dsh-code-review',
  'dsh-find-simplifications',
  'dsh-merging-stacked-prs',
  'dsh-pre-push-checks',
  'dsh-prose-standard',
  'dsh-trim-cot-leakage',
]

const DROPPED_DSH_SKILLS = [
  'dsh-doc-site-sync',
  'dsh-doc-standards',
  'dsh-translate-docs',
]

/** The migrated Agent Notes (basename triplets), per the workspace-decoupling Agent Note. */
const MIGRATED_NOTES = [
  'proposed/feature/2026-08-14-electron-desktop-app',
  'implemented/feature/2026-08-16-desktop-app-icon',
  'implemented/feature/2026-08-16-macos-compact-window-presentation',
  'implemented/process/2026-06-20-agent-note-classification',
  'implemented/process/2026-07-19-remove-generated-agent-note-index',
  'implemented/process/2026-07-26-frozen-agent-note-archive',
  'implemented/process/2026-08-02-native-github-stacks-and-optional-rebases',
  'implemented/process/2026-08-10-npm-release-sequences',
  'implemented/process/2026-08-16-desktop-fork-identity-and-upstream-readme-preservation',
  'implemented/process/2026-08-16-desktop-release-artifact-signing',
  'rejected/process/2026-08-04-artifact-first-npm-baseline-publication',
]

/**
 * Git blob hashes (`git hash-object`) of the product identity assets. The
 * decoupling issue requires these assets to retain their content, names, and
 * locations; pinning the hashes makes any content change a deliberate commit.
 */
const IDENTITY_ASSET_BLOBS: Record<string, string> = {
  'apps/desktop/build/icon.png': 'efd386acafa941b5e873dfa9611c919898fd44fe',
  'apps/desktop/build/icon.svg': 'b19e5b8d35f41b05d9fda1d07e02735e2341778d',
  'assets/readme/architecture.svg': '05edf2ef548accec8daeabdedb8c128f0e330230',
  'assets/readme/hero-light.svg': '96e1af69aeb28e9ecd59641d52a953da5b454247',
  'assets/readme/icons/bundled-runtime.png': '2173975d0463c63a0937b3fb238365c5a84913f2',
  'assets/readme/icons/compact-native-window.svg': '5433dad07fb5512752dee99940d2307ec8e6aa1a',
  'assets/readme/icons/native-workspace.png': 'b76ea8ed37de6efb33a262174f35b459b38ab689',
  'assets/readme/icons/persistent-glass-sidebar.svg': '7e8c864a539262a9d032574e3453820660cc9b7e',
  'assets/readme/icons/private-carrier.png': '076468fee1aa7f0d76ebd841045d8414d15911d7',
  'assets/readme/icons/shared-state.png': '982a86bc50bc0696bb59190e823b8462f6aab9d4',
  'assets/readme/icons/zero-width-focus.svg': '077edd18d8e0b977e5ed80d3b1c4c838a5b4abcf',
  'assets/readme/product-window.png': '3c9d0bdc6c0b103a9bd2e5bd22729b36c6937dd3',
  'assets/readme/source/icons/dsh-desktop-feature-sheet-flat.png': 'a23f22d00ef6d6e27ca0967ae26ea3de4eb3bc51',
  'assets/readme/source/icons/dsh-desktop-feature-sheet-prompt.txt': 'b96966fa11aac5f5a85bccbd30f3531f2215225f',
  'assets/readme/source/icons/dsh-desktop-feature-sheet.png': '67b9f1d8b66df027d087b45872ce08b60d8837f2',
  'assets/readme/source/icons/dsh-desktop-light-spot.json': '4909713f6ba22a51130280ab28efe6faa0077845',
  'assets/readme/source/screenshots/native-window-product.png': '4be3a76373ee6b2bb6906afb391182453e5ee0f7',
}

/** The pre-decoupling root files that must stay present inside `legacy/`. */
const FROZEN_ROOT_DOCS = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'README.zh.md',
  'README.i18n.yaml',
  'LICENSE',
  'SECURITY.md',
  '.editorconfig',
  '.gitattributes',
]

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8')) as Record<string, unknown>
}

function gitBlob(relative: string): string {
  return execFileSync('git', ['hash-object', relative], { cwd: ROOT, encoding: 'utf8' }).trim()
}

function walkFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? walkFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    )
}

function expandWorkspaceGlobs(globs: string[]): string[] {
  const members: string[] = []
  for (const glob of globs) {
    const prefix = glob.replace(/\*+$/, '')
    if (!fs.existsSync(path.join(ROOT, prefix))) continue
    for (const entry of fs.readdirSync(path.join(ROOT, prefix))) {
      const candidate = path.join(ROOT, prefix, entry)
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        members.push(path.join(prefix, entry))
      }
    }
  }
  return members
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function assertAllowedDependencies(manifestPath: string, manifest: Record<string, unknown>) {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies'] as const
  for (const section of sections) {
    const deps = manifest[section]
    if (typeof deps !== 'object' || deps === null) continue
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      const specifier = String(spec)
      if (name.startsWith('@dsh-desktop/')) {
        expect(specifier, `${manifestPath}: desktop dependency ${name}`).toBe('workspace:*')
        continue
      }
      if (name.startsWith('@deepseek-ai/')) {
        expect(name, `${manifestPath}: desktop role under official namespace`).not.toMatch(
          /^@deepseek-ai\/dsh-desktop/,
        )
        expect(specifier, `${manifestPath}: official dependency ${name} must be an exact version`).toMatch(
          EXACT_VERSION,
        )
        continue
      }
      // Third-party dependencies are exact versions, never workspace/file/link references.
      expect(specifier, `${manifestPath}: third-party dependency ${name}`).toMatch(EXACT_VERSION)
    }
  }
}

describe('repository layout', () => {
  it('declares the workspace under the @dsh-desktop namespace only', () => {
    const workspace = parseYaml(fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as {
      packages: string[]
    }
    expect(workspace.packages).toEqual(['apps/*', 'packages/*'])

    const members = expandWorkspaceGlobs(workspace.packages)
    const names = members.map((dir) => {
      const manifest = readJson(path.join(dir, 'package.json'))
      return { dir, name: String(manifest.name) }
    })

    expect(new Set(names.map((n) => n.name))).toEqual(WORKSPACE_MEMBERS)
    for (const { dir, name } of names) {
      expect(name, `member ${dir} must be @dsh-desktop/*`).toMatch(/^@dsh-desktop\//)
    }

    const root = readJson('package.json')
    expect(root.name).toBe('@dsh-desktop/root')

    // The legacy monorepo is frozen, not a workspace member.
    expect(fs.existsSync(path.join(ROOT, 'legacy/package.json'))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, 'legacy/pnpm-workspace.yaml'))).toBe(true)
    expect(members.some((dir) => dir.startsWith('legacy'))).toBe(false)
  })

  it('enforces the dependency directions', () => {
    const workspace = parseYaml(fs.readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as {
      packages: string[]
    }
    for (const dir of expandWorkspaceGlobs(workspace.packages)) {
      const manifestPath = path.join(dir, 'package.json')
      assertAllowedDependencies(manifestPath, readJson(manifestPath))
    }

    // Nothing outside the workspace may depend on a desktop package: the frozen
    // legacy tree must never gain a dependency on @dsh-desktop/*.
    const legacyManifests = execFileSync('git', ['ls-files', 'legacy/**/package.json'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean)
    for (const manifestPath of legacyManifests) {
      const manifest = readJson(manifestPath)
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        const deps = manifest[section]
        if (typeof deps !== 'object' || deps === null) continue
        for (const name of Object.keys(deps as Record<string, unknown>)) {
          expect(name, `${manifestPath}: legacy dependency on a desktop package`).not.toMatch(
            /^@dsh-desktop\//,
          )
        }
      }
    }
  })

  it('declares the pinned official DSH submodule', () => {
    const gitmodules = execFileSync(
      'git',
      ['config', '--file', '.gitmodules', '--get', 'submodule.upstream.path'],
      { cwd: ROOT, encoding: 'utf8' },
    ).trim()
    expect(gitmodules).toBe('upstream')

    const url = execFileSync(
      'git',
      ['config', '--file', '.gitmodules', '--get', 'submodule.upstream.url'],
      { cwd: ROOT, encoding: 'utf8' },
    ).trim()
    expect(url).toContain('deepseek-ai/deepseek-harness')

    // The gitlink lives in the index (identical to HEAD in a normal checkout).
    const gitlink = execFileSync('git', ['ls-files', '-s', 'upstream'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim()
    expect(gitlink).toBe(`160000 ${PINNED_UPSTREAM_COMMIT} 0\tupstream`)

    if (fs.existsSync(path.join(ROOT, 'upstream/.git'))) {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: path.join(ROOT, 'upstream'),
        encoding: 'utf8',
      }).trim()
      expect(head).toBe(PINNED_UPSTREAM_COMMIT)
    }
  })

  it('keeps the required agent-development resources', () => {
    expect(fs.existsSync(path.join(ROOT, 'AGENTS.md'))).toBe(true)
    const claude = fs.lstatSync(path.join(ROOT, 'CLAUDE.md'))
    expect(claude.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(path.join(ROOT, 'CLAUDE.md'))).toBe('AGENTS.md')

    const skillsDir = path.join(ROOT, '.agents/skills')
    const skills = fs.readdirSync(skillsDir).toSorted()
    for (const skill of [...PRESERVED_SKILLS, ...RETAINED_DSH_SKILLS]) {
      expect(skills, `skill ${skill} must be present`).toContain(skill)
      expect(fs.existsSync(path.join(skillsDir, skill, 'SKILL.md')), `SKILL.md of ${skill}`).toBe(true)
    }
    for (const skill of DROPPED_DSH_SKILLS) {
      expect(skills, `dropped skill ${skill} must not be copied`).not.toContain(skill)
    }

    const notesDir = path.join(ROOT, '.agents/notes')
    for (const lifecycle of ['proposed', 'implemented', 'rejected', 'archived']) {
      expect(fs.statSync(path.join(notesDir, lifecycle)).isDirectory()).toBe(true)
    }
    expect(fs.existsSync(path.join(notesDir, 'README.md'))).toBe(true)
    expect(fs.existsSync(path.join(notesDir, 'AGENTS.md'))).toBe(true)

    // The lifecycle set is closed: no other top-level folder may appear here.
    expect(fs.readdirSync(notesDir).toSorted()).toEqual([
      'AGENTS.md',
      'README.i18n.yaml',
      'README.md',
      'README.zh.md',
      'archived',
      'implemented',
      'proposed',
      'rejected',
    ])

    for (const note of MIGRATED_NOTES) {
      for (const suffix of ['.md', '.zh.md', '.i18n.yaml']) {
        expect(fs.existsSync(path.join(notesDir, note + suffix)), `${note}${suffix}`).toBe(true)
      }
    }

    for (const doc of ['issue-tracker', 'triage-labels', 'domain']) {
      expect(fs.existsSync(path.join(ROOT, `docs/agents/${doc}.md`)), `${doc}.md`).toBe(true)
      expect(fs.existsSync(path.join(ROOT, `docs/agents/${doc}.zh.md`)), `${doc}.zh.md`).toBe(true)
    }
  })

  it('keeps the identity assets with their content intact', () => {
    for (const [relative, blob] of Object.entries(IDENTITY_ASSET_BLOBS)) {
      expect(gitBlob(relative), `${relative} content`).toBe(blob)
    }
  })

  it('keeps the frozen legacy tree complete', () => {
    for (const relative of FROZEN_ROOT_DOCS) {
      expect(fs.existsSync(path.join(ROOT, 'legacy', relative)), `legacy/${relative}`).toBe(true)
    }
    const claude = fs.lstatSync(path.join(ROOT, 'legacy/CLAUDE.md'))
    expect(claude.isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(path.join(ROOT, 'legacy/CLAUDE.md'))).toBe('AGENTS.md')

    // The frozen assets/readme tree mirrors the product identity assets blob-for-blob.
    for (const file of walkFiles(path.join(ROOT, 'assets/readme'))) {
      const relative = path.relative(ROOT, file)
      expect(gitBlob(`legacy/${relative}`), `legacy/${relative} mirrors ${relative}`).toBe(
        gitBlob(relative),
      )
    }
  })

  it('enforces the Agent Note format basics', () => {
    const notesDir = path.join(ROOT, '.agents/notes')
    const lifecycles: Record<string, string> = {
      proposed: 'proposed',
      implemented: 'implemented',
      rejected: 'rejected',
    }
    for (const [lifecycle, status] of Object.entries(lifecycles)) {
      for (const kind of fs.readdirSync(path.join(notesDir, lifecycle))) {
        const kindDir = path.join(notesDir, lifecycle, kind)
        if (!fs.statSync(kindDir).isDirectory()) continue
        for (const file of fs.readdirSync(kindDir)) {
          if (!file.endsWith('.md') || file.endsWith('.zh.md')) continue
          const content = fs.readFileSync(path.join(kindDir, file), 'utf8').split('\n')
          expect(content[0], `${lifecycle}/${kind}/${file} header`).toMatch(/^# Agent Note: /)
          expect(content[1], `${lifecycle}/${kind}/${file} blank line`).toBe('')
          // Rejected notes carry their verdict on the status line.
          expect(content[2], `${lifecycle}/${kind}/${file} status`).toMatch(
            new RegExp(`^Status: ${status}( — |$)`),
          )
          const body = content.join('\n')
          expect(
            body.includes('## Alternatives considered') ||
              body.includes('<!-- agent-note-format: alternatives-not-recorded'),
            `${lifecycle}/${kind}/${file} alternatives section`,
          ).toBe(true)
        }
      }
    }
  })
})
