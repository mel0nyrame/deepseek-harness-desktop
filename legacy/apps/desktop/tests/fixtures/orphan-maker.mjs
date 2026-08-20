/**
 * Orphan fixture: spawns one `sleep` grandchild and exits immediately. The
 * grandchild is reparented before the supervisor ever signals anything, so
 * the platform can identify it only through the process group this process
 * led (the test forks it detached). Prints one JSON pid line on stdout.
 */

import { spawn } from 'node:child_process'

const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' })
process.stdout.write(`${JSON.stringify({ pid: process.pid, grandchild: grandchild.pid })}\n`)
process.exit(0)
