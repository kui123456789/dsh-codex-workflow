# Recovery and evidence

Each operation runs in a separate background worker; there is no listener or persistent daemon. Inspect `status` before taking further action, using the workflow ID returned by the runtime. Input and selector syntax are in the [CLI reference](cli.md).

## Continuation decisions

An operation that is still running, has an unknown receipt, or has unconfirmed cleanup must not be duplicated. Use `resume` only when `continuation.available` is true. The runtime retains the exact original Codex thread ID; never substitute `--last` or start a replacement to guess the target.

| Status or reason | Host action |
| --- | --- |
| `running` | Poll the original operation with bounded status waits. |
| `state_changed` | Query status again; the stored phase changed during the previous query. |
| `waiting_input` | Present Planner questions to the user and submit their answers with `continue`. |
| `waiting_review_decision` | Present nonblocking findings and use `decide` for the user's choice. |
| `start_receipt_missing` | Report the missing original thread receipt; do not issue another model request. |
| `cleanup_unconfirmed` | Inspect the original operation's evidence and report the cleanup barrier. A numeric PID alone cannot authorize termination or replacement. |
| `workspace_changed` or `evidence_unavailable` | Treat the old conclusion as unverified and report the evidence problem. |
| `failed` or `blocked` | Stop automatic repair and report the recorded failure or remaining findings. |
| `cancelled` | Treat cancellation as terminal; late model results cannot restore the workflow. |

Some rows are business phases and others are continuation reasons. Use the actual envelope fields, not a substring in an error message, to decide whether model work is eligible.

Only one workflow can be active for a project directory. An identical start returns the original workflow; a different start conflicts until the active one finishes.

## Evidence and operation artifacts

Review evidence is captured before and after review and invalidated if status or content changes. For Git projects the fingerprint covers staged, unstaged, and untracked content. For non-Git projects, provide explicit changed files; if the evidence is insufficient, review is blocked rather than treating it as verified.

Use `artifactPaths.operation` to locate `schema.json`, `prompt.txt`, `worker.log`, and any completed `result.json`. Planning writes `plan.md`; review writes `review.md`. Files appear as their operation progresses, so an absent result is not a passing result. SQLite state records the operation owner, thread binding, cleanup state, and checkpoints.

## Repair and cleanup limits

The host implements and tests. The planner and reviewer are read-only. A review-only request does not authorize applying fixes; a decision to fix requires the user's authorization.

Honor the recorded review and unchanged-evidence limits. When the runtime stops repair, report the remaining findings rather than resetting the limits through a replacement workflow. Model-call timeouts and transient retry budgets use a monotonic clock.

Process cleanup is limited to captured process identities. POSIX identity checks and signals are not atomic, and macOS `ps` reports process birth time at second resolution. Unknown identity or cleanup state fails closed; this is not a complete containment guarantee.
