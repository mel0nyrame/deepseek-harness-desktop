# AGENTS.md — landlock-run

This workspace builds the small, auditable Landlock self-restrict-then-exec launcher, its per-platform prebuilt npm packages, and the JavaScript entry package that resolves and probes them. Coordinate package-family changes with harness consumers.

## Runtime safety

- Fail closed: if ruleset creation or kernel enforcement fails, exit non-zero without executing the wrapped command.
- Runtime binaries and entry packages accept no environment override selecting the launcher. `NALR_*` is build/test orchestration only; inject test choices by parameter.
- Keep kernel UAPI definitions in the C source and link only libc, statically through musl.
- Treat [the CLI contract](docs/cli-contract.md) as the cross-repository compatibility interface. Change grammar, exit codes, or report lines only with a version bump and changelog entry; consumers parse through the entry package.
- Do not add an install-time build fallback. Missing platform packages must make the consumer probe fail closed.

## Packaging

- Keep package metadata, `prebuilds.json`, and the [support matrix](docs/support-matrix.md) synchronized. `scripts/github-matrix.mjs` is the only CI/release matrix derivation.
- Platform packages contain prebuilt binaries without JavaScript; the entry package resolves paths and verifies enforcement through a functional probe.
- Build each architecture natively in CI. Pack platform tarballs with `npm pack`; the pnpm path loses executable bits. Pack-time and installed-copy verifiers must remain in the release flow.
- Keep generated `bin/`, `lib/`, `dist/`, `.release/`, and `*.tsbuildinfo` out of git. Root `.gitignore` owns exclusions because nested ignores can drop tarball payloads.

Use this workspace's `package.json` for commands and [docs/](docs/) for architecture, release, naming, support, and public API details. User-facing docs are English.
