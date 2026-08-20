# AGENTS.md — Examples

`examples/` is the module-resolution root for runnable and test Cordis configs and one pnpm workspace member, not a build target. Root [package.json](package.json) declares packages loaded by configs; leaf manifests are metadata only.

Keep reusable logic and boot glue in packages or apps. Examples own `cordis.yml` wiring, demo artifacts, and real-composition e2e or snapshot scenarios.

- Keyless smokes boot the real config through Loader and assert output plus clean exit.
- Key-backed smokes verify external state, not model claims, and self-skip without `DEEPSEEK_API_KEY`.
- Use `@deepseek-ai/dsh-loader-smoke` for keyless process launch. Keep each checked-in test config under its corresponding example leaf; package-owned drivers and assertions stay package-local.
- In `cordis.yml`, comment only non-obvious wiring, load order, replay, security, and configuration scope.

Use [testing policy](../docs/testing.md) for launch modes and snapshot requirements. The config and test trees are the authoritative scenario inventory.
