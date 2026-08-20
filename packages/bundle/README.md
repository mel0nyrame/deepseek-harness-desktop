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
the Harness home and an embedded-component version resolver.
`composeDesktopEntries()` returns the official Loader entry list assembled from
the base, Web, and desktop bundle patches. The package manifest exposes
`cordis.patch.yml` through `dsh.bundle.patch`.
