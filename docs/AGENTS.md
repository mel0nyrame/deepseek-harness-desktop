# AGENTS.md — Documentation

These rules apply to human-facing documentation under `docs/`. Use [dsh-doc-standards](../.agents/skills/dsh-doc-standards/SKILL.md) for placement and validation, [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md) for editorial decisions, and [dsh-trim-cot-leakage](../.agents/skills/dsh-trim-cot-leakage/SKILL.md) for reasoning-transcript leakage. Agent Notes follow their [own format](../.agents/notes/README.md).

## Document structure

Give each fact one owner. A document covers its own subject in detail, summarizes direct children only by purpose and high-level behavior, and links to deeper owners. Classify it as either:

- a tutorial: ordered work leading to an observable outcome, with prerequisites introduced before dependent concepts;
- a reference: lookup-oriented current behavior within an explicit scope.

Split substantial mixtures. An incident [postmortem](postmortem/README.md) is a reference whose chronology records evidence.

## Documentation tiers

| Owner | Content |
| --- | --- |
| Root or subtree `AGENTS.md` | Short standing rules for every task in that scope, with conditional links to detail |
| [architecture.md](architecture.md) | Composition, core runtime flow, seams, and extension points |
| [subsystems/](subsystems/README.md) | Type definitions, semantics, and generated Cordis APIs |
| [Agent Notes](../.agents/notes/README.md) | Decisions, alternatives, rationale, and verification obligations |
| [cookbook/](cookbook/adding-a-package.md) | Step-by-step contributor procedures |
| [user/](user/index.md) | Published product guidance |
| Package README | Package configuration, semantics, failures, limitations, extension points, and model-visible effects |
| [development.md](development.md) | Contributor setup and daily workflow |

Generated catalogs and generated regions are edited through their source or generator, never by hand.

## Writing rules

- Describe current state. Route change stories to Agent Notes, postmortems, commits, or PRs.
- One physical line per paragraph; code blocks, tables, and lists retain their structure.
- Public behavior changes update their owning README and JSDoc. Reshaped documented types update the owning subsystem page.
- Every non-trivial change includes an Agent Note; mechanical local edits are exempt ([scope](../.agents/notes/README.md#when-to-write-one)).
- Bilingual pairs change together. Update the counterpart directly using [terminology](i18n/terminology.md), then run `pnpm run verify-translation-pairing --write <pair>`; only explicit user invocation may run `dsh-translate-docs` ([contract](i18n/README.md)).
- Preserve behavior, failure, timing, ownership, modality, exceptions, and consequences. Remove narration, repetition, decoration, and code restatement.
- Use direct technical names. Reserve `seam`, `contract`, and literal boundaries for their defined meanings.
- Cross-references use relative Markdown links with valid fragments. Search inbound references before moves; move sources and links atomically.

## Wordcount budgets

[`scripts/doc-budgets.manifest.json`](../scripts/doc-budgets.manifest.json) budgets every effective `AGENTS.md` and other accretion-prone standing docs. When a file exceeds its ceiling, relocate detail to its owner, then condense; raise the ceiling only when required content cannot move. Keep at least 5% headroom when lowering a passing ceiling.

## Validation

Run `pnpm run doc-sync`, `pnpm run lint`, and `git diff --check`. Paired changes also re-record and verify each edited pair. Never edit frozen `.agents/notes/archived/` content.
