# Agent Note: Independent Desktop product version line

Status: implemented

English | [中文](2026-08-19-independent-desktop-version-line.zh.md)

## Problem

The desktop fork synchronizes the core runtime from upstream while distributing the Electron shell as its own macOS product. A single shared version would make every Desktop release rewrite the root, CLI, Web, and package manifests, creating recurring conflicts with upstream synchronization. Sharing the plain `v<semver>` tag between the core npm family and the Desktop product would also leave one tag unable to identify which version line it names.

## Decision

The core dsh family consists of `packages/*/*`, `apps/cli`, and `apps/web`. Its members and the workspace root retain one shared runtime version and the dormant npm release family uses `dsh-v<semver>` tags. `release:dsh` changes only that core family and the root.

`apps/desktop` is outside the core dsh release family. Its manifest carries the Desktop product version used by Electron Builder, the app bundle, DMG filenames, GitHub Release metadata, and Homebrew. The checks-gated product pipeline uses the plain `v<semver>` tag; release asset preparation derives its expected DMG name from that tag while Electron Builder derives the produced name from the Desktop manifest, so differing versions fail the release. A Desktop release edits only `apps/desktop/package.json` and its exact-version bilingual release notes; core manifests remain on their upstream-synchronized version line.

The release-family regression test discovers the real workspace members and asserts that CLI and Web remain inside the core family while Desktop remains outside it. It also pins the distinct core `dsh-v` tag prefix. The product pipeline's tag-derived asset contract independently pins the Desktop `v` authority.

## Alternatives considered

**Bump every core manifest with each Desktop release.** Rejected because the shell version does not describe the bundled runtime packages, and rewriting the upstream-synchronized manifests creates avoidable conflicts without changing the runtime bytes.

**Keep Desktop in the core family but exempt it only from shared-version validation.** Rejected because `release:dsh`, packing, publish ordering, and tag verification would still treat the shell as one npm publication member. A validation exception would hide the ownership split instead of expressing it.

**Let both version lines use `v<semver>`.** Rejected because one repository tag cannot unambiguously authorize both a core npm release and a Desktop product release when their versions differ.

## Consequences

- Core and Desktop versions may differ by design; this is not a workspace inconsistency.
- Product release commits remain small and upstream synchronization does not need to reconcile product-version churn across core manifests.
- A future npm publication of the core family must use `dsh-v<semver>` and cannot accidentally trigger the Desktop Release workflow.
- A new app joins no release family implicitly; its version and tag ownership require an explicit decision.
