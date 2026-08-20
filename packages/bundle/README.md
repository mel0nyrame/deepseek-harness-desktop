# `@dsh-desktop/bundle`

The desktop bundle and profile bootstrap role. This package composes the
`desktop` profile over the official base and Web bundles, mounts
desktop-owned plugins, and creates, validates, and repairs product-owned
profile entries on first and later launches without touching user overlays,
user-installed plugins, or unrelated profile configuration.

The `desktop` profile name is product identity and stays stable across the
decoupling. Bootstrap implementation lands with decoupling 3/10; runtime
assembly over exact official published packages is decoupling 2/10.
