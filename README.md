# dsh-codex-workflow

DeepSeek Harness plugin that gives Codex read-only planning/review roles while DSH remains the sole executor. Two flows share the same workflow engine:

- **Codex-led bridge (preferred)** — the Codex task that produced the plan sends it to the exact live DSH session through a durable SQLite bridge; DSH implements it, and the plugin validates the source task read-only and starts a separately owned Reviewer task whose verdict returns to the original DSH session for repair or sign-off.
- **DSH-led tools (legacy, still supported)** — the DSH agent drives `codex_workflow_start` / `codex_workflow_review` as before.

No browser is opened or controlled anywhere in the product path; no network listener, MCP, hooks, or skills are involved. Browser clicking is a development-only workaround and is not part of the plugin.

## Requirements

- DeepSeek Harness `0.1.0-rc.6`
- Node.js `^22.19.0` or `>=24`
- Codex CLI with a valid ChatGPT login and App Server support (verified by `pnpm doctor`)

## Install

```powershell
dsh plugin --profile web add dsh-codex-workflow
```

Restart the DSH web profile after installation. For source installs during
development, pass the local project directory to the same command.

## Build and verify

```powershell
pnpm install
pnpm verify
pnpm doctor
```

## Codex-led flow (preferred)

From the Codex task that owns the plan, dispatch it to the live DSH session:

```powershell
# 1. Find the live DSH session for this workspace
dsh-codex-workflow sessions --cwd $PWD --json

# 2. Dispatch the plan (payload enters through stdin, never arguments)
$payload = '{"task":"实现搜索功能","planMarkdown":"<proposed_plan>…</proposed_plan>","assumptions":[]}'
$payload | dsh-codex-workflow dispatch --cwd $PWD --codex-thread $env:CODEX_THREAD_ID --stdin
```

The bridge resolves the exact session (explicit `--dsh-session` wins; otherwise the cwd must match exactly one live session, and ambiguity fails loudly). DSH receives the plan as a plugin relay message and implements it. When done, DSH calls `codex_workflow_submit`; the plugin treats the **exact stored Codex task id** as an immutable source, validates it read-only, and asks its managed App Server to create a fresh durable Reviewer task:

```text
source Codex task --thread/read(includeTurns:false)--> validated
then thread/start --> dedicated Reviewer task --turn/start(outputSchema)--> verdict
```

The source task is never resumed or written by the plugin, so Codex Desktop may keep it open — and may even be its active writer — without causing a thread-store writer conflict. The first review persists the fresh Reviewer task id; every later repair review resumes that same Reviewer task. The Reviewer is forced to the workflow cwd with `read-only`, network disabled, and `approvalPolicy: never` at creation and on every review turn.

### How the verdict comes back (automatic path)

`codex_workflow_submit` returns as soon as the submission and evidence are durably stored and marks that successful tool result as terminal for the current DSH turn. The Reviewer then runs in a manager-owned background task, so the DSH session becomes idle without another model step and ending the tool call cannot cancel the review. The Reviewer stays read-only and answers **as its final message** with a structured JSON verdict matching the enforced output schema. The DSH plugin process (outside the Codex sandbox) receives the App Server turn result, validates it, durably stages it in the workflow record, and enqueues it as a `submit_verdict` bridge command with a deterministic per-submission request id. The bridge runtime then applies the verdict and relays the outcome to the original DSH session. The Reviewer never writes the bridge queue itself and never invokes the CLI.

No periodic progress messages are injected while a review is running; `codex_workflow_status` is the on-demand progress view. Busy and rate-limit conditions remain silent background retries. Invalid source tasks, missing verdicts and terminal App Server failures are persisted as an idempotent `submission_notice` and wake the original DSH session exactly once, including after a plugin restart.

A passing verdict tells DSH to report once and end the turn without calling `memory`, status, todo, shell, or workflow tools. If the terminal relay still leaves that exact agent activity running, a lifecycle guard cancels only the active turn after `terminalRelayTimeoutMs` while preserving queued inbox work. The guard disarms as soon as that activity reaches idle, so it cannot cancel a later user turn, and plugin teardown aborts and awaits all pending guards.

After a completed Planner or Reviewer operation, the managed App Server exits after a short idle grace period (5 seconds by default). The countdown starts only when no RPC, running turn, turn waiter, or pending clarification remains, so long reviews and user-input pauses stay safe while completed Reviewer tasks quickly release their writer lock and become readable in Codex Desktop.

`dsh-codex-workflow respond` is a **manual/compat fallback only** — for operators who want to type a verdict in by hand instead of letting the automatic path collect it, or to re-drive a verdict after the automatic pipeline was interrupted:

