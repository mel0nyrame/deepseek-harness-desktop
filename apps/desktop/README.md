# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

Electron desktop application shell for the bundled DeepSeek Harness runtime. Electron main supervises one dedicated application-scoped DSH child carrying the [`desktop` profile](../../apps/cli/README.md) (base + Web product + desktop overlay with every browser transport row disabled), a context-isolated preload bridge carries the existing Connection protocol, and the packaged React client renders locally. No browser-facing HTTP listener participates.

## Development

`pnpm run dev:desktop` (repository root) builds the workspace and launches Electron main in development: the DSH child boots from the source tree through `apps/cli/lib/bin.js` on the ambient Node runtime, the Web frontend is served from the built `dist`, and quitting terminates the owned process tree. The keyless development tracer bullet (`apps/desktop/tests/real-composition.e2e.ts`) covers the same surface without a window.

## Packaging (macOS)

`pnpm --filter @deepseek-ai/dsh-desktop run package` produces an unsigned application bundle for the host architecture under `apps/desktop/dist/mac<optional-arch>/DSH Desktop.app` through four stages ([`scripts/package.ts`](scripts/package.ts)):

1. **Closure** — `pnpm run verify-runtime-closure` proves this package's dependency manifest supplies every required workspace peer.
2. **Deploy** — a pnpm legacy deploy materializes the production runtime closure (the `dsh` CLI, every in-box plugin's built `lib`, the Web frontend `dist`, node-pty, and the keyless replay provider) into a symlink-free staging directory.
3. **Native rebuild** — node-pty is rebuilt against the pinned Electron version's ABI (`@electron/rebuild`), then validated by loading it inside the Electron binary; the macOS `spawn-helper` is staged beside the rebuilt addon with its executable bit.
4. **Bundle** — electron-builder ([`electron-builder.yml`](electron-builder.yml)) assembles the `.app`: the asar carries only `lib/main.js` and the sandboxed preload, while the runtime closure ships as real files under `Contents/Resources/runtime/`.

The installed application starts without a system Node.js or DSH CLI: Electron main forks the application binary itself as the DSH child (`ELECTRON_RUN_AS_NODE`), resolves the CLI, Web dist, and PTY helper from `Contents/Resources/runtime`, and hands the child its user-data directory as the working directory ([`src/packaged-runtime.ts`](src/packaged-runtime.ts) owns this layout). Native modules and the PTY helper therefore never sit inside an archive. The harness home stays the shared `~/.dsh`, so the packaged app and the CLI see the same sessions, profiles, and configuration.

## Packaged smoke

`apps/desktop/tests/packaged-smoke.e2e.ts` launches the installed bundle with `--smoke --smoke-replay <file>` and asserts the full keyless tracer bullet — Session creation, a terminal-backed `echo TERMINAL_OK` tool turn with ordered streamed events, no TCP listener, and quiescent quit — plus the absence of surviving owned processes. A failure-path case feeds it a missing replay file and asserts the same quiescence on a non-zero scenario verdict. It self-skips when the bundle is absent; the macOS CI job packages first and sets `DSH_DESKTOP_SMOKE_REQUIRED=1`, which turns absence into a hard failure.

## Limitations

- The tracer bullet ships unsigned and un-notarized; release-grade signed, notarized, cross-arch (x64) artifacts are a later ticket.
- The smoke launch is headless; GUI acceptance against the real window belongs to the window-experience issue.
- `--smoke` refuses to run without an explicit `DSH_HOME`, so it can never touch the machine owner's real `~/.dsh`.
