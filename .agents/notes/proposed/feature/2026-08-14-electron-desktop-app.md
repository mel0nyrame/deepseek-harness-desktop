# Agent Note: Electron desktop application with a bundled DSH runtime

Status: proposed

English | [中文](2026-08-14-electron-desktop-app.zh.md)

## Problem

### Problem Statement

DeepSeek Harness already has a React client and a local Node.js Host with filesystem, subprocess, PTY, persistence, plugin, and language-server capabilities. Using that product through a browser still requires the operator to start and manage the Host separately, and it cannot provide a fully integrated macOS window, application lifecycle, native blur, or installation experience.

The desktop product must bundle DSH instead of assuming a separately installed CLI or Node.js runtime. It must preserve the existing client and Host contracts while isolating the Electron window lifecycle from model execution, plugins, PTYs, and process trees. The first release optimizes for a native macOS experience without committing the initial implementation to first-day Windows and Linux parity.

## Proposal

### Solution

Ship an Electron application that reuses the built React client and includes a production DSH runtime. Electron is selected because the Host and its native dependencies are already implemented in TypeScript and Node.js; adopting Tauri would retain a Node sidecar or require a Rust migration without removing the difficult packaging and lifecycle work.

The Electron main process owns windows, menus, system dialogs, path opening, signing-facing application metadata, and supervision of one app-scoped DSH child process. The DSH child owns the real Cordis composition, sessions, model calls, tools, plugins, PTYs, persistence, and subprocess trees. A Host failure may end or restart the DSH child, but it must not block or terminate Electron's main event loop.

The renderer loads the existing production client from packaged files and uses an Electron adapter for the existing client connection interface. A narrow preload bridge carries validated unary requests and long-lived event streams through Electron IPC. Development Web builds retain their HTTP and WebSocket adapters; desktop packaging does not start a browser-facing HTTP server.

The first product target is a signed and notarized macOS application for Apple silicon and Intel Macs. Its window uses the macOS inset title-bar treatment, native traffic lights, Electron's AppKit-backed vibrancy, and transparent client surfaces. A native addon is deferred unless the supported Electron APIs cannot provide the required region-specific visual effect.

### User Stories

1. As a macOS user, I want to install and open one signed application without installing Node.js or the DSH CLI so that I can start using the harness like an ordinary desktop product.
2. As a macOS user, I want the application to start its bundled DSH runtime automatically so that I do not need to manage a background terminal process or local server.
3. As a returning user, I want my workspaces, sessions, settings, credentials references, and transcripts to use the existing DSH persistence behavior so that moving from the Web client does not create a second product model.
4. As an agent user, I want prompts, tool calls, approvals, questions, and streaming model output to behave like the existing client so that the desktop shell does not reduce harness capability.
5. As a terminal-tool user, I want interactive shells and their streamed output to work inside the packaged application so that bundling does not break `node-pty` or its macOS helper.
6. As a workspace user, I want folder selection and path-opening actions to use native macOS dialogs and applications so that privileged desktop actions feel integrated with the operating system.
7. As a macOS user, I want inset traffic lights, a draggable custom title area, and native vibrancy behind translucent surfaces so that the application feels consistent with current macOS software.
8. As a user, I want closing the application to stop the bundled DSH runtime, PTYs, and descendant processes so that no invisible agents or shell commands remain after quit.
9. As a user, I want a clear recoverable state when the bundled Host fails to start so that a broken configuration or native dependency does not leave a blank window.
10. As a user, I want the desktop shell to detect an unexpected Host exit and offer a controlled restart so that a plugin or runtime failure does not require force-quitting the application.
11. As a security-conscious user, I want Web content to have no direct Node.js or unrestricted Electron access so that rendering model-generated content cannot invoke local capabilities outside the DSH protocol.
12. As a client maintainer, I want Web and Electron to share the same connection interface and React modules so that product behavior fixes do not fork into two frontends.
13. As a Host maintainer, I want desktop system integration to remain outside the agent loop so that windowing concerns do not become model-runtime concerns.
14. As a release engineer, I want architecture-specific packaged smoke tests and signing/notarization checks so that a build cannot ship when its DSH runtime or native PTY addon fails after installation.
15. As a contributor, I want development mode to preserve the existing Web workflow while allowing the Electron shell to target a local development build so that desktop work does not slow unrelated client development.

