/**
 * Graceful-termination fixture: spawns one `sleep` grandchild in the same
 * process group and exits 0 on SIGTERM. The grandchild outlives its immediate
 * parent (it is reparented), so only the process-group ladder can sweep it.
 * Prints one JSON pid line on stdout.
 */

import { spawn } from 'node:child_process'

const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' })
process.stdout.write(`${JSON.stringify({ pid: process.pid, grandchild: grandchild.pid })}\n`)
process.on('SIGTERM', () => { process.exit(0) })
