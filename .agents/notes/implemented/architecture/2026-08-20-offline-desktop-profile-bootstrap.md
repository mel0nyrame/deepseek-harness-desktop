# Agent Note: Offline ownership-aware desktop profile bootstrap

Status: implemented

English | [中文](2026-08-20-offline-desktop-profile-bootstrap.zh.md)

## Problem

The desktop product needs one stable profile assembled from embedded official and desktop packages without relying on a source checkout or startup network access. Treating the complete profile manifest as generated product state would overwrite user-installed plugins and unrelated configuration during repair, while accepting stale product entries could boot an incompatible or base-only tree.

## Decision

The desktop bundle owns the ordered product prefix in the `desktop` profile: `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and `@dsh-desktop/bundle`. It also records the exact embedded component versions under `dsh.desktop.components` and keeps the Loader's `cordis.yml` composition root empty. Bootstrap validates every component before any write, creates missing profile support files, and repairs only this product-owned state. Bundles outside the owned prefix, dependencies, other manifest keys, and an existing `cordis.patch.yml` remain user-owned.

The desktop bundle patch disables browser-owned startup rows and appends desktop connection, native, and UI providers. The official Connection row remains in the graph as the browser module supplier for the [desktop IPC provider](2026-08-25-desktop-ipc-connection-provider.md); its Host plugin stays unresolved without WebServer, while the desktop provider owns `ctx.connection`. `composeDesktopProfile()` resolves the generated manifest and each embedded bundle through the published profile loader, then returns both the effective Loader entries and a config dump produced by the boot-equivalent patch algorithm. Application lifecycle wiring remains with the tracer-bullet integration slice; the bundle owns the bootstrap operation and composition policy it calls.

## Verification

`pnpm exec vitest run tests/profile-bootstrap.test.ts` passes all eleven focused bootstrap and real-composition checks, and the workspace passes `pnpm run typecheck`.

## Alternatives considered

**Replace the complete profile from a template.** Rejected because repair would destroy user-installed plugins, patch bytes, and unrelated configuration.

**Accept any resolvable bundle version.** Rejected because an application embedding mutually incompatible official packages could create a profile that fails later with an indirect Loader error.

**Fall back to the base bundle when a component is missing.** Rejected because a partial profile hides installation damage and produces a product without its expected Web and desktop capabilities.

## Consequences

A fresh home can be initialized entirely from embedded packages, and repeated valid bootstrap performs no write. Malformed JSON and a non-object manifest remain untouched with a path-specific diagnostic; unresolved or incompatible components are named before profile creation. Focused tests cover creation, idempotence, repair, user-owned JSON bytes, malformed state, component failures, and the ordered profile-loader composition and config dump.
