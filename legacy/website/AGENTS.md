# AGENTS.md — Documentation website

Use [`dsh-doc-site-sync`](../.agents/skills/dsh-doc-site-sync/SKILL.md) for website changes.

`website/` owns VitePress configuration, presentation assets, and the publication manifest; canonical prose and generated catalogs remain under `docs/` and are exposed through [docs.ts](docs.ts). This is the only maintained Markdown file here. Never edit or commit `.generated/`, `.cache/`, or `.dist/`.

Run `pnpm docs:check` after changing this subtree.