### Implementation Decisions

- Use Electron rather than Tauri for the first desktop implementation. This keeps the existing Node.js Host and native modules in their supported execution environment and avoids introducing Rust solely as a shell integration layer.
- Bundle DSH with the application and run it as a dedicated child process. Do not run the long-lived Cordis Host, model loop, plugin runtime, or PTYs inside the Electron main process.
- Own one DSH child per application instance in the first release. The main process controls startup, readiness, unexpected-exit reporting, restart, and terminate-and-join shutdown.
- Reuse the existing React/Vite client without a desktop-specific fork. Desktop-only behavior enters through existing client plugin slots and the connection adapter.
- Load packaged renderer assets locally. The packaged application uses the Electron IPC carrier and does not expose a loopback HTTP server; Web development and deployment continue to use HTTP and WebSocket carriers.
- Keep protocol semantics in the existing abstract client. The Electron adapter implements the transport operations only: unary request/response, client responses to Host requests, the multiplexed Session stream, and the Host event stream.
- Use dedicated long-lived IPC channels or transferred message ports for event streams. Do not model streaming as repeated unary IPC calls.
- Expose only a small preload interface for request, response, subscription, cancellation, and connection lifecycle. Enable context isolation, disable renderer Node integration, and validate messages at the existing wire parser before dispatch.
- Keep Electron main as a router and supervisor rather than a second implementation of ApiProxy. The DSH child remains the authority for sessions, tools, persistence, settings, credentials, and agent behavior.
- Implement native directory selection and path opening in Electron main. The DSH Host reaches those operations through an explicit reverse request instead of giving the renderer general Electron access.
- Preserve the existing model-visible logging rule. Moving messages over Electron IPC changes the carrier, not the Session events or reconstruction behavior.
- Use `hiddenInset` title-bar behavior, configurable traffic-light placement, active-window vibrancy, and transparent CSS surfaces on macOS. Keep text and controls opaque enough to satisfy contrast and accessibility requirements.
- Treat a region-specific `NSVisualEffectView` addon as a measured fallback. It is introduced only if a prototype proves that Electron's supported vibrancy controls cannot produce the required layout.
- Package native modules and helper executables outside archives where runtime loading or execution requires real filesystem paths. Validate Electron ABI compatibility before selecting the production Electron version.
- Produce signed and notarized macOS artifacts for arm64 and x64. Universal packaging is optional; both architectures must pass the same installed-application smoke test.

### Testing Decisions

The primary acceptance seam is the installed desktop application. A keyless test launches the packaged Electron app, waits for the real bundled DSH child to become ready, creates a Session through the renderer, runs a terminal-backed scenario, observes streamed output in the conversation, quits the app, and verifies that the DSH process, PTY, and descendant process tree have all exited. This is the highest existing product seam that exercises the new shell without replacing DSH behavior with mocks.

Supporting tests apply the reusable Client Connection carrier contract (`packages/client/connection/tests/carrier-contract.client.ts`) to the Electron adapter. The transport-neutral harness controls logical stream delivery, disconnect, and live-subscription accounting without importing browser or Electron primitives. It covers unary success and failure envelopes, Client responses to Host requests, the ordered mux and Host streams, readiness, cancellation, malformed messages, disconnect, bounded subscription lifetime, and cleanup through the same `IApiClient` interface used by React callers; Electron-specific tests separately cover IPC mechanics.

Supervisor tests exercise startup success, startup timeout, configuration failure, unexpected child exit, one controlled restart, application quit during startup, and terminate-and-join cleanup. Process-tree assertions use real child processes on macOS for lifecycle claims that mocks cannot prove.

macOS GUI acceptance runs against the real Electron window and records the user-visible workflow required by the repository GUI policy. It checks title-bar controls, drag and interactive regions, light and dark appearance, reduced-transparency fallback, focus, keyboard access, and stable rendering. A screenshot may document vibrancy, but an automated assertion must inspect the configured native window state because pixels alone cannot distinguish native blur from a translucent color.

