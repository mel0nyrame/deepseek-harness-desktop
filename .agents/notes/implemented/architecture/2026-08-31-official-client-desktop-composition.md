# Agent Note: Official Client composition over the desktop transport

Status: implemented

English | [中文](2026-08-31-official-client-desktop-composition.zh.md)

## Problem

The desktop runtime needs the published DeepSeek Harness conversation, workspace, input, settings, and primitive Client contributions without starting the published WebServer or browser startup path. Disabling those browser-owned rows also prevented the published Client module registry from existing because its Host plugin required WebServer statically. Loading a separate desktop frontend would duplicate product behavior, while exposing the published frontend through a loopback listener would undo the desktop transport boundary.

## Decision

- The desktop profile composes the published `modules` row and the full published Client roster. It disables `web-startup`, `webserver`, `web-runtime`, `client-hmr`, and the published `connection` row. The explicit `@deepseek-ai/dsh-client-ui-directory-picker-native` row consumes the desktop Host picker through the unchanged workspace API; `@dsh-desktop/ui` contributes the desktop setting and asset route.
- The exact-version `@deepseek-ai/dsh-client-modules@0.1.0-rc.8` patch makes WebServer mounting optional: the module registry depends only on Loader, while route and index injection are installed inside `ctx.inject(['webServer'], ...)`. Web profiles retain their routes when WebServer is present. The patch is deleted when a published release provides the same optional-host behavior.
- `@dsh-desktop/ui` reads the published `@deepseek-ai/dsh-web-frontend` distribution and the paths advertised by the published Client module graph. Its `/ui/asset` logical RPC returns bounded, typed, base64 asset responses through the existing loopback-authority Host connection registrar; it opens no socket and owns no second module registry.
- Electron registers `dsh` as a standard, secure, fetch-capable scheme before app readiness. The `dsh://app` protocol handler accepts only GET and HEAD for that exact authority, forwards path requests through the supervised child connection, validates the complete response envelope, and cancels the Host request when navigation cancels. Normal product windows load `dsh://app/index.html`; only that root document is trusted as a main frame.
- Client-owned desktop sources are compiled into the published `window.__ModuleLoader__` factory format. The desktop connection artifact prepends the exact published `@deepseek-ai/dsh-client-connection` Client factory before registering `@dsh-desktop/connection`, so the published browser controller remains the sole implementation while its WebServer-dependent Host row stays absent. The UI artifact relies on the React factory already present in the official graph.
- The asset source rejects malformed encoding, traversal segments, unknown plugin ids, and paths outside the published frontend root. The product document sets a self-only content policy for assets and connections; inline boot scripts and `unsafe-eval` remain enabled because the published frontend's Client expression evaluator requires them. Electron still runs the document with sandboxing, context isolation, no Node integration, and the narrow preload bridge.
- `SettingsProvider.register()` attaches the desktop namespace to the injected contribution's Cordis fiber, while an explicit effect owns `/ui` RPC registration. Electron removes the protocol handler with the window lifecycle, and the existing supervisor cancellation and shutdown bounds own in-flight asset requests.

## Verification

- Asset and protocol tests cover boot-manifest injection, CSP placement, frontend and plugin content types, traversal and unknown-path rejection, authority and method filtering, malformed Host envelopes, cancellation, and HEAD responses.
- Profile and module tests pin the published roster, optional WebServer injection, explicit native picker Client contribution, browser-safe Client bundles, and disposer behavior. A real in-memory `SettingsProvider` test unloads the UI Host fiber and verifies that its namespace disappears.
- The darwin packaged-runtime test launches the real Electron app without an API key or listener. It verifies the exact basename returned by the native picker, opens input-trigger suggestions, observes a paced replay while it is still streaming, observes the completed Bash row and answer, submits a second turn that deterministically exhausts replay and renders a terminal error, and changes the desktop settings contribution.
- That journey writes seven distinct PNG frames and an `evidence.json` manifest containing each filename, byte length, and SHA-256 digest. The test checks the manifest against the files, the durable settings document, and complete child-process quiescence. Runtime tests assemble the artifacts produced by the root test build directly, so they cannot overwrite Client factories while parallel tests inspect them. The focused macOS gate `pnpm run build && pnpm exec vitest run tests/desktop-runtime.e2e.test.ts -t "composes the official Client"` completes with one passing test and five filtered tests.
- The runtime manifest pins the package patch and lockfile digest, so a dependency update cannot silently discard the optional WebServer seam.

## Alternatives considered

**Start the published WebServer on loopback.** Rejected because the packaged application already has an authenticated, cancellation-aware IPC carrier. A listener would add port ownership, origin, rebinding, and shutdown concerns solely to move bytes between processes on one machine.

**Build a desktop-specific conversation frontend.** Rejected because conversation ordering, tool rows, workspace adoption, settings sections, input triggers, and primitive rendering would acquire a second implementation. Published Client contributions are the product surface; desktop code supplies only transport, native capability, chrome, and settings seams.

**Read all frontend files directly from Electron main.** Rejected because the Host's Client module registry owns the authoritative graph and plugin artifact paths. Routing through its logical RPC keeps package resolution and Cordis disposal in the composed runtime and prevents the shell from becoming a second runtime assembler.

**Leave the published Connection row enabled only for its Client artifact.** Rejected because the row also declares a WebServer-dependent Host plugin. Prepending the exact published Client factory to the desktop artifact preserves that browser code without admitting an unresolved or accidental Host transport into the desktop graph.

## Consequences

The desktop product renders the exact published Client surface over one custom origin and the existing IPC connection, with no loopback listener and no renderer access to files or Electron APIs. Upstream Client additions flow through the published profile and module graph instead of requiring desktop component copies. The design adds one exact-version client-modules patch and a deliberate `unsafe-eval` CSP exception; both are visible maintenance obligations that must be revalidated when the published frontend or module host changes.
