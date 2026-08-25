# `@dsh-desktop/bundle`

The desktop bundle and profile bootstrap role. This package composes the
`desktop` profile over the official base and Web bundles, mounts
desktop-owned plugins, and creates, validates, and repairs product-owned
profile entries on first and later launches without touching user overlays,
user-installed plugins, or unrelated profile configuration.

The `desktop` profile name is product identity. Bootstrap validates embedded
component versions before writing, repairs only product-owned manifest fields,
and fails with the unresolved component name instead of falling back to a
generic profile. The profile patch and unrelated manifest fields remain
user-owned.

`bootstrapDesktopProfile()` creates or repairs the profile after its caller supplies
the Harness home and an embedded-component version resolver. It returns whether
it wrote the manifest or one of the three support files (`cordis.patch.yml`,
`cordis.yml`, and `pnpm-workspace.yaml`). Missing support files are created;
the product-owned `cordis.yml` stays an empty composition root, while existing
user patch and workspace files remain untouched. A valid repeat call writes nothing.
Invalid JSON, a non-object manifest root, non-string bundle entries, and missing
or incompatible embedded components throw before product-owned manifest fields
are written.

Manifest repair changes only `dsh.profile.bundles` and
`dsh.desktop.components`. User bundles retain their relative order after the
product prefix, and dependencies plus unrelated JSON fields retain their
original bytes. Existing `cordis.patch.yml` bytes also remain user-owned.
`composeDesktopProfile()` resolves that repaired manifest
through the published profile loader and returns both the effective Loader
entries and the config dump. Composition throws when profile, bundle, or patch
resolution, reading, parsing, or validation fails. Product startup integration
calls bootstrap before loading the profile; the tracer-bullet application slice
owns that lifecycle wiring. The package manifest exposes `cordis.patch.yml`
through `dsh.bundle.patch`.
