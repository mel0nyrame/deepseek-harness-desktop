# Domain docs

English | [中文](domain.zh.md)

Engineering skills use this repository's domain documentation when exploring or changing code.

## Before exploring

1. Read the root `CONTEXT-MAP.md` when it exists.
2. Follow the map to each `CONTEXT.md` relevant to the requested area.
3. Read relevant system-wide ADRs under `docs/adr/`.
4. Read relevant context-specific ADRs at the location declared by `CONTEXT-MAP.md`.

Proceed silently when a file or directory does not exist. The `domain-modeling` skill creates domain files lazily when terminology or a durable decision is resolved.

## Multi-context layout

```text
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                         # System-wide decisions
└── packages/
    └── <context>/
        ├── CONTEXT.md               # Context glossary
        └── docs/
            └── adr/                 # Context-specific decisions
```

`CONTEXT-MAP.md` is the source of truth for context locations. A context may align with a package group, one package, or another cohesive product domain; do not infer context ownership from directory depth alone.

Create files and directories only when they have content. `CONTEXT.md` is a glossary of domain terms and relationships, not an implementation specification. Record an ADR only for a decision that is costly to reverse, surprising without its rationale, and chosen through a material trade-off.

## Use canonical vocabulary

Use terms defined in the relevant `CONTEXT.md` in issue titles, specifications, hypotheses, refactoring proposals, and test names. Avoid synonyms that the glossary distinguishes or rejects.

When a required concept is absent, reconsider whether the repository already uses another term. If the gap is genuine, resolve it through `domain-modeling` and update the appropriate glossary.

## Surface ADR conflicts

Explicitly identify output that contradicts an applicable ADR. Name the ADR and explain why reopening the decision may be justified instead of silently overriding it.
