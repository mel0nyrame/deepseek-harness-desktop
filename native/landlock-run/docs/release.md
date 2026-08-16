# Release

Pre-1.0: treat this as a release checklist, not a stability policy.

## Versioning

The launcher workspace root and its three public packages share one version. Run the bump helper from the repository root:

```sh
pnpm --dir native/landlock-run release:bump patch          # or minor / major / x.y.z
```

It updates `native/landlock-run/package.json` and every `native/landlock-run/packages/*` manifest, refreshes the repository root lockfile (`--ignore-scripts --lockfile-only`), and runs `release:verify`. Explicit versions accept full semver including prereleases (`pnpm --dir native/landlock-run release:bump 0.0.0-test.0`); `release:publish` puts prerelease versions under the `next` dist-tag, so `latest` never points at a test build. Keep `workspace:*` dependencies in source; pnpm converts them to concrete versions during pack.

Version bumps are normal source changes: open a release PR (or commit) with the launcher manifests and root lockfile, merge it, then create the matching `landlock-run-vX.Y.Z` tag from that commit. The namespace avoids colliding with release tags for other package families in the repository. Before publishing, run `release:verify` from the tagged commit and confirm that every launcher package version matches the tag.

```sh
pnpm --dir native/landlock-run release:commit patch        # bump + stage + commit in one command
git tag landlock-run-v0.0.2
```

## Preflight

```sh
pnpm install --frozen-lockfile
pnpm --dir native/landlock-run build:ts
pnpm --dir native/landlock-run typecheck
pnpm --dir native/landlock-run test:entry
```

On a Linux host, also rehearse the pack path locally:

```sh
pnpm --dir native/landlock-run build:native
pnpm --dir native/landlock-run test:launcher
node native/landlock-run/scripts/pack-release.mjs native/landlock-run/.release/npm --current-platform-only
node native/landlock-run/scripts/verify-packed-install.mjs native/landlock-run/.release/npm --current-platform-only
```

## Publish

Release from native Linux x64 and arm64 hosts. Each host builds and verifies its own launcher, then transfers the resulting `packages/<platform>/bin/` directory to one clean checkout. In that checkout, build TypeScript, run `release:verify`, assemble the transferred platform directories under `.release/prebuild-artifacts/prebuild-<package>/`, verify the complete payload, and pack it:

```sh
pnpm --dir native/landlock-run build:ts
pnpm --dir native/landlock-run release:verify
pnpm --dir native/landlock-run release:assemble-prebuilds .release/prebuild-artifacts
pnpm --dir native/landlock-run release:verify -- --prebuilds
pnpm --dir native/landlock-run release:pack dist/npm
NALR_REQUIRE_LANDLOCK=1 pnpm --dir native/landlock-run release:verify-packed-install dist/npm
pnpm --dir native/landlock-run release:publish dist/npm
```

`release:publish` reads `publish-order.txt`, publishes platform packages before the entry package, skips an already published tarball only when its registry integrity matches, and fails if the same version has different bytes. Authenticate npm in the local environment before the final command. Always pack through `pack-release.mjs`, never `pnpm publish` directly: pnpm's pack path strips the launcher's executable bit (see [packaging.md](packaging.md)). A current-platform rehearsal remains available with `--current-platform-only`, but it cannot produce a complete multi-platform release.

Do not commit `.npmrc` files with tokens or registry overrides.