```powershell
$verdict = '{"verdict":"pass","findings":[],"testGaps":[],"summary":"ok"}'
$verdict | dsh-codex-workflow respond --workflow <workflowId> --codex-thread $env:CODEX_THREAD_ID --submission <submissionId> --stdin
dsh-codex-workflow status --request <requestId> --json
```

`--submission <uuid>` (optional in `respond`) pins the verdict to the exact submission the review answered; without it the legacy behavior applies only when the workflow has no active submission. Every `respond` is validated, idempotent per request id, and replayed safely — it never bypasses the evidence-fingerprint check (a verdict whose workspace changed since review is refused).

The verdict is applied in the original DSH session with the same blocking/non-blocking/no-change/max-cycle policy as the DSH-led flow: blocking findings return DSH to `fixing` (then re-`submit`), only non-blocking findings stop at `waiting_review_decision` for the user, and `pass` completes the workflow. If the workspace changed between submission and verdict, the verdict is refused and DSH is asked to re-`submit` for a fresh review — an old verdict can never pass changed code.

### CODEX_THREAD_ID

The bridge never invents the source task id. `dispatch`/`respond` default `--codex-thread` from `CODEX_THREAD_ID` and fail with a paste-ready explanation when it is absent. On the first review the callback validates the persisted source id read-only, persists the fresh Reviewer id it starts, and reuses only that Reviewer on later cycles.

## DSH-led flow (legacy, compatible)

In a DSH conversation:

```text
让 Codex 先规划这个改动，我来执行，完成后再让 Codex 审查。
```

Tools: `codex_workflow_start`, `codex_workflow_continue`, `codex_workflow_review`, `codex_workflow_review_only`, `codex_workflow_submit`, `codex_workflow_decide`, `codex_workflow_status`, `codex_workflow_cancel`.

## State machine

```
planning -> waiting_input -> executing -> reviewing -> fixing -> passed
executing/fixing -> codex_workflow_submit (returns immediately) -> queued -> sending -> retrying -> verdict_ready -> received -> applied -> delivered
                                                             `-> failed (invalid thread, no verdict, invalid identity/schema)
