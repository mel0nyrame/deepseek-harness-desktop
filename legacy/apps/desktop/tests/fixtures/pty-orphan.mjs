/**
 * Distinct-group PTY crash fixture: opens a real node-pty terminal whose
 * `sleep 300` ignores SIGHUP, waits long enough for the supervisor's pre-exit
 * ownership snapshot to observe it as a descendant, then exits without
 * cleanup. Once this process is gone the PTY session is reparented into its
 * own process group, so only that pre-exit snapshot can still identify it.
 * Prints one JSON pid line on stdout.
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(new URL('../../../../packages/subprocess/subprocess-local/package.json', import.meta.url)))
const nodePty = require('node-pty')

const terminal = nodePty.spawn('/bin/sh', ['-c', 'trap "" HUP; exec sleep 300'], { name: 'xterm-color', cols: 80, rows: 24 })
process.stdout.write(`${JSON.stringify({ pid: process.pid, pty: terminal.pid })}\n`)
setTimeout(() => { process.exit(0) }, 1_000)
