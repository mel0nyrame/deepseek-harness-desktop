/**
 * Forced-escalation fixture: ignores SIGTERM (an installed no-op handler
 * replaces the default termination), spawns one `sleep` grandchild, and only
 * dies to SIGKILL. Exercises the ladder's bounded grace → SIGKILL escalation.
 * Prints one JSON pid line on stdout.
 */

import { spawn } from 'node:child_process'

const grandchild = spawn('sleep', ['300'], { stdio: 'ignore' })
process.stdout.write(`${JSON.stringify({ pid: process.pid, grandchild: grandchild.pid })}\n`)
process.on('SIGTERM', () => {})
setInterval(() => {}, 1_000)
