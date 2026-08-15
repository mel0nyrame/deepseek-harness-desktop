# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

Electron desktop application shell for the bundled DeepSeek Harness runtime. Electron main supervises one dedicated application-scoped DSH child carrying the [`desktop` profile](../../apps/cli/README.md) (base + Web product + desktop overlay with every browser transport row disabled), a context-isolated preload bridge carries the existing Connection protocol, and the packaged React client renders locally. No browser-facing HTTP listener participates.

## Development

`pnpm run dev:desktop` (repository root) builds the workspace and launches Electron main in development: the DSH child boots from the source tree through `apps/cli/lib/bin.js` on the ambient Node runtime, the Web frontend is served from the built `dist`, and quitting terminates the owned process tree. The keyless development tracer bullet (`apps/desktop/tests/real-composition.e2e.ts`) covers the same surface without a window.

## Carrier security and lifecycle

The `BrowserWindow` keeps `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. The preload exposes only boot, unary request/cancellation, stream subscription/cancellation, and stream-notification operations. Electron main accepts them only from exact `dsh://app` frames and validates every payload; child-to-main messages and main-to-preload lifecycle notifications are validated again before correlation or renderer delivery, and ready-handshake bundle paths must resolve to real `.js` files beneath the configured development or packaged runtime root. The existing Connection zod schemas then validate RPC envelopes and mux/Host frames before client dispatch.

Each renderer subscription retains at most 256 parsed frames. Electron main acknowledges delivered notifications and bounds each stream's in-flight and queued relay state; overflow or a duplicate open notification cancels the physical subscription and emits an ordered error/end closure. The preload fans out each validated notification through one dispatcher and acknowledges it once. Renderer overflow clears its queue, cancels the physical subscription, and terminates the iterator with an error; caller cancellation discards queued frames immediately. The child stream pump awaits each IPC send callback before reading the next frame, so native-channel backpressure pauses the ordered source instead of reclassifying an accepted message as lost. Electron main cancels renderer-owned requests and streams on main-frame reload/navigation, renderer crash, or renderer destruction; child disconnect/exit/error closes every active request and stream, while application quit or startup failure stops and joins the child.

## Packaging (macOS)

`pnpm --filter @deepseek-ai/dsh-desktop run package` produces an unsigned application bundle for the host architecture under `apps/desktop/dist/mac<optional-arch>/DSH Desktop.app` through five stages ([`scripts/package.ts`](scripts/package.ts)):

1. **Closure** — `pnpm run verify-runtime-closure` proves this package's dependency manifest supplies every required workspace peer.
2. **Deploy** — a pnpm legacy deploy materializes the production runtime closure (the `dsh` CLI, every in-box plugin's built `lib`, the Web frontend `dist`, node-pty, and the keyless replay provider) into a symlink-free staging directory.
3. **Electron restore** — when the pinned Electron distribution is missing (fresh installs fetch it through Electron's reviewed postinstall, `allowBuilds`), the package's own install script restores it before rebuild and validation.
4. **Native rebuild** — node-pty is rebuilt against the pinned Electron version's ABI (`@electron/rebuild`), then validated by loading it inside the Electron binary; the macOS `spawn-helper` is staged beside the rebuilt addon with its executable bit.
5. **Bundle** — electron-builder ([`electron-builder.yml`](electron-builder.yml)) assembles the `.app`: the asar carries only `lib/main.js` and the sandboxed preload, while the runtime closure ships as real files under `Contents/Resources/runtime/`.

The installed application starts without a system Node.js or DSH CLI: Electron main forks the application binary itself as the DSH child (`ELECTRON_RUN_AS_NODE`), resolves the CLI, Web dist, and PTY helper from `Contents/Resources/runtime`, and hands the child its user-data directory as the working directory ([`src/packaged-runtime.ts`](src/packaged-runtime.ts) owns this layout). Native modules and the PTY helper therefore never sit inside an archive. The harness home stays the shared `~/.dsh`, so the packaged app and the CLI see the same sessions, profiles, and configuration.

## Native macOS window

The macOS `BrowserWindow` uses `hiddenInset` title-bar chrome, fixed inset traffic lights, a transparent client surface, and Electron's AppKit-backed `under-window` vibrancy with `visualEffectState: followWindow`. A dedicated 44-pixel title strip is draggable; links, form controls, buttons, editable content, and overlays remain interactive no-drag regions. The client root sits absolutely below the strip (`inset: 44px 0 0`), so the strip never overlays or pushes content. System light/dark changes flow through Electron's `nativeTheme`, and macOS Reduce Transparency switches the client to a near-opaque light or dark surface while retaining visible keyboard focus. Supported Electron APIs satisfy the layout, so the application includes no custom native visual-effect addon.

## Packaged acceptance

`apps/desktop/tests/packaged-smoke.e2e.ts` launches the installed bundle in four modes. `--inspect-native-window` creates a real `BrowserWindow` and reports the configured title-bar, traffic-light, transparency, vibrancy, focus, drag-region, appearance, and reduced-transparency state for automated assertions. `--accept-native-window` opens a visible window over the assembled renderer and asserts the active → inactive → active focus transitions, minimize/restore, the drag-strip input attempt, the 44-pixel title-strip layout with no content obstruction, computed drag/no-drag regions, and the keyboard path into the real composer. `--record-native-window --smoke-replay <file>` plus `DSH_DESKTOP_FRAMES_DIR` records truthful renderer frames of launch, focus transitions, the drag-strip attempt, keyboard operation, minimize/restore, light/dark appearance, and the replayed tracer turn in the assembled UI, then restores `nativeTheme.themeSource` to its entry value. `--smoke --smoke-replay <file>` asserts the full keyless tracer bullet — Session creation, a terminal-backed `echo TERMINAL_OK` tool turn with ordered streamed events, no TCP listener, and quiescent quit — plus the absence of surviving owned processes. The suite self-skips when the bundle is absent; the macOS CI job packages first and sets `DSH_DESKTOP_SMOKE_REQUIRED=1`, which turns absence into a hard failure.

## Limitations

- The tracer bullet ships unsigned and un-notarized; release-grade signed, notarized, cross-arch (x64) artifacts are a later ticket.
- `--smoke` refuses to run without an explicit `DSH_HOME`, so it can never touch the machine owner's real `~/.dsh`.
- `capturePage()` sees renderer pixels only: recorded frames exclude native traffic-light glyphs, and synthetic input cannot move the native window the way an OS pointer drag does. The recording pair — frames plus the inspected configured and observed native window state — is the evidence; a machine with screen-recording permission can replace the frames with an OS-level capture without changing the assertions.
