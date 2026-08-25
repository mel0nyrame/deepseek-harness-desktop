import { spawn } from 'node:child_process'
import { installReadiness } from './process-tree-readiness.mjs'

const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' })
process.stdout.write(`${JSON.stringify({ pid: process.pid, grandchild: grandchild.pid })}\n`)
installReadiness(() => { setImmediate(() => { process.exit(0) }) })
