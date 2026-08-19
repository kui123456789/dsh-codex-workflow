# Changelog

All notable changes to `dsh-codex-workflow`.

## [1.0.5] - 2026-08-19

### Changed

- A successful review relay now instructs DSH to emit one final implementation/test report, call no tools (including `memory`), and end the turn immediately.
- Added `terminalRelayTimeoutMs` (default `60000`, `0` disables, maximum 10 minutes). It watches only the activity awakened by a passing verdict and preserves queued inbox work when cancelling a stuck turn.
- Package and runtime version are now `1.0.5`.

### Fixed

- A completed workflow no longer remains visually “running” when the DSH model emits its final report and then stalls in an empty trailing tool call. The terminal relay guard disarms on idle, cannot affect a later user turn, and is aborted and awaited during plugin teardown.

## [1.0.4] - 2026-08-19

### Changed

- The managed Codex App Server now enters its idle countdown only when no JSON-RPC request, turn waiter, running turn, or clarification request remains. Long Planner and Reviewer turns therefore cannot be terminated by a short idle timeout.
- The default `idleProcessMs` is now `5000`, so a completed Reviewer releases its writer lock to Codex Desktop within a few seconds instead of keeping the task unavailable for 15 minutes.
- Package and runtime version are now `1.0.4`.

### Fixed

- Completed Reviewer tasks no longer remain blank in Codex Desktop with “opened in another app” until the old 15-minute process timeout expires. Planner clarification turns remain attached to their App Server until DSH supplies the answers.

## [1.0.3] - 2026-08-19

### Changed

- `codex_workflow_submit` now returns immediately after validation, evidence capture and durable submission persistence, and its successful result concludes the current DSH turn without another model step. Reviewer execution, retries, verdict staging and queue delivery continue in manager-owned background tasks that outlive the DSH tool call.
- Active submissions suppress `agent/turn-stopping` duplicate-submit steering. `codex_workflow_status` remains the explicit progress interface; no periodic progress messages interrupt the user.
- Package and runtime version are now `1.0.3`.

### Fixed

- Ending or aborting the DSH tool call no longer cancels the background Reviewer. Cancellation targets the persisted Reviewer operation, and plugin teardown aborts and awaits every background callback before stores close.
- Invalid source tasks, missing verdicts and App Server process failures now create a durable `submission_notice` command with a stable request id. Restart recovery re-enqueues that exact command and the bridge wakes the original DSH session at most once; busy/rate-limit retries remain silent.

## [1.0.2] - 2026-08-19

### Changed

- Reviewer session isolation refined: the first review no longer forks the source task. It validates the source read-only via `thread/read` (`includeTurns: false`) and then creates a brand-new durable Reviewer with `thread/start`, so the Reviewer inherits none of the source's history or writer state and Codex Desktop can keep the source open (or actively writing it) without any thread-store conflict. Later review cycles resume that same persisted Reviewer. `thread/fork`, `ForkThreadOptions` and all forked-reviewer wording are removed; existing `reviewerThreadId` records keep resuming their original Reviewer unchanged.
- Package and App Server client version are now `1.0.2`, so the loaded build is distinguishable in DSH.
- README, CHANGELOG and release checklist describe the validate-then-fresh-start Reviewer architecture instead of the fork architecture.

### Fixed

- The first review can now start even when the source Codex task has an active writer: `thread/read` metadata validation is never blocked by it, and the fresh Reviewer never competes for the source's writer.

## [1.0.1] - 2026-08-18

### Fixed

- Replaced the production `codex exec resume <sourceTask>` callback with a managed App Server flow. The first review validates the source task read-only (`thread/read`, `includeTurns: false`) and creates a durable, independently owned Reviewer via `thread/start`; later review cycles resume that same Reviewer. The originating Codex Desktop task stays immutable and can remain open without triggering `thread-store ... active writer` failures.
- Reviewer task and turn ids are persisted as soon as they exist, fenced by the submission lease, restored after process restart, and used for precise cancellation.
- Non-Git workspace roots work through App Server cwd binding without weakening the Reviewer sandbox: `read-only`, network disabled, and `approvalPolicy: never` remain enforced.

