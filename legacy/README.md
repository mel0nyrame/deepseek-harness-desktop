# legacy/ — frozen pre-decoupling source

This tree is the complete DeepSeek Harness monorepo and pre-decoupling desktop
product, frozen at the migration baseline (commit `a41da0be8f`). It is
preserved for comparison and recovery while the decoupling rebuilds the
product at the repository root, and it is removed by decoupling 9/10.

- **Never edit, build, or depend on it from the product workspace.** It is not
  a member of the root pnpm workspace; ordinary install, typecheck, test,
  build, and packaging never read its package graph.
- It remains a self-contained workspace: its own `package.json`,
  `pnpm-workspace.yaml`, and `pnpm-lock.yaml` describe the frozen monorepo.
- The `legacy` branch is the recovery home of the monolithic product; this
  directory is the in-branch reference copy.
- The product's identity assets (README images under `assets/readme/`, the
  application icon under `apps/desktop/build/`) are preserved at the root; the
  copies inside this tree are frozen duplicates.
