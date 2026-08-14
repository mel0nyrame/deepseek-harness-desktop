# AGENTS.md — GitHub Actions

Run `windows-*` jobs under native `pwsh`. The pull-request `windows` job deliberately runs Windows Node under Wine on hosted Linux and blocks `all checks passed`; `windows-native` reports independently from `windows-2025` or the configured self-hosted failover pool. The master `serial-windows` job continuously validates that pool. Follow the [CI failover runbook](../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md) before changing this topology.
