# Agent Note: Serialized agent verification runner

Status: implemented

English | [中文](2026-09-05-agent-verification-runner.zh.md)

## Problem

Repository verification spans workspace checks, macOS packaging, and installed-product tests. Agents previously had to reconstruct and invoke that sequence one command at a time. Existing `apps/desktop/dist` output also makes the workspace Vitest discovery include the packaged native UI tests, so a source test run can overlap a packaged Electron run and contend for macOS fullscreen state. Long command output then obscures which gate failed and where its complete log lives.

## Decision

`pnpm run test:agent` is the discoverable agent verification entry point. Its default `all` preset serializes workspace checks, packaging, installed-product verification, and the final diff check. The workspace step temporarily isolates an existing `apps/desktop/dist` directory and restores it after the command completes, so source and packaged native UI gates do not overlap.

The runner also exposes smaller `workspace`, `package`, `focused`, and `quick` presets through `pnpm run test:agent -- --help`. It emits stable `AGENT_CHECK` status records, a periodic heartbeat for long-running steps, one full log per step under `.artifacts/agent-check/`, and a bounded failure tail in the terminal. Root `AGENTS.md` points future sessions to the help command rather than duplicating the option contract.

## Verification

`tests/agent-check.test.ts` pins argument validation and the exact plan for the default and focused presets. A focused runner invocation exercises build, focused Vitest execution, logging, and diff validation. The default invocation exercises the complete serialized workspace-to-installed-product path and the package-output isolation boundary.

## Alternatives considered

**Copy every underlying command into `AGENTS.md`.** A command list is easy to overlook or let drift as gates change, and it does not provide serialization, structured results, or persistent logs.

**Make all Vitest execution globally serial.** That slows unrelated tests and changes the semantics of the ordinary suite even though the native UI collision only matters when packaged output is present.

**Use a shell script that inherits all output.** This is compact, but it does not give agents stable result records, per-step logs, failure tails, or typed argument validation without rebuilding those facilities around shell-specific behavior.

## Consequences

Agents can discover and run the appropriate verification plan from one command, and CI-like native UI gates run in a deterministic order. Full output consumes ignored artifact storage, and a complete `all` run remains intentionally expensive because it packages and launches the installed application. The temporary package-output move is restored on normal completion and command failure; an externally killed process can leave the explicitly named hold directory for manual recovery.
