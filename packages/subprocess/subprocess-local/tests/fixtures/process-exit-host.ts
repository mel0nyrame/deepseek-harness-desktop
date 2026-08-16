import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const [kind, trigger, root, publication = 'complete'] = process.argv.slice(2)
if ((kind !== 'ordinary' && kind !== 'terminal')
  || (trigger !== 'direct' && trigger !== 'uncaught-exception'
    && trigger !== 'unhandled-rejection' && trigger !== 'dispose')
  || (publication !== 'complete' && publication !== 'partial')
  || root === undefined) {
  throw new Error('usage: process-exit-host.ts <ordinary|terminal> <direct|uncaught-exception|unhandled-rejection|dispose> <root> [complete|partial]')
}

const treeState = join(root, 'tree.json')
const ready = join(root, 'ready')
const proceed = join(root, 'proceed')
const managedTree = fileURLToPath(new URL('./managed-tree.ts', import.meta.url))

async function waitForFile(path: string): Promise<void> {
  for (;;) {
    try {
      await access(path)
      return
    } catch (_notReady) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

async function waitForTreeState(path: string): Promise<void> {
  for (;;) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await delay(10)
      continue
    }
    let published: { root?: unknown; descendant?: unknown }
    try {
      published = JSON.parse(text) as { root?: unknown; descendant?: unknown }
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error
      await delay(10)
      continue
    }
    if (!Number.isSafeInteger(published.root) || !Number.isSafeInteger(published.descendant)) {
      throw new Error('managed tree published invalid process ids')
    }
    return
  }
}

const listenersBefore = process.listenerCount('exit')
const ctx = new Context()
const fiber = await ctx.plugin(LocalSubprocessRuntime)
const listenersAfterLoad = process.listenerCount('exit')
if (kind === 'ordinary') {
  ctx.subprocess.spawn({
    argv: [process.execPath, managedTree, treeState, publication],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: trigger === 'dispose' ? 100 : 30_000,
  })
} else {
  await ctx.subprocess.spawnTerminal({
    argv: [process.execPath, managedTree, treeState, publication],
    cwd: process.cwd(),
    rows: 24,
    cols: 80,
    graceMs: 30_000,
  })
}

await waitForTreeState(treeState)
await writeFile(ready, 'ready')
await waitForFile(proceed)

if (trigger === 'dispose') {
  await fiber.dispose()
  await writeFile(join(root, 'dispose.json'), JSON.stringify({
    listenersBefore,
    listenersAfterLoad,
    listenersAfterDispose: process.listenerCount('exit'),
  }))
} else if (trigger === 'direct') {
  process.exit(23)
} else if (trigger === 'uncaught-exception') {
  setImmediate(() => { throw new Error('host-exit-uncaught-exception') })
  await new Promise(() => {})
} else {
  void Promise.reject(new Error('host-exit-unhandled-rejection'))
  await new Promise(() => {})
}
