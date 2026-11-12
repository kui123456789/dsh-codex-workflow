---
name: codex-workflow
description: Coordinate a coding task through a read-only Codex planner and reviewer while the host agent implements and tests. Use when the user requests a separate Codex planning or review workflow, including review-only work.
---

# Codex workflow

Use the bundled `scripts/workflow.mjs` from this skill directory. The host agent owns implementation and testing; Codex planner and reviewer roles are read-only. Honor the user's scope and authorization, especially for a review-only request: findings alone do not authorize fixes.

Run `doctor` before model use to check Node and Codex CLI capabilities; it does not run a model. `doctor --offline` checks Node without checking Codex. Start a workflow with an absolute project directory and JSON input. Read [CLI reference](references/cli.md) for commands, input shapes, and status fields. Poll with `status --wait-ms` up to 30000 ms, and follow `nextAction`; do independent work while an operation runs. Handle clarification answers, implementation summaries, review findings, decisions, cancellation, and resume through the same workflow ID.

The workflow owns one active operation per project directory. Never duplicate a running operation or replace one with an unknown receipt or cleanup state. Resume only when status reports continuation available. Persistent Codex threads retain their exact IDs; do not substitute the latest thread or an ephemeral thread. See [recovery](references/recovery.md) for evidence and interruption rules.

Report the result and verification evidence in the language appropriate to the user's task. State uncertainty and unfinished work accurately.