first sending: read-only source validation -> fresh durable Reviewer; later sending: resume same Reviewer
verdict_ready: verdict staged in the record; enqueue pending (crash-recoverable)
received:      verdict command queued for application
applied:       outcome persisted (pass | fixing | waiting_review_decision | blocked | refused-if-changed)
delivered:     outcome relayed to the original DSH session
cancelled: terminal — no queue retry, no late verdict, no message may resurrect it
```

`cancelled` is terminal under the bridge too: queued callbacks stop retrying, late verdicts receive an idempotent `cancelled` receipt and never wake DSH, and duplicate queue files or restarts cannot duplicate turns. While a submission is active, turn-stopping does not ask DSH to submit it again.

## Failure recovery

- All multi-step coordination state (leases, the bridge queue, workflow records) lives in one SQLite database per storage directory (`coord.sqlite`), shared by every DSH process and the CLI. Every invariant runs in a single `BEGIN IMMEDIATE` transaction; a killed process at ANY point rolls back cleanly and `PRAGMA integrity_check` stays clean.
- **Journal mode is rollback journal (DELETE), deliberately NOT WAL.** SQLite versions <= 3.51.2 (the runtime bundled with Node 24.14.0) have a WAL-reset bug (fixed 2026-03-13, released as 3.51.3) that can corrupt the WAL under the concurrent writers/checkpoints this plugin creates. `synchronous=FULL` + a busy timeout keep the rollback journal safe for multiple connections. `pnpm doctor` reports the runtime SQLite version, the actual `journal_mode` and runs an integrity check; the coordination database is refused on UNC/network paths.
- Fencing is by a MONOTONIC claim generation plus a random owner token: every ack/retry/dead-letter/renew is a conditional UPDATE on `status='processing' AND claim_epoch=? AND claim_owner=?`. The epoch is NEVER reset (release only clears owner/until), so a stale owner can never re-match a newer claim, and an owner that lost its lease kills its own callback child and stops writing state.
- Powers and deliveries are fenced and re-validated at every step:
  - **session-scoped leases** make workflow creation (and submission creation) atomic across processes — two overlapping DSH processes dispatching/submitting for the same session/request produce exactly one workflow/submission.
  - **verdicts are staged durably** (full command, identical requestId/createdAt/commandHash) and the first apply only moves `received -> applied`; conflicting request ids are always rejected; the staged identity survives until applied.
  - **delivery is prepare -> relay -> commit**: the workspace fingerprint is recomputed before the relay, and `delivered` is written (in a fenced CAS) only after the relay lands. Invalidated passes are reported as void, never as passed; a cancel or new submission that wins before commit never gets marked delivered.
- Dispatch delivery is exactly-once under crash replay: `bridgeRequestId` prevents duplicate workflows and the deterministic relay message id (persisted in the session's `agent/inbox/spliced` events) prevents duplicate followups.
- A missing live session retries forever with capped backoff (never a dead letter) for verdicts, and the fingerprint re-check runs on every retry so a stale pass is invalidated even after a long offline stretch.
- Reviewer App Server calls bind the exact DSH workspace cwd directly, so it may be a Git repository, a non-Git directory, or a workspace containing nested repositories. The Reviewer remains `read-only`, network-disabled, and approval-free.
- The originating Codex task may remain open in Desktop — even as its active writer: `thread/read` metadata validation of the source is never blocked by it, and the fresh Reviewer never competes for its writer lock. Busy/rate-limited App Server operations stay durably `retrying`; each recovery round makes up to `callbackMaxAttempts` attempts with exponential backoff, then yields until `submissionRetryAt`, including across DSH restarts. Invalid task ids, missing/invalid verdicts, and explicit App Server failures remain terminal with their diagnostic preserved.
- Cancellation interrupts the exact persisted Reviewer turn. Submission leases and task/turn ids prevent a stale owner from interrupting or applying a newer review; the DSH workflow and its evidence always remain visible via `codex_workflow_status`.

## Storage

Workflow records, leases, the bridge queue and the **live-session registry all live in ONE SQLite database**: `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite`. The only state on disk outside it is `bridge/review-schema.json` (the enforced verdict schema) and, briefly, the legacy file-queue source directories that are **imported once on first init** (receipts, retry semantics and attempts preserved). `bridge/sessions.json` is gone — live sessions are rows in `coord.sqlite` (`live_sessions`) with per-owner leases, so multi-process runtimes merge instead of last-writer-wins and a crashed runtime's sessions expire via TTL. Records never contain login tokens. Old JSON workflow records are imported lazily with `origin: "dsh"` and keep their behavior.

## Operations CLI

`dsh-codex-workflow` is also the audit/ops surface (all commands support `--json`):

- `workflows [--cwd] [--dsh-session] [--phase]` — list workflow summaries (never payloads).
- `show --workflow <id>` — plugin version plus one workflow's source/Reviewer task ids, stage, submission/callback state, review cycle, last error and evidence summary.
- `queue [--status <status>]` — queue/receipt/dead-letter rows with attempts, next retry and last error (never command payloads).
- `retry --request <id>` — requeue a `dead-letter` request or a legacy imported `failed` row; idempotent, and refuses active or completed rows. A cancelled receipt is stored on a completed `done` row and is never retried.
- `prune [--older-than <ms>] [--commit]` — dry-run by default; `--commit` removes only **terminal** receipts and passed/cancelled workflows older than the retention window. Active workflows, undelivered verdicts and failed/blocked diagnostics are never candidates.
- `help` — usage.

Run `pnpm doctor` (full: needs Codex CLI + login) or `pnpm doctor:offline` (CI-safe: skips only the codex/login checks, marks them SKIPPED, still checks SQLite/storage/local paths/build, `--json` for machines).

## Release check

`pnpm release:check` is a repeatable offline gate: `typecheck` + full test suite + `build` + offline doctor (`--json`, must pass) + a **pack audit** (temporary tarball is always cleaned) that asserts the package ships only the `files` whitelist — no tests/fixtures, `coord.sqlite`, DSH_HOME paths, credentials or temp/review leftovers. CI (`.github/workflows/ci.yml`) runs the same matrix on Windows with Corepack-pinned pnpm 10 and a frozen lockfile.

## Configuration

Defaults in `cordis.patch.yml`:

- `codexCommand`: `codex`
- `plannerModel` / `reviewerModel`: empty means the current Codex default
- `plannerEffort` / `reviewerEffort`: `high`
- `maxReviewCycles`: `3` (1–10)
- `maxNoChangeReviewRounds`: `1` (1–10)
- `reviewDiffMaxBytes`: `65536` (1 KiB–1 MiB)
- `bridgePollMs`: `1000` (200 ms–60 s)
- `bridgeMaxPayloadBytes`: `1048576` (64 KiB–16 MiB)
- `callbackTimeoutMs`: `600000` (10 s–30 min)
- `callbackMaxAttempts`: `3` (1–10 attempts per persistent recovery round)
- `callbackRetryBaseMs`: `2000` (200 ms–5 min)
- `turnTimeoutMs`: `600000`
- `idleProcessMs`: `5000` (starts only after all App Server work is idle)
- `terminalRelayTimeoutMs`: `60000` (0 disables; maximum 10 minutes; cancels only a stuck terminal pass relay and preserves inbox work)

State lives in `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite` (queue + leases + workflows + live sessions); `bridge/review-schema.json` holds the enforced verdict schema. Records never contain login tokens.

## License

MIT