Release validation installs or mounts each architecture's signed artifact, passes Gatekeeper assessment, launches it outside the source tree, exercises the bundled Host and PTY path, and verifies notarization metadata. A source-mode test does not substitute for this artifact check.

### Out of Scope

- Windows and Linux desktop releases in the first delivery.
- Rewriting DSH, subprocess management, PTY handling, or plugin execution in Rust.
- Running the Host inside the renderer or Electron main process.
- A remote-host connection mode or exposing the bundled Host over the network.
- Mobile applications, browser extensions, or a second desktop-only frontend.
- Multi-window and multi-Host orchestration.
- Automatic updates, background launch at login, menu-bar-only operation, and cloud synchronization.
- A custom native title bar or a macOS addon before the Electron vibrancy prototype demonstrates a concrete limitation.
- Changing Session formats, model-visible events, tool semantics, or Web deployment behavior merely to support Electron.

### Further Notes

The current architecture already names Electron IPC as the intended non-Web carrier and keeps browser-safe protocol types separate from the Node Host. The desktop work should deepen that existing connection module rather than add a parallel desktop protocol.

The first vertical prototype is deliberately narrow: launch the bundled DSH child, complete its readiness handshake, create one Session, execute one terminal command, stream the result, and quit with full process cleanup. Native-module loading, helper placement, code signing, and quit semantics must be proven in this prototype before broader window chrome or installer work proceeds.

The desktop shell is a product assembly, not a new capability seam. If system integration later needs multiple implementations, the variability belongs behind a small Host-facing interface with Electron and test adapters; it does not belong in the agent loop.

## Alternatives considered

**Use Tauri with a Node sidecar.** Rejected for the first implementation because it preserves the Node distribution and process-supervision work while adding Rust, a second IPC layer, and a second desktop build toolchain. The smaller shell binary does not materially shrink a product that must still ship the DSH runtime and native dependencies.

**Rewrite the Host in Rust for Tauri.** Rejected because it duplicates the existing plugin runtime, process management, protocol, and native integrations and would delay the desktop product without improving its first user workflow.

**Run DSH inside Electron main.** Rejected because model execution, plugin failure, PTY load, and teardown would share the process responsible for windows and operating-system events. A stalled or crashing Host could freeze or terminate the desktop shell, and cleanup ownership would be ambiguous.

**Start the existing Web server on loopback and point Electron at it.** Rejected for the packaged product because it opens an unnecessary network listener and retains browser transport and origin concerns. The existing client interface supports a direct IPC adapter. The Web server remains useful in development and ordinary Web deployments.

**Build a separate native macOS frontend.** Rejected because it forks the established React client and its plugin presentation model. Electron supplies the required macOS window effects while retaining one client implementation.

**Embed all renderer and native dependencies in one archive.** Rejected as a requirement because native modules and PTY helpers may need executable filesystem paths. Packaging must follow runtime loading constraints rather than archive purity.

## Acceptance criteria

- A clean macOS machine can install and launch a signed, notarized build without a separately installed Node.js runtime or DSH CLI.
- The renderer reaches the bundled Host only through the preload bridge and existing typed protocol; renderer Node integration is disabled and context isolation is enabled.
- The application can create and reopen Sessions, send prompts, handle Host interactions, and display ordered streaming events through the Electron carrier.
- A terminal-backed keyless scenario runs through the packaged DSH runtime on arm64 and x64 artifacts.
- Normal quit, quit during startup, and Host crash recovery leave no owned DSH, PTY, or descendant process alive.
- Startup and runtime failures produce an actionable desktop state instead of a blank or indefinitely loading window.
- Native folder selection and path opening work through Electron main without exposing general Electron or Node primitives to the renderer.
- The macOS window has inset traffic lights, correct draggable regions, supported native vibrancy, light/dark appearance behavior, and an accessible reduced-transparency fallback.
- The existing Web client continues to use its current HTTP/WebSocket development and deployment path without Electron dependencies entering browser bundles.
- The packaged-app acceptance test, carrier contract tests, supervisor lifecycle tests, GUI evidence, and signing/notarization checks pass.

