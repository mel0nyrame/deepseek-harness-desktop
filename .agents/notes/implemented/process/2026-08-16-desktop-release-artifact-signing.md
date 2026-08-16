# Agent Note: Desktop artifacts ship ad-hoc signed; Developer ID notarization stays gated on a paid Apple account

Status: implemented

English | [中文](2026-08-16-desktop-release-artifact-signing.zh.md)

## Problem

Issue #9 asks for signed and notarized arm64 and x64 desktop artifacts. Notarization is a server-side Apple flow that only paid Apple Developer Program members can run (App Store Connect API key or Apple ID plus an app-specific password); no self-signed, ad-hoc, or third-party substitute exists, so the issue cannot be satisfied verbatim without credentials this project does not hold. Two parts are independent of the account and were missing regardless: the packaging had no dmg target, and it had no cross-arch path (the script rebuilds node-pty against the host ABI, so an arm64 machine cannot produce x64 artifacts).

## Decision

Ship the credential-free tier now and leave the paid tier one configuration away:

- **Ad-hoc signing in the pipeline** — `electron-builder.yml` sets `identity: '-'` (ad-hoc, no Apple credentials) and `hardenedRuntime: false` (the hardened runtime would reject the `ELECTRON_RUN_AS_NODE` child loading the rebuilt node-pty addon without a `disable-library-validation` entitlement). Targets are now `dmg` and `dir`. The yml documents the two fields a future Developer ID setup fills (identity name and `notarize.teamId`).
- **Evidence gate in the package script** — `scripts/artifact-evidence.ts` (unit-tested by `apps/desktop/tests/package.spec.ts`) defines the checks every produced artifact faces before the pipeline reports success: `codesign --verify --deep --strict` and `hdiutil verify` for the dmg are hard gates, `codesign -d` records the identity, and `spctl --assess` records the Gatekeeper verdict — enforced only when a Developer ID identity (not `-`) signs, because macOS rejects every ad-hoc signature via spctl even for an unquarantined local build.
- **Cross-arch via CI matrix** — `.github/workflows/desktop-release.yml` builds, signs, verifies, and uploads the dmg on `macos-26-intel` (x64) and `macos-26` (arm64), triggered by workflow_dispatch and `v*` tags. The arm64 leg runs the full packaged-app suite against the workspace `.app`; the x64 leg runs only the artifact gate plus the keyless scenario because the Intel VM's focus choreography hangs the GUI journeys, and the keyless scenario is the release criterion that leg must prove. Both legs mount the dmg and run the keyless scenario against the mounted artifact. Only the keyless scenario runs from the image: renderer first-paint timing assertions flake off a read-only HFS mount. The builder config declares `publish: null` — CI uploads the dmg as a run artifact — because electron-builder's publish manager otherwise auto-detects the GitHub provider on Actions runners (a `GITHUB_TOKEN` in the environment is enough) and demands credentials while building the dmg update info. The matrix is deliberately not a pull-request gate: the existing PR lane already smokes one arm64 runner, and the matrix doubles macOS runner minutes on a private repository.
- **Gatekeeper scope, stated honestly** — Gatekeeper assesses only quarantine-flagged launches: a locally built artifact opens unassessed, and `spctl --assess` rejects every ad-hoc signature outright, so the pipeline records that verdict instead of enforcing it. A downloaded copy carries `com.apple.quarantine` and needs the one-time right-click → Open. Homebrew cask delivery strips quarantine. Removing the gate for downloads requires Developer ID signing plus notarization; `spctl --master-disable` is never a distribution answer.

## Alternatives considered

- **Entitlements instead of `hardenedRuntime: false`** — keeping the hardened runtime with a `disable-library-validation` plus `allow-jit` entitlements file would make the ad-hoc build shape-match the future Developer ID build. Rejected: the runtime hardening buys nothing without a trusted identity, and the entitlements file adds signing failure modes the evidence gate would then have to own.
- **Universal (lipo) binary from the arm64 host** — rejected: node-pty and its `spawn-helper` are per-architecture native builds and cross-arch node-gyp on macOS is fragile; the CI matrix exercises both architectures natively.

## Consequences

- Local `package` runs produce a signed `.app` plus `.dmg` and fail loudly when signature or image verification regresses; Gatekeeper verdicts stay recorded evidence until a Developer ID identity is wired in.
- x64 artifacts require the CI workflow (an Intel runner); arm64 builds on any arm64 host.
- The `--skip-build` and `--dry-run` flags never worked: `parseArgs` reports hyphenated option names verbatim while the script read camelCase keys, so every CI run rebuilt the workspace twice. Fixed in the same change because the release workflow's `package:skip-build` step depends on it.
- The notarization half of issue #9 is tracked as issue #28, blocked on Apple Developer Program credentials; wiring it in touches only `electron-builder.yml`.
- The READMEs state the quarantine behavior: a downloaded artifact still shows the unidentified-developer gate until issue #28 lands.
