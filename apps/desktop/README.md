# `@dsh-desktop/shell`

The Electron shell of DSH Desktop. This package owns windows, the preload
bridge, context isolation, renderer Node restrictions, application lifecycle,
supervision of the dedicated DSH child process, native macOS handoff, and
packaging. It does **not** own DSH sessions, tools, persistence, model
execution, PTYs, or Cordis composition: the bundled DSH child owns the runtime,
and desktop capabilities enter through desktop-owned Cordis provider plugins
(`@dsh-desktop/bundle`, `@dsh-desktop/connection`, `@dsh-desktop/native`,
`@dsh-desktop/ui`).

The application icon lives at [`build/icon.svg`](build/icon.svg) (source) and
[`build/icon.png`](build/icon.png) (packaging input). These assets are product
identity: their content, names, and locations are preserved across the
decoupling and must not be renamed, moved, or replaced.

Implementation of the shell lands with the integrated tracer bullet
(decoupling 5/10); until then this package declares the role and its boundary.