## Risks

Electron increases application size and memory use. The decision accepts that cost because retaining the existing client and Node Host reduces implementation risk and duplicated product logic.

Native dependencies can fail because of Electron ABI, architecture, archive placement, hardened-runtime, or signing rules. The vertical prototype and per-architecture artifact smoke tests must resolve these failures before feature expansion.

Two IPC hops add lifecycle and backpressure complexity. Stream channels need bounded queues, cancellation, and deterministic closure so a slow or disconnected renderer cannot retain Host resources indefinitely.

Native vibrancy can reduce contrast and behaves differently with system appearance, inactive windows, accessibility settings, and future macOS releases. The product must provide opaque-enough tokens and a reduced-transparency fallback rather than treating one screenshot as the contract.

Child-process isolation prevents Host failures from taking down Electron main, but it does not provide a security sandbox for DSH. Tool permissions and subprocess sandbox policy remain DSH responsibilities; the desktop shell must not imply stronger confinement than the configured harness provides.

## Implementation status

Issues #1 and #2 shipped the first vertical slice through the development path:

- The reusable Client Connection carrier contract ([`carrier-contract.client.ts`](../../../../packages/client/connection/tests/carrier-contract.client.ts)) locks unary, reverse-response, mux-stream, and host-stream semantics plus readiness, ordering, cancellation, malformed-message, disconnect, and subscription-lifetime behavior; both the HTTP/WebSocket carrier and the new Electron carrier pass it unchanged.
- The development tracer bullet runs via `pnpm run dev:desktop`: the Electron shell ([`apps/desktop`](../../../../apps/desktop)) supervises one dedicated DSH child (`--profile desktop`, the shipped `base + web-app + desktop-app` overlay). The overlay ([`packages/bundle/desktop-app`](../../../../packages/bundle/desktop-app)) disables every browser transport row (`web-startup`, `webserver`, `web-runtime`, `client-hmr`), pins the native directory picker, and mounts the child runtime that serves the existing API gateway and event streams over one IPC channel — no loopback HTTP listener participates.
- The renderer reaches DSH only through the sandboxed, context-isolated preload bridge; [`DesktopApiClient`](../../../../packages/client/connection/src/client/desktop-api-client.ts) implements the existing `IApiClient` surface over it. The Host-side Connection and client-modules plugins mount their Web transports only when a WebServer is present, so the Web development workflow is unchanged.
- A keyless real-composition e2e ([`apps/desktop/tests/real-composition.e2e.ts`](../../../../apps/desktop/tests/real-composition.e2e.ts)) forks the real desktop profile, creates a Session, replays a recorded `bash` tool turn, asserts the ordered streamed `TERMINAL_OK` result through the mux stream, and verifies terminate-and-join quit leaves no descendant process.

Issue #3 shipped the packaged application slice:

- `pnpm --filter @deepseek-ai/dsh-desktop run package` assembles an unsigned macOS bundle for the host architecture through four stages ([`scripts/package.ts`](../../../../apps/desktop/scripts/package.ts)): closure verification (`verify-runtime-closure` now checks both deploy manifests), a pnpm legacy deploy of the production runtime closure into a symlink-free staging directory, an Electron-ABI rebuild of node-pty validated inside the Electron binary, and the electron-builder assembly ([`electron-builder.yml`](../../../../apps/desktop/electron-builder.yml)).
- The installed layout keeps the shell in the asar and the whole runtime closure as real files under `Contents/Resources/runtime/`; Electron main forks the application binary itself as the DSH child (`ELECTRON_RUN_AS_NODE`), resolves the CLI, Web dist, and PTY helper from that closure, and hands the child its user-data directory ([`packaged-runtime.ts`](../../../../apps/desktop/src/packaged-runtime.ts) owns the contract). No system Node.js or DSH CLI participates.
- A keyless packaged-app smoke (`apps/desktop/tests/packaged-smoke.e2e.ts`) launches the installed bundle with `--smoke`, reruns the tracer bullet through the bundled runtime, and asserts zero exit and quiescence of the owned process tree; a failure-path case feeds it a missing replay file and asserts the same quiescence on a non-zero scenario verdict. The macOS CI job packages first and turns a missing bundle into a hard failure.
- The desktop package manifest doubles as the deploy-root manifest: its dependency list is the packaged runtime closure, enforced by `verify-runtime-closure`.
- The CI-trigger PR exposed two branch-level defects, fixed in this slice: the Connection and client-modules optional-WebServer mounts now travel by captured `ctx.get()` service values (direct property access threw "cannot get property webServer without inject" behind a fiber boundary on Node 22), and `electron` joins `allowBuilds` with a packaging restore step so fresh installs always carry the pinned distribution the pipeline validates.

