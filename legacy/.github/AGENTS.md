# AGENTS.md — GitHub Actions

PRs run only pr-node and pr-python-sdk. v* tags run exhaustive tag jobs. Wine is local-only. Desktop, sandbox, and Landlock full lanes are tag-only. A successful tag CI run gates `.github/workflows/release.yml`; no repository-variable or self-hosted failover path exists. See the CI execution and recovery runbook before changing this topology.
