# Agent Note: Offline ownership-aware desktop profile bootstrap

Status: implemented

English | [中文](2026-08-20-offline-desktop-profile-bootstrap.zh.md)

## Problem

The desktop product needs one stable profile assembled from embedded official and desktop packages without relying on a source checkout or startup network access. Treating the complete profile manifest as generated product state would overwrite user-installed plugins and unrelated configuration during repair, while accepting stale product entries could boot an incompatible or base-only tree.

## Decision

The desktop bundle owns the ordered product prefix in the `desktop` profile: `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and `@dsh-desktop/bundle`. It also records the exact embedded component versions under `dsh.desktop.components`. Bootstrap validates every component before any write, creates missing profile support files, and repairs only these product-owned fields. Bundles outside the owned prefix, dependencies, other manifest keys, and an existing `cordis.patch.yml` remain user-owned.

The desktop bundle patch disables browser-owned startup rows and appends desktop connection, native, and UI providers. `composeDesktopEntries()` applies the published base and Web patches plus the desktop patch through the official profile composer, making the effective Loader entry tree observable without loading plugins.

## Alternatives considered

**Replace the complete profile from a template.** Rejected because repair would destroy user-installed plugins, patch bytes, and unrelated configuration.

**Accept any resolvable bundle version.** Rejected because an application embedding mutually incompatible official packages could create a profile that fails later with an indirect Loader error.

**Fall back to the base bundle when a component is missing.** Rejected because a partial profile hides installation damage and produces a product without its expected Web and desktop capabilities.

## Consequences

A fresh home can be initialized entirely from embedded packages, and repeated valid bootstrap performs no manifest write. Malformed JSON remains untouched with a path-specific diagnostic; unresolved or incompatible components are named before profile creation. Focused tests cover creation, idempotence, repair, preservation, malformed state, component failures, and the ordered real composed entry tree.
