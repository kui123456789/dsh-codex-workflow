---
name: codex-workflow
description: Coordinate a coding task through a read-only Codex planner and reviewer while the host agent implements and tests. Use when the user requests a separate Codex planning or review workflow, including review-only work.
---

# Codex workflow

Use the bundled `scripts/workflow.mjs` from this skill directory. The host agent owns implementation and testing; Codex planner and reviewer roles are read-only. Honor the user's scope and authorization, especially for a review-only request: findings alone do not authorize fixes.

Read the [CLI reference](references/cli.md) before invoking the runtime. It defines command arguments, JSON input, and status fields. Run commands from the skill directory and use an absolute target project path. Run `doctor` before model use; it checks Node and Codex CLI capabilities without calling a model or verifying authentication. `doctor --offline` checks Node only.

## Workflow

1. Use `start` for planning and authorized implementation, or `review-only` for an independent review. Preserve the returned workflow ID. Model work is asynchronous; poll `status --wait-ms` up to 30000 ms and follow `nextAction`.
2. For `waiting_input`, present the Planner's questions to the user, then submit their answers with `continue` using the exact question IDs. For `executing`, implement the authorized plan, run relevant checks, and submit the actual implementation summary and test evidence with `review`.
3. For `fixing`, address blocking findings within the original authorization, run checks, and submit another review. In review-only mode, report findings and obtain authorization before applying fixes. A new business review gets a fresh Reviewer; recovery of a failed operation retains that operation's original thread.
4. For `waiting_review_decision`, present the nonblocking findings and submit the user's accept or fix choice through `decide`. For `passed`, report the accepted conclusion and actual verification evidence.

## Stops and recovery

Pause for unanswered questions or a pending user decision. Stop automatic repair when the runtime reports `blocked`, `failed`, or `cancelled`, and report the reason and remaining work. Honor recorded review and no-change limits; creating another workflow does not justify bypassing an exhausted repair budget.

The runtime admits one active workflow per project directory. Never duplicate a running operation or replace one with an unknown receipt or cleanup state. Resume only when status reports continuation available. Persistent Codex threads retain their exact IDs; do not substitute the latest thread or an ephemeral thread. Use [recovery and evidence](references/recovery.md) when an operation is interrupted, cleanup is uncertain, or workspace changes invalidate a review. Cancellation is terminal.

Report the result and verification evidence in the language appropriate to the user's task. State uncertainty and unfinished work accurately.
