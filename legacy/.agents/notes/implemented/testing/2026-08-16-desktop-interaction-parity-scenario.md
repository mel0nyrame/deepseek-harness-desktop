# Agent Note: Desktop interaction-parity scenario replays three sessions through the Electron carrier

Status: implemented

English | [中文](2026-08-16-desktop-interaction-parity-scenario.zh.md)

## Problem

The desktop tracer bullet covered only Session creation and one terminal-backed tool turn. Issue #6 requires the desktop shell to preserve the Web interaction model — Workspaces and Sessions over the existing Host services, prompts with ordered streaming output, and approvals and questions — through the Electron carrier, with reconstruction from the existing persistence and a real keyless snapshot through the assembled renderer. The existing scenario also passed silently while its turn ended in error: the composed `session-title-llm` row's fire-and-forget auxiliary title call consumed one llm-replay script entry, exhausting the session's cursor before the turn's final model call.

## Decision

One shared keyless scenario (`apps/desktop/src/smoke.ts` `runSmokeScenario`) drives both the development e2e and the packaged smoke, in eight ordered stages: readiness and the no-TCP-listener probe; durable Workspace creation and idempotent reopen; the ordered terminal turn; a question turn answered through the carrier's `/api/respond` endpoint; a sandbox-escalation approval turn answered the same way; and reconstruction of every model-visible input from the durable Session logs. The stage result is written as a reopen state file that a second packaged launch (`--smoke-reopen --smoke-home <dir>`) asserts against — the Workspace and all three Sessions reconstruct from the existing persistence with no model call.

- **The replay profile patch disables the composed `session-title-llm` row** (`- id: session-title-llm / disabled: true`) for the same reason the Web scaffold does: its auxiliary title call would race the loop for the session's replay cursor. Each turn now asserts `turn/end` reason `completed`, so a replay underrun fails loudly instead of passing with an errored turn.
- **Three recorded fixtures bind to three live sessions** by llm-replay's first-model-call order: the primary `bash-tool-turn` fixture, then `question-composer` and `approval-composer` as `childFiles`. The Web fixtures are reused verbatim; no new recorded session is hand-derived.
- **The question and approval answers are the driver's own gestures over the carrier**: a `client-response` echoing the server-request's rpcId through `POST /api/respond` — the exact wire reaction the renderer sends when a user answers.
- **The permission switch runs through the `commands/execute` Typert remote** (`/permission read-only`) — the same remote call the Web client's `session.command` sends. A `session.prompt` with a slash line is NOT a command on this carrier: it is sent to the model (observed while probing).
- **The recording journey (`--record-native-window`) now covers the assembled renderer's interaction path**: after the terminal turn it creates two more workspace sessions over the wire, navigates to each through the real New Session sidebar row, switches the real access-mode chip to Read Only, answers the assembled question composer (Blue option plus custom text), clicks Allow once in the assembled approval panel, and asserts the escalated `notes.txt` landed in the acceptance workspace.
- **The carrier paces each stream frame end-to-end**: the child awaits Electron main's per-frame `stream-ack` before sending the next frame (headless smoke drivers are auto-acked per frame), and the renderer client acknowledges each event only after its consumer has taken it — not at preload dispatch. A slow renderer therefore throttles the ordered source instead of overflowing the bounded relay.

## Alternatives considered

- **Recording the auxiliary title call in the fixture** instead of disabling title-llm: the replay script derives only from `assistant/chunk` events, so an auxiliary title stream is not representable in a recorded session; the fire-and-forget call's position in the call order is also racy, so a sidecar patch could not pin it.
- **Switching the sandbox mode through a `session.prompt` slash line**: the apiproxy prompt path admits the message to the agent loop (observed: the replayed bash turn ran); commands execute only through the `commands/execute` Remote.
- **One hand-stitched three-turn fixture** instead of three fixtures over three live sessions: stitching renumbers a session log by hand and creates a maintained derivative; the llm-replay binding contract already orders primary and child scripts deterministically, and three live sessions additionally exercise the session navigation the reopen evidence relies on.

## Consequences

- The scenario fails loudly on any `turn/end` that is not `completed`; the pre-existing title-llm underrun would have been caught by the new assertion.
- The smoke profile diverges from the shipped desktop composition only by the title-llm disable row — the same divergence the Web scaffold documents.
- The packaged smoke now requires the three fixtures copied into the launch home, and the recording journey adds four frame labels (`question-pending`, `question-settled`, `approval-pending`, `approval-settled`) to the recorded evidence.
- The approval fixture's 1784 ordered chunks exercise the carrier's ack pacing; without it the relay's 256-frame bound aborted the stream mid-turn and the approval panel never rendered.
