# Agent Note: Checks-gated DSH Desktop releases

Status: implemented

English | [中文](2026-08-19-checks-gated-desktop-release.zh.md)

## Problem

A product tag could build desktop artifacts without proving the exhaustive repository checks, and no single workflow owned bilingual notes, verified downloads, GitHub Release state, and stable Homebrew delivery. The dsh family also proposed a different tag prefix from the product workflows, leaving the release authority ambiguous.

## Decision

The human-created `v<semver>` tag is the product release authority. The semver shape is `v<major>.<minor>.<patch>` with an optional dot-separated prerelease segment; build metadata is not accepted. The dsh release family proposes this plain prefix, while vendor and native families retain their own prefixes and cannot pass dsh-family validation.

CI runs eight exhaustive tag jobs and the `tag checks passed` aggregate. [Release](../../../../.github/workflows/release.yml) listens to the completed CI workflow and proceeds only when its event is a successful push whose head branch is a product tag. The resolve job checks out that tag, validates its shape, and verifies that it points to the CI run's exact head SHA. Every product-repository checkout uses the resolved tag and verifies the resulting commit against that SHA; the GitHub Release and Homebrew push re-check the remote tag immediately before their side effects.

Each version has one committed bilingual highlights file at `.github/release-notes/<version>.md`. Its absence fails the release. English and Chinese highlights remain in one file, followed by GitHub's generated pull-request list. Until the signing posture changes, each version file states that DMGs are ad-hoc signed and not notarized.

The DMG matrix builds arm64 and x64 on native macOS runners. arm64 runs the complete packaged-app smoke; x64 runs the artifact gate and keyless scenario; both architectures verify the mounted DMG with `codesign` and the mounted keyless scenario. The release owns exactly four assets: both DMGs and one SHA-256 file beside each. A re-run edits the release for the same tag and replaces its assets rather than creating a second release.

Stable releases update `mel0nyrame/homebrew-dsh` with `ruby scripts/update-cask.rb <version>` and push the cask through `DSH_TAP_DEPLOY_KEY`. Prereleases skip the Homebrew job. A missing deploy key or unavailable tap fails with a named error after the GitHub Release exists.

This fork publishes no npm sequence. The artifact gates may pack and install workspace tarballs, but neither CI nor the release workflow calls a registry publisher.

Release readiness is launcher-owned: every dsh-family manifest shares one version, and the CLI reads its own package manifest and overlays only that version field onto the API gateway after user configuration, so `host.describe.version` reports the running product without freezing reloadable gateway settings. The timeout package keeps the precise name `@deepseek-ai/dsh-tool-call-timeout-policy`; the alternative `dsh-timeout-guard` is broader than its tool-call policy, so the release-blocking rename marker is removed without changing the established package name.

## Alternatives considered

**Create the release directly from the tag-push workflow.** Rejected because a release job could start before the exhaustive jobs reached their aggregate verdict. `workflow_run` makes the successful CI run the explicit predecessor.

**Keep a standalone desktop artifact workflow.** Rejected because two DMG lanes can drift in smoke coverage, naming, and signing posture. The release workflow is the sole owner.

**Publish prereleases to Homebrew.** Rejected because the cask is the stable update channel. GitHub Pre-releases carry rehearsal builds without moving stable installations.

**Rename timeout policy to `dsh-timeout-guard`.** Rejected because the package enforces `ToolDefinition.timeoutMs` around `tools/execute`, not every timeout in the runtime. The existing name states that boundary exactly.

## Consequences

- A green tag CI run is necessary before any release side effect.
- Release retries are idempotent at the GitHub Release and Homebrew cask boundaries.
- Maintainers add the exact bilingual notes file in the version-bump change before pushing its tag.
- DMGs remain ad-hoc signed and unnotarized; the README and each release notes file disclose the resulting direct-download opening flow.
