# Agent Note: The independent desktop workspace boundary

Status: implemented

English | [中文](2026-08-20-desktop-workspace-decoupling.zh.md)

## Problem

The repository originally combined the complete DeepSeek Harness monorepo with the Electron desktop product. Packaging and development therefore inherited the official repository's source layout, workspace graph, and release process even though the desktop application needs only one exact published DSH runtime plus product-owned host capabilities.

## Decision

The repository root is the independent DSH Desktop workspace. It contains the Electron shell in `apps/desktop`, the `@dsh-desktop/*` Cordis packages in `packages/*`, and no pre-decoupling monorepo source tree. The `legacy` branch retains the repository snapshot from before removal, including the frozen monorepo under its `legacy/` subtree, for historical comparison and recovery. The root `upstream/` gitlink pins the matching official source release for inspection and compatibility work only; ordinary install, build, test, and packaging do not initialize or read it.

Desktop packages use the `@dsh-desktop/*` namespace and `workspace:*` only between desktop-owned packages. Official and third-party runtime packages are exact published versions. The Electron shell remains a host boundary rather than a second agent runtime: sessions, models, tools, persistence, PTYs, and product composition remain in the plugin-composed DSH child.

The packaged application contains a minimal asar bootstrap that loads the complete, verified closure from `Contents/Resources/runtime/`. The runtime closure rejects source-relative dependency protocols, missing package entries, package-entry and JavaScript-import escapes, and links outside its root; it records product identity and the `desktop` profile and contains its native addons and helpers. The macOS CI job checks out without submodules, builds the application and DMG, and runs the installed application from outside the source tree with a Node network guard that fails direct socket and fetch attempts.

The current Agent Notes, retained skills, repository rules, and product identity assets remain at the root. Historical documents referenced by current guidance use commit-pinned paths into the snapshot's `legacy/` subtree rather than requiring a local source copy.

## Verification

`tests/repository-layout.test.ts` rejects any tracked `legacy/` path and pins the `upstream/` gitlink and product workspace. `tests/runtime-assembly.test.ts` verifies closure independence, entry existence, JavaScript import containment, and unsafe-link rejection. `tests/desktop-package.test.ts` verifies product, package, signing, and runtime evidence contracts. `tests/desktop-packaged.e2e.test.ts` copies the application with macOS bundle semantics to a temporary location, verifies the embedded runtime root and filesystem evidence from the official client UI, blocks direct Node network APIs, verifies that the runtime tree remains unchanged, exercises Session streaming, PTY and native providers, and requires deterministic process cleanup. `.github/workflows/ci.yml` makes packaging and installed-product smoke tests a required macOS job.

## Alternatives considered

**Keep the pre-decoupling source under `legacy/` indefinitely.** A frozen local copy was useful while behavior was being ported, but retaining thousands of unrelated files after the runtime and provider seams shipped would preserve ambiguity about supported build inputs and enlarge every checkout.

**Build the runtime from `upstream/`.** This would restore source-layout and release-process coupling. The submodule is evidence for compatibility work, not a production input.

**Bundle the workspace dependency graph inside asar.** Electron-builder can discover dependencies above its staging project and create a second, incomplete graph. A dependency-free bootstrap plus one real-filesystem runtime closure gives every DSH import and native helper a single resolution root.

**Download components on first launch.** Runtime installation on user machines would require network and package-manager availability and could resolve a closure different from the released application.

## Consequences

The product can be cloned, checked, packaged, installed, and exercised without either official source tree. Releases carry a comparatively large platform-specific runtime and require rebuilding the native closure for each target architecture. Historical implementation details are less convenient to browse offline, but remain available on the `legacy` branch; current contracts must live in the product workspace rather than relying on that history.
