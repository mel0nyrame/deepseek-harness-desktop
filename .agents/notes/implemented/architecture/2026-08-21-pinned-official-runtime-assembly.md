# Agent Note: Pinned official runtime assembly

Status: implemented

English | [中文](2026-08-21-pinned-official-runtime-assembly.zh.md)

## Problem

The desktop application needs the complete official DSH runtime without building the official source tree, reading the frozen monorepo graph, requiring a user-installed Node.js, or downloading product components at application startup. Published DSH packages use compatible dependency ranges, so a direct dependency on the CLI alone does not prove that one coherent release, its native helpers, and any required patches ship together.

## Decision

The committed `runtime/runtime-manifest.json` is the machine-readable authority for the embedded runtime. It records product identity, the `desktop` profile, the no-runtime-download guarantee, package layout, the DSH release, upstream source commit, official entry packages and files, target-specific native artifacts, controlled patches, and reproducible build inputs. The root lockfile records the complete published closure, while `scripts/assemble-runtime.ts` deploys that closure into a direct child of the ignored `.artifacts` directory and rejects unsafe outputs, missing entries, version drift, unsupported platforms, missing native artifacts, undeclared patches, source-relative dependency protocols, package entries or JavaScript imports that escape their package, and links outside the closure. Assembly and packaging subprocesses do not receive credential-bearing environment variables.

The first runtime uses `@deepseek-ai/dsh@0.1.0-rc.8` as its official entry. `node-pty@1.2.0-beta.15`, its architecture-specific addon and macOS `spawn-helper`, and `koffi@3.1.0` are explicit macOS and Linux x64 platform dependencies. The node-pty patch is committed with its digest, rationale, upstream reference, test owner, and deletion condition. Electron 43.4.0 runs the CLI with `ELECTRON_RUN_AS_NODE=1`; packaging embeds the generated closure as real application resources under `Contents/Resources/runtime/`.

## Verification

`tests/runtime-assembly.test.ts` checks the manifest as one contract, assembles the closure while the upstream submodule is uninitialized, verifies every declared entry and current-platform artifact, rejects unsafe dependency specifications, missing entries, escaping JavaScript imports, and external symlinks, and launches the staged CLI from outside the source tree through Electron's Node behavior. Source-contract, assembled-runtime, and packaged-application evidence remain separate.

The focused runtime suite runs with `pnpm exec vitest run tests/runtime-assembly.test.ts`, and the workspace typechecks with `pnpm run typecheck`.

## Alternatives considered

**Build the runtime from `upstream/` or the `legacy` branch.** Source builds would restore the repository-layout and release coupling this product removes. The submodule and historical branch remain inspection inputs only.

**Install official packages on first launch.** Runtime downloads would require package-manager and network availability on user machines and could resolve a different closure from the shipped product.

**Treat the lockfile as the complete runtime contract.** The lockfile proves package resolution but does not state entrypoint obligations, source provenance, native helper placement, patch rationale, or patch deletion conditions.

**Bundle only the CLI JavaScript entry.** Dynamic plugins, Web assets, native addons, and executable helpers are part of the runtime and must be represented and verified explicitly.

## Consequences

A desktop release maps to one auditable DSH runtime and can stage it without the official source submodule. Runtime upgrades must update the manifest, exact deploy-root dependencies, patch records, and lockfile together. The generated closure is intentionally large and platform-specific; it remains a reproducible build artifact rather than committed source. The controlled node-pty patch remains release debt until an official package supplies the required helper-path seam.
