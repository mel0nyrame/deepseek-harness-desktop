import { defineConfig } from 'tsdown'

/** Build the Electron main entry and sandboxed CommonJS preload independently. */
export default defineConfig([
  {
    entry: ['lib/types/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    external: ['electron'],
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/preload.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    external: ['electron'],
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
