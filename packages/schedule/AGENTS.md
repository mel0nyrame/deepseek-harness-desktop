# AGENTS.md — Schedule packages

- The owning Session's versioned `schedule/change` stream is the only durable Schedule state. Validate durable JSON while folding; timers, waiters, and tool values are projections.
- A normal Session folds its full log. A fork derives active state only from events at or after `SessionHeader.seedLength` and never inherits an active parent reminder.
- Management operations flush before reading or deciding. Create and actual delete flush again after append; a failed barrier returns stable uncertainty rather than inferring durability from the live log.
- Runtime owners attach only to future live root Agents while loaded. They do not scan persisted Sessions, adopt existing roots, wake cold Sessions, register global tools, or delete durable records during teardown.
- Due handling rechecks time and owner, claims idle maintenance through the public Agent seam, frames the complete escaped follow-up before enqueue, records dispatch only after synchronous enqueue succeeds, releases maintenance, then awaits durability.
- Keep recurrence math and durable transitions pure. Production uses wall time and segmented timers; tests supply samples or fake timers without a production clock service.
