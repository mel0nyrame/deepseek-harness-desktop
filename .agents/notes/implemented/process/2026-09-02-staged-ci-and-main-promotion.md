# Agent Note: CI staged by change risk for the main promotion

Status: implemented

English | [中文](2026-09-02-staged-ci-and-main-promotion.zh.md)

## Problem

Decoupling issues #62–#72 turn the repository default branch into the independent desktop product. Until this change, one CI workflow ran the full macOS packaging gate for every pull request regardless of what it touched, no release-grade arm64/x64 signing, notarization, or release-evidence tier existed in this repository, and the promotion of the decoupled workspace to the default branch had no recorded behavior-parity, real-API acceptance, or rollback evidence.

## Decision

CI is staged by change risk across three workflows:

- **`ci.yml` — ordinary pull requests.** Frozen install, typecheck, lint, and the full focused behavior suite on Linux. The suite includes the repository-layout boundary test that pins the Agent Note tree, retained skills, agent documentation, and identity assets, so documentation checks ride the same job. It runs no packaging.
- **`packaging.yml` — app-artifact changes.** Runtime closure verification, macOS package creation, and the installed-application smoke outside the source tree. Pull requests run it when packaging-relevant paths change (`apps/**`, `packages/**`, `runtime/**`, `scripts/**`, `patches/**`, `tests/fixtures/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the workflow itself); every `master` push re-verifies the promoted state; `workflow_dispatch` covers manual runs. It references no secret.
- **`release.yml` — release pull requests and tags.** One artifact per architecture, built natively: arm64 on `macos-15`, x64 on `macos-15-intel`. Pull requests labeled `release` produce ad-hoc preview artifacts with SHA-256 checksums and the packaging log as evidence, and receive no secret. Version tags (`v*`) and manual dispatches produce Developer ID-signed and notarized artifacts; that job fails closed when the signing or Apple credentials are not configured. The workflow never publishes a GitHub release.

Release signing enters packaging through `DSH_DESKTOP_SIGN_IDENTITY` ([`scripts/release-signing.ts`](../../../../scripts/release-signing.ts)). Unset, packaging stays ad-hoc exactly as committed, with every declared signing credential removed from the builder environment. Set, it overrides the electron-builder identity, enables the hardened runtime that Developer ID distribution and notarization require, and re-admits only `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. The workflow exposes those values only to the fail-closed credential guard and the electron-builder step, never checkout, install, tests, or artifact upload; a real identity also makes the Gatekeeper assessment a hard gate. Release mode refuses the ad-hoc marker `-`. The credentials live only in Actions secrets (`MAC_SIGNING_IDENTITY`, `MAC_CERTIFICATE_P12`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and the real-API key never enters any workflow.

`tests/ci-staging.test.ts` pins the staging contract — job sets, path gate, trigger conditions, architecture matrix, secret boundaries, and fail-closed credential guards — so workflow drift fails the ordinary suite. Promotion evidence lives in the bilingual [promotion document](../../../../docs/promotion/promotion.md): the final behavior-parity table with exact recorded results, the protected manual real-API acceptance command with its evidence location, and the promotion checklist (legacy branch, migration baseline tag, revert-based rollback, exact runtime manifest, no force-push).

## Verification

`pnpm run check` passes on macOS arm64 with the staging suite included, and the local packaging gate passes end to end: `pnpm run package` followed by `DSH_DESKTOP_PACKAGE_REQUIRED=1 pnpm run test:package`, with the ad-hoc identity, Gatekeeper verdict recorded (rejected, as every ad-hoc signature is), and zero surviving owned processes. The first labeled [release preview](https://github.com/mel0nyrame/deepseek-harness-desktop/actions/runs/33586031825) passes natively on arm64 and x64; both legs build the DMG, pass the 10-test installed-product gate, write checksums, and upload their evidence. Exact commands and results are recorded in the promotion document. The signed release tier is intentionally unexercised: the credential guard fails a tag build until the Apple credentials are configured.

## Alternatives considered

**Keep one workflow with the packaging job on every pull request.** Rejected: the macOS gate is the expensive tier and documentation-only or package-external changes gain nothing from it, while release signing must never share a trigger surface with pull-request runs.

**Cross-compile both architectures on one arm64 runner.** Rejected: the runtime closure deploys host-architecture natives and native ABI validation under a foreign-architecture Electron would add an untested path. One native runner per architecture reuses the proven packaging gate unchanged. The first x64 preview passes the complete installed-product journey on the Intel runner, so the focus-choreography hang observed in the legacy workflow did not recur.

**Gate the signed job behind a GitHub environment with required reviewers.** Deferred: the environment and its protection rules are a maintainer policy choice; the label/tag condition plus the fail-closed credential guards pin the secret boundary without blocking automation.

## Consequences

Ordinary pull requests stay on the Linux fast tier, packaging cost follows packaging risk, and release evidence exists at two tiers that differ only in credentials. Native arm64/x64 preview evidence is green. The signed tier is defined but unexercised until the Apple credentials are configured; until then, tags fail the credential guard instead of silently shipping ad-hoc artifacts.
