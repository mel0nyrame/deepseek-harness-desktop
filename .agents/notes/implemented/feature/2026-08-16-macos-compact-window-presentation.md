# Agent Note: Compact macOS desktop window presentation

Status: implemented

English | [中文](2026-08-16-macos-compact-window-presentation.zh.md)

## Problem

The published DeepSeek Harness client targets a browser-shaped frame. Its collapsed sidebar retains a narrow rail, and it has no contract for Electron traffic lights, native vibrancy, macOS Reduce Transparency, window focus, or native full screen. DeepSeek Harness Desktop needs those platform behaviors without owning a copy of the official sidebar or layout packages.

## Decision

The Electron shell owns native window policy and publishes only the renderer facts needed to present it. On macOS, the `BrowserWindow` requests a `1280×840` initial size with a `900×640` minimum, uses `hiddenInset` title-bar chrome, traffic lights at `(16, 14)`, an under-window vibrancy material, and a transparent background. A context-isolated preload bridge exposes the validated Light, Dark, and System preference plus the effective appearance, Reduce Transparency state, focus, and full-screen state. The main process accepts messages only from the window's current renderer and removes IPC, native-theme, focus, and full-screen listeners when the window closes.

The child connection sends `connection-ready` only after its IPC listener is installed. The supervisor waits for that signal before issuing `host.describe`, so a slower Client graph cannot lose the one readiness request during process startup.

The desktop UI package remains an additive Client and Host contribution. It registers the window controls in `shell.overlay` and the glass preference in `settings.general.item`; the official sidebar continues to render its labels, counts, conversations, and actions. The first chrome row places the published panel primitive beside the native traffic lights, and a second row renders the published whale, deepseek, and HARNESS wordmark. Stable slot attributes and desktop-owned body attributes drive a small CSS layer that marks the title row as draggable, keeps every control no-drag, and reserves conversation-header clearance while the sidebar is closed. The collapsed reveal button remains outside the zero-width sidebar, including in native full screen.

The Client and Host share only a dependency-neutral settings contract. The Client entry does not import the Host plugin or its Settings and Schemastery dependencies, so the browser bundle retains the product's capability boundary.

The Host owns the `ui-sidebar-glass-macos.enabled` setting. It defaults to enabled and is offered only when the native bridge reports macOS and the namespace is writable. The renderer combines that preference with the effective theme and Reduce Transparency: enabled glass uses the native material, while a disabled preference or an accessibility override selects an explicit opaque light or dark surface. The accessibility override never rewrites the saved preference.

Two exact-version UI patches preserve published ownership. The `@deepseek-ai/dsh-client-ui-layout@0.1.0-rc.8` patch changes the closed sidebar track from 56 pixels to zero, retains the last dragged width, and publishes stable collapsed and resolved-width frame state. The `@deepseek-ai/dsh-client-ui-sidebar@0.1.0-rc.8` patch adds one stable header attribute so desktop chrome can replace only that row without a positional selector. The runtime manifest records each digest, upstream source, tests, and removal condition. Each patch can be removed when its published package provides the same contract.

## Alternatives considered

**Copy the official sidebar and layout packages.** Rejected because it would duplicate labels, counts, interaction behavior, and future upstream changes. Published primitives, stable slots and frame state, plus one minimal versioned header hook are sufficient for the desktop-owned behavior.

**Keep the official 56-pixel collapsed rail.** Rejected because the desktop reveal control can remain available without reserving sidebar width.

**Read Electron state directly from renderer code.** Rejected because native theme and window lifecycle belong to the main process. A narrow preload bridge preserves context isolation and gives the host one place to validate messages and dispose listeners.

**Persist the visible material instead of the user preference.** Rejected because Reduce Transparency is a temporary system fact. Persisting its result would lose the user's glass choice when the accessibility setting changes.

## Consequences

- BrowserWindow creation, appearance changes, focus, native full screen, resizing, and quit continue through Electron's native window lifecycle.
- Light, Dark, System, glass, and opaque states project into stable body attributes without coupling the shell to generated CSS-module names.
- Sidebar expansion restores the last dragged width; collapse resolves the grid track and native material to zero while preserving the official sidebar registration.
- Narrow windows auto-collapse the sidebar, permit a manual reopen, and return to the retained wide-window preference after resize. Windowed and full-screen reveal controls remain reachable while conversation headers and view tabs clear the native chrome.
- The evidence journey records both display bounds and work area but validates `BrowserWindow` outer bounds against display geometry. Initial sizing and later wide resizes must reach the requested or display-limited width and a height between the platform minimum and the requested or display-limited maximum; the work area cannot cap the native frame because macOS excludes system UI from it while the window bounds include native chrome.
- Every Client registration, stylesheet, theme subscription, settings subscription, and native bridge subscription has an explicit disposer.
- The native tracer asserts real macOS window capabilities, traffic-light position, resize, active → inactive → active focus, theme, Reduce Transparency, and full-screen transitions before emitting `NATIVE_WINDOW_EVIDENCE`. It also checks computed drag/no-drag regions and sends input attempts to both. A permission-gated acceptance path publishes absolute targets to its parent driver; externally injected CoreGraphics pointer events must move the drag surface and must not move the no-drag control.
- The visible tracer surface projects the same validated native facts as the contribution. It captures dark, light, and System PNG frames after compositor settlement and requires the dark/light images to differ. A separate offscreen Electron fixture runs the formal desktop registration, loads the exact published sidebar component and stylesheet, and records expanded dark glass, collapsed light glass, and expanded opaque frames. `webContents.capturePage()` intentionally excludes native traffic-light glyphs, which remain covered by the native window assertion.
- Focused tests cover native bridge validation and teardown, surface projection, theme and accessibility transitions, Host and Client contributions, contribution disposal, and the installed layout patch. The sidebar integration test loads the exact published sidebar Client, exercises its toggle, and preserves its official labels, child slots, and workspace/count occupant. Repository layout tests preserve the icon and visual assets by path and content.

## Verification

On 2026-09-05, `pnpm run check` passed typecheck, lint, all workspace builds, and 178 of 182 tests in 31 files; three installed-product cases without a packaged app and one Accessibility-permission-gated OS-pointer case were skipped. `pnpm run package` produced an integrity-verified arm64 app and DMG, and `pnpm run test:package` passed all 10 installed-product checks. `DSH_DESKTOP_REQUIRE_OS_DRAG=1 pnpm exec vitest run tests/desktop-runtime.e2e.test.ts -t 'moves only the computed drag surface'` separately covers the real drag/no-drag case. `pnpm run test:layout` covers the repository-layout boundary. Focused behavior is exercised by `tests/desktop-native-window.test.ts`, `tests/desktop-ui-surface.test.ts`, `tests/desktop-ui-runtime.test.ts`, `tests/desktop-ui-host.test.ts`, `tests/desktop-ui-client.test.ts`, `tests/desktop-layout-patch.test.ts`, `tests/desktop-sidebar-integration.test.ts`, `tests/desktop-ui-visual.e2e.test.ts`, and the real Electron journeys in `tests/desktop-runtime.e2e.test.ts` and `tests/desktop-packaged.e2e.test.ts`.
