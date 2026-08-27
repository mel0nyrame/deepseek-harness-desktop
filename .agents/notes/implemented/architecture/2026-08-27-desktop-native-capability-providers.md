# Agent Note: Desktop native capability providers behind official Service Definitions

Status: implemented

English | [中文](2026-08-27-desktop-native-capability-providers.zh.md)

## Problem

The desktop profile composed the official `@deepseek-ai/dsh-host-directory-picker-native` backend directly, so every workspace directory chooser ran `osascript` child processes inside the DSH Host, and `host.openPath` spawned native open commands from that same child. The Electron shell — the only process that owns windows and a display connection — was not the operating-system adapter, so dialogs appeared without window ownership, cancellation reached neither layer deterministically, and the packaged product carried an osascript/koffi interaction path it never wanted. Directory selection and path opening needed to become desktop-owned Cordis providers (decoupling 6/10) without forking any published Service Definition.

## Decision

- **Directory picking** is the published `ctx.directoryPicker` seam served by `@dsh-desktop/native`'s default export: one stable `native` capability whose `pick(signal)` sends exactly one reverse request through the DSH child IPC boundary.
- **Path opening** is provided by `@dsh-desktop/native/gateway`, which mounts `ctx.apiProxy` through the published `createApiProxy` factory with only the `openPath` closure injected; because an opener is present, `canOpenPath` resolves true with no extra configuration, and all gateway domains keep official behavior. Its exported `inject` copies `ApiProxyService.inject` at load time, so upstream prerequisite changes are inherited verbatim. The desktop bundle patch disables `api-gateway` (whose default opener spawns commands inside the child) and inserts this row.
- **Wire family**: `capability-request` travels child→parent; `capability-response`/`capability-error` travel parent→child. The message shapes live in `@dsh-desktop/connection`'s protocol module next to the existing request/stream vocabulary, keeping one validated parser per direction (`parseDesktopCapabilityRequest`/`parseDesktopCapabilityResponse`). Path fields must be absolute, NUL-free, and bounded at 4,096 UTF-8 bytes before dispatch.
- **Electron main remains the OS adapter** through `DshSupervisor.onNativeActions(handler)`: production installs `dialog.showOpenDialog(window, …)` for picks and `shell.openPath` for opens; the adapter survives child generations and is removed by its disposer when the window closes. Duplicate concurrent request ids answer `duplicate native action id`; requests arriving while no handler is installed answer with a typed error instead of blocking.
- Handler removal and supervisor shutdown abort every action owned by that handler or child, then await each handler promise before teardown completes, so native action cleanup reaches quiescence even when the child exits first.
- **Correlation ownership** lives in the host-side channel shared by both provider rows (one instance per endpoint, refcounted via Cordis effects). Every settlement path removes its correlation first, so late or duplicated shell replies can never revive a completed request; abort performs the same removal locally (Electron offers no programmatic dialog cancel), and disconnect/disposal reject live callers once. `openTextFile` stays on the official child-side implementation intentionally; it spawns a supported command handoff and has no dialog interaction to own.
- **The renderer receives nothing new.** No preload surface, bridge method, stream kind, or capability namespace is exposed to the renderer; the reverse leg exists solely between the bundled child and main.
- **Web deployments are untouched**: `@dsh-desktop/native` imports no Electron API and is mounted only by the desktop bundle patch, whose components are version-pinned in the embedded closure; web profiles keep composing the official auto/native/browse picker rows.

### Verification journey

`--tracer-native <dir>` extends the integrated tracer: the real renderer calls `host.pickDirectory` then `host.openPath` over the real bridge into the real composed child; deterministic scripted answers replace only the OS dialog and shell handoff inside main, and the existing capture machinery asserts layout, state progression (`starting → picked → opening → complete`), visible output pixels, no loopback listener, and full process quiescence.

## Verification

- Unit (`tests/desktop-native.test.ts`, 15 cases): pick/open correlation, absolute-path validation, error surfacing, malformed settlement drops, cancellation including post-settlement revival attempts, disconnect fan-out, async send failures, shared-channel listener lifetime, provider mapping, mismatched-settlement rejection, and provider disposal.
- Supervisor (`tests/desktop-supervisor.test.ts`, +8): routing, duplicate ids, missing/removable handler, malformed-request silence, shutdown abort, adapter persistence across generations with contained undeliverable replies, and reused-id isolation.
- Real composition (`tests/connection-composition.test.ts`, second case): official Client bundle and real `createApiProxy` over the relay, scripted main answers proving pick success, `directory-picker-unavailable` under the native capability gate, open success, and mapped open failure (`path open failed: …`); `inject` equality with `ApiProxyService.inject` is pinned.
- Packaged darwin E2E (`tests/desktop-runtime.e2e.test.ts`): the tracer-native journey above against the assembled runtime.
- Workspace typecheck, oxlint, focused vitest suites, and non-runtime tests pass; the full suite's runtime assembly was not completed in the local environment because its install/deploy phase produced no output and was terminated. The runtime lockfile digest was re-recorded after dependency additions.

## Alternatives considered

**Keep the official `-native` backend in the child.** Rejected: OS dialogs raised without the owning window produce inconsistent focus and sheets, cancellation cannot be delivered deterministically, and the parent decision names Electron main as the operating-system adapter rather than the agent child.

**Extend the controlled upstream patch so `ApiProxyService.Config` accepts injected openers.** Rejected: it widens the release-maintenance obligation of `patches/@deepseek-ai__dsh-client-connection` onto a second package. `createApiProxy` is already a published export designed exactly for host-assembler injection; consuming it needs no patch, and reusing `ApiProxyService.inject` keeps prerequisites synced without copying knowledge.

**Add a child→parent cancellation message for outstanding native actions.** Rejected: `showOpenDialog` cannot be cancelled programmatically, so the message would carry no executable semantics. Local correlation removal already guarantees late settlements are dropped, which is the observable contract.

**Serve picking from the renderer (browser File System Access).** Rejected: it exposes chooser affordances to an untrusted document owner, diverges from the workspace API's server-trust model, and regresses the "Host drives the native experience" composition the seam encodes.

## Consequences

Every workspace adoption now shows an owned, window-attached dialog, and deliverable/settings paths hand off to the dock's default applications from the shell. The DSH child spawns strictly fewer platform commands than rc.8 did. The IPC protocol grew a third message family, but all boundary validation stayed inside the single protocol module both ends already trust. When an upstream release ships an injectable-opener equivalent for the gateway row, the desktop gateway narrows back to zero desktop-specific gateway code; until then the pinned composition keeps the product honest about what runs where.