Issue #4 shipped the native macOS window slice:

- The real `BrowserWindow` uses `hiddenInset` chrome, fixed inset traffic lights, a transparent client surface, and Electron's AppKit-backed `under-window` vibrancy with `visualEffectState: followWindow`. The client root sits absolutely below the 44-pixel strip (`inset: 44px 0 0`), so the strip never overlays or pushes the content column.
- A dedicated 44-pixel title strip is draggable while links, controls, editable content, and overlays remain no-drag regions. Electron `nativeTheme` updates system appearance and Reduce Transparency state; the accessibility fallback uses near-opaque light or dark surfaces and preserves visible keyboard focus.
- Packaged acceptance launches `--inspect-native-window` to inspect a real `BrowserWindow`'s configured options, actual native background/focus state, computed drag regions, and all renderer appearance/transparency combinations. `--accept-native-window` opens the assembled renderer in a visible window and asserts the active → inactive → active focus transitions, minimize/restore, the drag-strip input attempt, the 44-pixel title-strip layout with no content obstruction, computed drag/no-drag regions, and the keyboard path into the real composer. `--record-native-window --smoke-replay <file>` plus `DSH_DESKTOP_FRAMES_DIR` records truthful renderer frames of launch, focus transitions, the drag-strip attempt, keyboard operation, minimize/restore, light/dark appearance, and the replayed tracer turn in the assembled UI, and restores `nativeTheme.themeSource` to its entry value in `finally`; the packaged smoke in the same acceptance suite separately proves the headless tracer-bullet workflow.
- This host's macOS lacks screen-recording and accessibility-automation permissions, so the recorded frames come from `webContents.capturePage()`: they exclude native traffic-light glyphs, and synthetic input cannot move the native window the way an OS pointer drag does. The evidence pair is the frames plus the inspected configured and observed native window state; a permissioned machine can replace the frames with an OS-level capture without changing the assertions.
- Supported Electron APIs satisfy the required layout, so no native visual-effect addon is present.

Issue #5 shipped the carrier-hardening slice:

