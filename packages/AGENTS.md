# AGENTS.md — Packages

Read [architecture.md](../docs/architecture.md) before changing package relationships and [testing.md](../docs/testing.md) before choosing evidence. Package names, groups, and current paths live in [packages/README.md](README.md), not here.

- Service packages default-export their service class. Function plugins named-export `name`, `inject`, `Config`, and `apply` without a default export ([failure mode](../docs/postmortem/0001-acp-default-export-drops-inject.md)).
- Optional services use `ctx.get(name)`; reserve `ctx.<name>` for declared injections.
- Product-visible plugins need a non-unit real-composition test through Loader and an assembled app or process. Mock only external or nondeterministic inputs; assert durable, model-visible, or user-visible output.
- Under `ctx.agents.withInitiator()`, recover the Agent at orchestration entry, derive its Session, and capture it in operation-local helpers. Keep Agent and Session explicit at lifecycle, authority, persistence, worker/process, and wire interfaces.
- One asynchronous operation has one lifecycle controller or transaction. Independent readiness, cancellation, disposal, reservation, or settlement requires an independent owner.
- Design Service Definitions for all current Consumers. Keep tool-schema, Loader, UI, transport, and provider-specific behavior with the Consumer or provider ([capability guidance](../docs/cookbook/adding-a-package.md)).
- Require a current owner and production need for each abstraction, option, copy, state machine, and compatibility path. Enforce a decision in the operation that makes it.
- Publish notifications and derived state only after commit. Apply bounds where the complete emitted or retained result, including wrappers and metadata, is known.
- Model-facing prompts, schemas, results, and diagnostics use task concepts rather than UI, transport, or implementation terms. Pin stable text verbatim and dynamic output with snapshots.
- Registry contributions include disposal coverage. Every package owns `./invariant`; assert an owned runtime relationship or provide a package-specific reason that none exists ([rules](../docs/subsystems/invariants.md)).
- Package TypeScript config follows [the project layout](../docs/development.md#typescript-project-layout): one aggregate, `src` to `lib/types`, and references for every workspace dependency plus runtime invariants. `api/remotes` is the only split compiler face.
- Keep runtime code out of `src/types.ts`; put tests under package-level `tests/`.
- Update package README and public JSDoc with behavior. READMEs use the canonical [Model Experience](../docs/cookbook/adding-a-package.md#4-write-the-package-readme) and limitations sections.

Use the [package creation cookbook](../docs/cookbook/adding-a-package.md) for scaffolding, naming, configuration, documentation, and verification rather than copying an existing package blindly.
