import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

const LOCAL_ENTRY_FIELDS = ['main', 'module', 'types', 'typings'] as const
const ENTRY_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.json', '.node', '.d.ts'] as const

function entryStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(entryStrings)
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(entryStrings)
}

interface EntryTarget {
  readonly target: string
  readonly requireExisting: boolean
}

function entryTargets(value: unknown, requireExisting: boolean): EntryTarget[] {
  if (typeof value === 'string') return [{ target: value, requireExisting }]
  if (Array.isArray(value)) return value.flatMap(entry => entryTargets(entry, requireExisting))
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([condition, entry]) => entryTargets(
    entry,
    requireExisting && condition !== 'types' && !condition.startsWith('types@'),
  ))
}

function assertLocalEntry(
  packageRoot: string,
  manifestPath: string,
  field: string,
  target: string,
  requireExisting = true,
): void {
  const wildcard = target.indexOf('*')
  const comparable = wildcard === -1 ? target : target.slice(0, wildcard)
  const resolved = path.resolve(path.dirname(manifestPath), comparable)
  const relative = path.relative(packageRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Runtime entry escapes its package: ${manifestPath} ${field}=${target}`)
  }
  const candidates = ENTRY_EXTENSIONS.flatMap(extension => [
    `${resolved}${extension}`,
    path.join(resolved, `index${extension}`),
  ])
  if (requireExisting && wildcard === -1 && !candidates.some(candidate => {
    try {
      return fs.statSync(candidate).isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  })) {
    throw new Error(`Runtime entry is missing: ${manifestPath} ${field}=${target}`)
  }
}

function packageBoundary(root: string, manifestPath: string): string {
  const segments = path.relative(root, manifestPath).split(path.sep)
  const nodeModules = segments.lastIndexOf('node_modules')
  if (nodeModules === -1) return root
  const packageSegments = segments[nodeModules + 1]?.startsWith('@') ? 2 : 1
  return path.join(root, ...segments.slice(0, nodeModules + 1 + packageSegments))
}

function verifyEntries(root: string, manifestPath: string, manifest: Record<string, unknown>): void {
  const packageRoot = packageBoundary(root, manifestPath)
  const packageName = typeof manifest.name === 'string' ? manifest.name : ''
  const requireRuntimeEntry = path.dirname(manifestPath) === packageRoot
    && (packageRoot === root
      || packageName.startsWith('@deepseek-ai/')
      || packageName.startsWith('@dsh-desktop/'))
  for (const field of LOCAL_ENTRY_FIELDS) {
    for (const target of entryStrings(manifest[field])) {
      assertLocalEntry(
        packageRoot,
        manifestPath,
        field,
        target,
        requireRuntimeEntry && field !== 'types' && field !== 'typings',
      )
    }
  }
  for (const target of entryStrings(manifest.bin)) {
    assertLocalEntry(packageRoot, manifestPath, 'bin', target, requireRuntimeEntry)
  }
  for (const { target, requireExisting } of entryTargets(manifest.exports, requireRuntimeEntry)) {
    assertLocalEntry(
      packageRoot,
      manifestPath,
      'exports',
      target,
      requireExisting,
    )
  }
  for (const target of entryStrings(manifest.imports)) {
    if (target.startsWith('.') || path.isAbsolute(target)) {
      assertLocalEntry(packageRoot, manifestPath, 'imports', target, requireRuntimeEntry)
    }
  }
  const browser = manifest.browser
  if (typeof browser === 'string') {
    assertLocalEntry(packageRoot, manifestPath, 'browser', browser, requireRuntimeEntry)
  } else if (typeof browser === 'object' && browser !== null) {
    for (const [source, replacement] of Object.entries(browser)) {
      if (source.startsWith('.') || path.isAbsolute(source)) {
        assertLocalEntry(packageRoot, manifestPath, 'browser', source, false)
      }
      if (typeof replacement === 'string'
        && (replacement.startsWith('.') || path.isAbsolute(replacement))) {
        assertLocalEntry(packageRoot, manifestPath, 'browser', replacement, requireRuntimeEntry)
      }
    }
  }
}

function packageManifests(root: string): string[] {
  const manifests: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(candidate)
      else if (entry.isFile() && entry.name === 'package.json') manifests.push(candidate)
    }
  }
  visit(root)
  return manifests
}

function sourceFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.')) visit(candidate)
      else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) files.push(candidate)
    }
  }
  visit(root)
  return files
}

function sourceReferences(file: string): string[] {
  const result = buildSync({
    stdin: {
      contents: fs.readFileSync(file, 'utf8'),
      resolveDir: path.dirname(file),
      sourcefile: file,
      loader: 'js',
    },
    bundle: false,
    metafile: true,
    write: false,
    platform: 'node',
    logLevel: 'silent',
  })
  return Object.values(result.metafile.outputs)
    .flatMap(output => output.imports.map(reference => reference.path))
}

function verifySourceReferences(root: string): void {
  for (const file of sourceFiles(root)) {
    const packageRoot = packageBoundary(root, file)
    for (const reference of sourceReferences(file)) {
      const target = reference.split(/[?#]/, 1)[0] ?? reference
      if (!target.startsWith('.') && !path.isAbsolute(target) && !target.startsWith('file:')) continue
      const resolved = target.startsWith('file:')
        ? fileURLToPath(target)
        : path.resolve(path.dirname(file), target)
      const relative = path.relative(packageRoot, resolved)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Runtime source reference escapes its package: ${file} -> ${reference}`)
      }
    }
  }
}

function verifyLinks(root: string): void {
  const closureRoot = fs.realpathSync(root)
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(candidate)
        const relative = path.relative(closureRoot, target)
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`Runtime link escapes the assembled closure: ${candidate} -> ${target}`)
        }
      } else if (entry.isDirectory()) {
        visit(candidate)
      }
    }
  }
  visit(closureRoot)
}

/** Reject runtime entries, links, and source references that require a source checkout. */
export function verifyRuntimeClosure(root: string): void {
  verifyLinks(root)
  for (const manifestPath of packageManifests(root)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    verifyEntries(root, manifestPath, manifest)
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = manifest[section]
      if (typeof dependencies !== 'object' || dependencies === null) continue
      for (const [name, value] of Object.entries(dependencies as Record<string, unknown>)) {
        const specifier = String(value)
        if (!/^(?:workspace|file|link|portal):/.test(specifier)
          && !specifier.startsWith('.')
          && !path.isAbsolute(specifier)) continue
        throw new Error(
          `Source-relative dependency in assembled runtime: ${manifestPath} ${name}=${specifier}`,
        )
      }
    }
  }
  verifySourceReferences(root)
}
