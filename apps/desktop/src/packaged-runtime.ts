/**
 * Production runtime-closure contract: where a packaged application bundle
 * finds its bundled DSH runtime. The Electron shell ships inside the asar; the
 * whole runtime closure (the dsh CLI, every in-box plugin's built `lib`, the
 * Web frontend dist, and native modules rebuilt against the production
 * Electron ABI) lives as real files under `Contents/Resources/runtime`, because
 * child processes and native loading need filesystem paths no archive can
 * provide. The packaging script and the packaged-app smoke test own the same
 * layout; keep both in sync with this module.
 */

import { join } from 'node:path'

/** Subdirectory of `Contents/Resources` holding the staged runtime closure. */
export const RUNTIME_SUBDIR = 'runtime'

/** Entry of the dedicated DSH child, relative to the runtime closure root. */
const CLI_ENTRY_REL = join('@deepseek-ai', 'dsh', 'lib', 'bin.js')
/** Web frontend dist served through the `dsh://` asset protocol. */
const WEB_DIST_REL = join('@deepseek-ai', 'dsh-web-frontend', 'dist')
/** node-pty macOS spawn helper, rebuilt beside the Electron-ABI addon. */
const PTY_HELPER_REL = join('node-pty', 'build', 'Release', 'spawn-helper')
/** Keyless replay provider the packaged smoke profile mounts. */
const REPLAY_PROVIDER_REL = join('@deepseek-ai', 'dsh-llm-replay')

/**
 * Node arguments of the packaged DSH child. The config-hot-reload watcher
 * needs the Node internal ESM loader; the development child reaches it
 * through node-addon-require-builtin, whose addon cannot hook Electron's V8
 * embedder, so packaged children expose internals directly to the runtime.
 */
export const PACKAGED_CHILD_EXEC_ARGV: readonly string[] = ['--expose-internals']

/** Paths a packaged application resolves from its bundle resources. */
export interface PackagedRuntime {
  /** Absolute root containing the deployed runtime's package files. */
  readonly runtimeRoot: string
  /** Absolute path of the dsh CLI entry forked as the dedicated DSH child. */
  readonly cliEntry: string
  /** Absolute path of the prebuilt Web frontend dist. */
  readonly webDist: string
  /** Absolute path of node-pty's spawn helper (outside any archive). */
  readonly ptySpawnHelper: string
  /** Absolute package dir of the keyless replay provider used by `--smoke`. */
  readonly replayProvider: string
  /** Real working directory for the DSH child (never inside the bundle). */
  readonly childCwd: string
}

/**
 * Resolve the packaged runtime layout from the application bundle.
 * @param resourcesPath - `process.resourcesPath` (`Contents/Resources`).
 * @param userData - `app.getPath('userData')`, the child's writable working directory.
 * @returns the absolute runtime paths.
 */
export function packagedRuntimeLayout(resourcesPath: string, userData: string): PackagedRuntime {
  const runtimeRoot = join(resourcesPath, RUNTIME_SUBDIR, 'node_modules')
  return {
    runtimeRoot,
    cliEntry: join(runtimeRoot, CLI_ENTRY_REL),
    webDist: join(runtimeRoot, WEB_DIST_REL),
    ptySpawnHelper: join(runtimeRoot, PTY_HELPER_REL),
    replayProvider: join(runtimeRoot, REPLAY_PROVIDER_REL),
    childCwd: userData,
  }
}

/**
 * Environment of the packaged DSH child: `ELECTRON_RUN_AS_NODE` turns the
 * application binary into the child's Node runtime (no system Node.js
 * participates), and the patched node-pty resolves its helper through
 * `DSH_NODE_PTY_SPAWN_HELPER` when the embedded runtime cannot place a
 * sibling beside its executable.
 * @param env - the inherited parent environment.
 * @param ptySpawnHelper - absolute helper path from {@link PackagedRuntime}.
 * @returns a new environment object with the two overrides applied.
 */
export function packagedChildEnv(env: NodeJS.ProcessEnv, ptySpawnHelper: string): NodeJS.ProcessEnv {
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_NODE_PTY_SPAWN_HELPER: ptySpawnHelper,
  }
}

/** Parsed `--smoke` invocation driving the keyless packaged tracer bullet. */
export interface SmokeInvocation {
  /** Absolute path of the recorded replay session; required in smoke mode. */
  readonly replayFile?: string
}

/**
 * Parse the application arguments for a smoke invocation. Packaged smoke runs
 * come from the outer test harness: `--smoke --smoke-replay <file>`.
 * @param argv - the raw `process.argv`.
 * @returns the invocation when `--smoke` is present, otherwise undefined.
 */
export function parseSmokeInvocation(argv: readonly string[]): SmokeInvocation | undefined {
  let smoke = false
  let replayFile: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--smoke') {
      smoke = true
      continue
    }
    if (arg === '--smoke-replay') {
      const value = argv[index + 1]
      if (typeof value === 'string' && value !== '' && !value.startsWith('-')) {
        replayFile = value
        index += 1
      }
    }
  }
  return smoke ? { ...(replayFile === undefined ? {} : { replayFile }) } : undefined
}
