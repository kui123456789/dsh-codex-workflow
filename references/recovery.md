# Recovery and evidence

Each operation runs in a separate background worker; there is no listener or persistent daemon. Inspect status before taking further action. An operation that is still running, has an unknown receipt, or has unconfirmed cleanup must not be duplicated. Use `resume` only when continuation is available, and keep the exact original Codex thread ID. Cancellation is terminal and rejects late writes.

Only one workflow can be active for a project directory. An identical start returns the original workflow; a different start conflicts until the active one finishes.

Review evidence is captured before and after review and invalidated if status or content changes. For Git projects the fingerprint covers staged, unstaged, and untracked content. For non-Git projects, provide explicit changed files; if the evidence is insufficient, review is blocked rather than treating it as verified.

The host implements and tests. The planner and reviewer are read-only. A review-only request does not authorize applying fixes; a decision to fix requires the user's authorization.

Process cleanup is limited to captured process identities. POSIX identity checks and signals are not atomic, and macOS `ps` reports process birth time at second resolution. Unknown identity or cleanup state fails closed; this is not a complete containment guarantee.
