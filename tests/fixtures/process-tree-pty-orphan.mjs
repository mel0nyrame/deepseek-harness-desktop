import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { installReadiness } from './process-tree-readiness.mjs'

const require = createRequire(fileURLToPath(new URL('../../packages/bundle/package.json', import.meta.url)))
const nodePty = require('node-pty')
const terminal = nodePty.spawn('/bin/sh', ['-c', 'trap "" HUP; exec sleep 300'], {
  name: 'xterm-color',
  cols: 80,
  rows: 24,
})
process.stdout.write(`${JSON.stringify({ pid: process.pid, pty: terminal.pid })}\n`)
installReadiness(() => { setTimeout(() => { process.exit(0) }, 1_000) })
