import { spawn } from 'node:child_process'
<<<<<<< HEAD
import { setTimeout as delay } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'
=======
import { rename, writeFile } from 'node:fs/promises'
>>>>>>> upstream/master

const [statePath, publication = 'complete'] = process.argv.slice(2)
if (statePath === undefined || (publication !== 'complete' && publication !== 'partial')) {
  throw new Error('usage: managed-tree.ts <state-path> [complete|partial]')
}

process.on('SIGTERM', () => {})
process.on('SIGHUP', () => {})
const descendant = spawn(process.execPath, [
  '-e',
  'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},60_000)',
], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('managed descendant did not publish a pid')

<<<<<<< HEAD
if (publication === 'partial') {
  await writeFile(statePath, '')
  await delay(100)
}
await writeFile(statePath, JSON.stringify({ root: process.pid, descendant: descendant.pid }))
=======
const pendingStatePath = `${statePath}.pending-${process.pid}`
await writeFile(pendingStatePath, JSON.stringify({ root: process.pid, descendant: descendant.pid }))
await rename(pendingStatePath, statePath)
>>>>>>> upstream/master
setInterval(() => {}, 60_000)
