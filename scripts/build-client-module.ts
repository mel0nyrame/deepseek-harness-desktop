import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2).filter((argument, index) => argument !== '--' || index !== 0)
const { values } = parseArgs({
  args: argv,
  options: {
    entry: { type: 'string' },
    external: { type: 'string', multiple: true },
    id: { type: 'string' },
    output: { type: 'string' },
    prepend: { type: 'string', multiple: true },
  },
})

if (values.entry === undefined || values.id === undefined || values.output === undefined) {
  throw new Error('Client-module build requires --entry, --id, and --output')
}

const prependedFactories = (values.prepend ?? [])
  .map(file => readFileSync(path.resolve(ROOT, file), 'utf8'))
  .join('\n')

await build({
  absWorkingDir: ROOT,
  banner: {
    js: `${prependedFactories}\nwindow.__ModuleLoader__.load({\n  id: ${JSON.stringify(values.id)},\n  factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;`,
  },
  bundle: true,
  entryPoints: [values.entry],
  external: values.external ?? [],
  footer: {
    js: '    return module.exports\n  },\n})',
  },
  format: 'cjs',
  outfile: values.output,
  platform: 'browser',
  sourcemap: true,
  target: 'es2023',
})