### Changed

- Package and App Server client version are now `1.0.1`, so the loaded build is distinguishable in DSH.
- `dsh-codex-workflow show` now reports `pluginVersion`, `originatingCodexTaskId`, `reviewerCodexTaskId`, and `reviewerTurnId` without exposing task content.
- Documentation and release checks now describe the source-task validation and fresh-Reviewer architecture.

## [1.0.0] - 2026-08-18

### Added

- **CI**: `.github/workflows/ci.yml` runs the full gate on Windows over Node 22.19.x and 24.x with Corepack-pinned pnpm 10 and a frozen lockfile (`packageManager` field added). CI never needs a Codex login or reads the real DSH_HOME.
- **Offline doctor**: `pnpm doctor -- --offline` (and the `doctor:offline` script) skips only the Codex CLI/login/app-server checks and marks them explicitly SKIPPED; SQLite/storage/local-path/build checks still run. `--json` emits a stable machine-readable report (`ok`, `checks[]`, `skippedCount`, `failedCount`).
- **Release check**: `pnpm release:check` runs verify + offline doctor + a real temporary `pnpm pack` audit (gzip/ustar parsing, no extra deps). It enforces the `files` whitelist and forbids tests/fixtures, `coord.sqlite`, DSH_HOME paths, credentials, tmp/tgz/review leftovers; the temp tarball is always removed.
- **Process-level fault/recovery suite**: real child-process + real SQLite tests cover killed-claimer recovery (stale processing row taken over with a fresh claim epoch, delivered exactly once), two real processes racing claims (disjoint, never double-claimed), a real codex-callback child that ignores SIGTERM being SIGKILL-escalated by `stop()`, and a staged verdict from a killed process re-enqueued with EXACT identity, idempotently.
- **Operations CLI**: `workflows`, `show`, `queue`, `retry`, `prune`, `help` (all with `--json`), plus `--phase/--status/--older-than/--commit` flags. `retry` is idempotent and only requeues `dead-letter` or legacy imported `failed` rows; completed rows, including rows carrying a cancelled receipt, are never retried. `prune` is dry-run by default and only ever touches terminal receipts and passed/cancelled workflows older than the retention window.
- Documentation: `CHANGELOG.md`, `docs/release-checklist.md`, README storage/ops/release sections rewritten.

### Changed

- Package version: `0.1.0` → `1.0.0` (`packageManager: pnpm@10.33.2`).
- Storage documentation clarified: `coord.sqlite` is the single authority (queue + leases + workflows + **live_sessions**); `bridge/sessions.json` is removed, `bridge/review-schema.json` remains; legacy file-queue data is still imported once.
- Doctor: app-server import is lazy so `--offline` does not require a built `lib/`.
- Codex task ownership conflicts are no longer terminal after one bounded retry round. Busy/rate-limited callbacks persist `submissionRetryAt` and are recovered by the normal bridge pump; early 1.0.0 `busy after N attempts` records are migrated back to `retrying` automatically.
- The legacy exact-thread CLI dispatcher supports non-Git DSH workspace roots via Codex CLI's `--skip-git-repo-check`; it remains covered as a compatibility component, while production uses the App Server Reviewer flow introduced in 1.0.1.

### Security / recovery guarantees (unchanged, underscored)

- Read-only Reviewer; evidence-fingerprint re-validation before every delivery; `cancelled` is terminal (no late verdict, no resurrection); immutable source task plus persisted Reviewer; idempotent per-request enqueue/apply; monotonic claim-epoch fencing; rollback-journal (DELETE) SQLite, never WAL.

### Known limitations

- `doctor --offline` intentionally cannot verify the Codex CLI login, model availability or the app-server round-trip — those checks are skipped (reported), not faked as passing.
- On Windows hosts without symlink/ACL permissions some OS-permission scenarios are covered by tests only when the platform allows them; `release:check` runs everywhere and will list any residual risk explicitly.
- Packages never ship tests or fixtures; they are for the repository only.
