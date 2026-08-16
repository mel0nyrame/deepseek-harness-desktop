/**
 * PTY fixture: opens a real node-pty terminal whose `sleep 300` ignores both
 * SIGTERM and the SIGHUP sent when this fixture's pty master closes, and this
 * fixture itself ignores SIGTERM. Only the ladder's pre-signal snapshot plus
 * group SIGKILL can still identify and terminate the PTY session after its
 * owner dies. node-pty resolves through the workspace's subprocess-local
 * package, exactly the addon the product ships. Prints one JSON pid line.
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(fileURLToPath(new URL('../../../../packages/subprocess/subprocess-local/package.json', import.meta.url)))
const nodePty = require('node-pty')

const terminal = nodePty.spawn('/bin/sh', ['-c', 'trap "" HUP; exec sleep 300'], { name: 'xterm-color', cols: 80, rows: 24 })
process.stdout.write(`${JSON.stringify({ pid: process.pid, pty: terminal.pid })}\n`)
process.on('SIGTERM', () => {})
setInterval(() => {}, 1_000)