- [`DesktopApiClient`](../../../../packages/client/connection/src/client/desktop-api-client.ts) retains at most 256 parsed frames per logical stream. Overflow clears the queue, cancels the physical subscription, and terminates with an error; caller cancellation discards queued frames before closing. The shared zod wire schemas still parse every server-request envelope and mux/Host payload before Connection dispatch.
- The desktop child runtime validates every parent command before business dispatch. Each stream awaits its child-IPC send callback before reading another frame, so native-channel backpressure bounds in-flight work and preserves accepted-message ordering; transport failure aborts the source and is reported without being mislabeled as backpressure. Electron main validates every child message and admits ready-handshake bundle paths only when they resolve to real `.js` files beneath the configured runtime root, while preload validates lifecycle notifications again before renderer delivery.
- Electron main acknowledges renderer delivery through a bounded relay, retaining only a finite in-flight/queued window per stream; overflow or a duplicate open notification cancels the child subscription and emits ordered `error`/`end` closure. Preload uses one notification dispatcher and sends one acknowledgement per event. Each logical `mux` and `host` stream admits at most one active subscription.
- [`DshSupervisor`](../../../../apps/desktop/src/supervisor.ts) owns renderer request and subscription correlations. Cancellation releases them immediately; main-frame reload/navigation, renderer crash/destruction, child IPC disconnect/exit/error, application stop, and startup failure each settle their owned resources without leaving a live stream or child process. Listener exceptions are contained inside their dispatchers.
- The sandboxed, context-isolated renderer still receives only the narrow preload bridge, and the Web product retains its HTTP/WebSocket carrier with no Electron runtime dependency. The transport-only change adds no model-visible input or output; the shared Electron/Web carrier contract, focused client/runtime/preload/supervisor suites, real desktop composition, and installed-window tracer scenario pin the behavior.
- The installed-window recording scenario exposed three acceptance-driver races at the product's own seams. The hero picker's menu renders nothing until the workspace baseline and the directory-flow occupant mount, so the driver's re-clicks were toggling the picker closed instead of retrying; it now clicks until the trigger's `aria-expanded` reports a genuinely open picker and never re-clicks an open one, then waits for the on-screen row. Second, `connectWorkspace` mints a fresh session whenever its reuse scan cannot yet see a blank session, so pre-creating a session over the wire raced that scan and split the turn into a session the driver never polled; the submitted turn was durable all along, in the picker-minted session. The driver no longer pre-creates a session and instead discovers the exactly-one session the real journey opened through `workspace.list` (bounded poll, loud failure on zero or many), which the focused `acceptance.spec.ts` suite pins. Third, the driver's select-all plus `insertText` replacement raced the app's own frames after the synthetic click, occasionally concatenating instead of replacing; the driver now flushes animation frames before selecting and verifies the exact draft with retries before sending.

Issue #7 shipped the Host recovery slice:

- [`DesktopLifecycle`](../../../../apps/desktop/src/lifecycle.ts) owns one explicit state machine — `starting`, `running`, `recovering`, `failed`, `stopping`, `stopped` — with a single quit owner. Startup timeout or configuration failure lands on the status page with the child's recent stderr tail and Restart/Quit actions; one unexpected exit of a running Host triggers exactly one automatic restart, and a failed recovery returns to the failed state with the same actions. A per-generation ready flag keeps a late child exit after a reported startup failure from being misread as a crash.
- [`process-tree.ts`](../../../../apps/desktop/src/process-tree.ts) implements the POSIX shutdown ladder over `ps -axo pid=,ppid=,pgid=,lstart=,stat=,command`: a snapshot is live descendants plus process-group members, `lstart` defeats pid reuse, zombies are excluded, and group signals are deduplicated with an own-group guard. [`DshSupervisor`](../../../../apps/desktop/src/supervisor.ts) keeps a pre-exit ownership snapshot refreshed once per second while the child runs, requests SIGTERM, waits a bounded interval, escalates to SIGKILL, sweeps and verifies the tree, and rejects with `left N surviving process(es)` listing pid and command when anything remains; the lifecycle reports that as an actionable `cleanup-incomplete` failure.
- The status page served at `dsh://app/status.html` exposes only Restart and Quit through the preload bridge, which is available only on that exact frame. Manual `restart()` is allowed only from the failed phase, and is withheld after an incomplete cleanup so a replacement generation cannot orphan the previous tree.
- Real coverage: [`process-tree.spec.ts`](../../../../apps/desktop/tests/process-tree.spec.ts) and [`lifecycle.spec.ts`](../../../../apps/desktop/tests/lifecycle.spec.ts) drive deterministic tables and fake spawns; [`process-tree.e2e.ts`](../../../../apps/desktop/tests/process-tree.e2e.ts) proves graceful termination, SIGTERM-immune escalation, reparented-descendant and orphan sweeps, and real node-pty cleanup on macOS; [`recovery.e2e.ts`](../../../../apps/desktop/tests/recovery.e2e.ts) walks the development recovery journey; the packaged `--record-recovery` acceptance records startup-failed, restarting, session-recovered, and tracer-settled frames and asserts no surviving installed-app process.

Issues #6 and #8 remain open for interaction parity and native path actions. Release-grade signed, notarized arm64/x64 artifacts remain issue #9.
