# AGENTS.md — Desktop product packages

These rules apply to the `@dsh-desktop/*` packages: `apps/desktop`
(`@dsh-desktop/shell`) and `packages/*` (bundle, connection, native, ui).

## Ownership and dependency direction

- Desktop-owned packages use the `@dsh-desktop/*` namespace. Never introduce
  a desktop-owned package under the official `@deepseek-ai/*` namespace.
- Dependencies between desktop packages use `workspace:*`. Dependencies on
  official packages (`@deepseek-ai/*`) are exact published versions from the
  registry — never `workspace:` protocol, `file:`/`link:` references, or
  anything resolved through `legacy/`. Third-party dependencies are exact
  versions too.
- Nothing outside `@dsh-desktop/*` may depend on a desktop package. In
  particular the frozen `legacy/` tree must never gain a dependency on this
  workspace, and this workspace must never read the `legacy/` package graph.
- Every capability enters through a Cordis plugin and a declared capability
  seam (Service Definition / Provider / Consumer). The Electron shell is a
  host boundary, not a second agent runtime.

## Frozen inputs

- `legacy/` is the frozen official monorepo source, preserved for comparison
  and recovery until the decoupling removes it. Never edit, build, or depend
  on it from the product workspace; the `legacy` branch is its recovery home.
- `upstream/` is the pinned official source submodule for inspection and
  compatibility work only. Ordinary install, typecheck, test, build, and
  packaging must never require it.
- `assets/readme/*` and `apps/desktop/build/icon.*` are product identity:
  content, names, and locations are preserved; never rename, move, or replace
  them.

## Conventions

- Registrations are effects through `ctx.effect()` or `ctx.on()`; registry
  `register()` methods return disposers. Waterfall listeners call `next()` to
  delegate.
- Trust TypeScript inside typed same-process calls. Validate parser/config,
  model/tool JSON, durable/file, worker, process, and wire inputs.
- Tests describe behavior, not correctness. Visible behavior needs a real
  keyless snapshot plus focused tests.
- TypeScript stays strict. Files end with one trailing newline.
