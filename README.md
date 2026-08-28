# dsh-codex-workflow

DeepSeek Harness plugin that gives Codex read-only planning/review roles while DSH remains the sole executor. Two flows share the same workflow engine:

- **Codex-led bridge (preferred)** — the Codex task that produced the plan sends it to the exact live DSH session through a durable SQLite bridge; DSH implements it, and the plugin appends every readable audit to that same Codex task before returning the verdict to the original DSH session.
- **DSH-led tools** — the DSH agent can autonomously start `codex_workflow_start` for complex development tasks, or the user can request it explicitly; implementation and review still run through the same workflow engine.

No browser is opened or controlled anywhere in the product path; no network listener, MCP, hooks, or skills are involved. Browser clicking is a development-only workaround and is not part of the plugin.

## Execution split (1.0.11)

Planner turns continue to use the Codex App Server/Desktop. Reviewer turns, bridge callbacks, reconciliation, normalization, and authority alignment run through the backend `codex exec` CLI. Visible Markdown reviews are appended to the existing workflow task; the plugin never opens, refreshes, navigates, or focuses Codex Desktop after an audit completes.

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

`pnpm run lifecycle:accept` runs the real hybrid acceptance against a live Codex login: Planner remains on the App Server/Desktop, while visible Reviewer/reconciliation turns run through real `codex exec --json resume <existing-task> -` and normalization/alignment run through separate `codex exec --ephemeral --output-schema ...` sessions. The gate records the actual spawned arguments (configured model via `-m`, visible reviewer effort via `model_reasoning_effort`, ephemeral effort fixed to `low`), proves reviews remain readable Markdown on the original task, exercises DSH-led/bridge/demo-smoke authority flows, and asserts the bridge Desktop opener is called zero times. `DSH_CODEX_LIFECYCLE_MODEL`, `DSH_CODEX_LIFECYCLE_EFFORT`, and `DSH_CODEX_LIFECYCLE_TIMEOUT_MS` control the real acceptance without changing runtime defaults.

## Codex-led flow (preferred)

From the Codex task that owns the plan, dispatch it to the live DSH session:

```powershell
# 1. Find the live DSH session for this workspace
dsh-codex-workflow sessions --cwd $PWD --json

# 2. Dispatch the plan (payload enters through stdin, never arguments)
$payload = '{"task":"实现搜索功能","planMarkdown":"<proposed_plan>…</proposed_plan>","assumptions":[]}'
$payload | dsh-codex-workflow dispatch --cwd $PWD --codex-thread $env:CODEX_THREAD_ID --stdin
```

The bridge resolves the exact session (explicit `--dsh-session` wins; otherwise the cwd must match exactly one live session, and ambiguity fails loudly). DSH receives the plan as a plugin relay message and implements it. When done, DSH calls `codex_workflow_submit`; the plugin validates the **exact stored Codex task id** read-only and resumes that same task for the readable audit:

```text
Planner/source Codex task --App Server--> readable plan
same visible task --codex exec --json resume--> visible Markdown review/reconciliation
independent CLI session --ephemeral --output-schema--> normalization/alignment JSON
```

The first successful review binding persists `reviewerThreadId` as the same value as the original Planner/source task; every later review resumes it again. Old records that already contain a distinct `reviewerThreadId` always prefer that task over `codexThreadId`, including writer release and callback persistence. The visible CLI receives `-m <reviewerModel>` when configured and `-c model_reasoning_effort="<reviewerEffort>"`; a blank model omits `-m` and uses the CLI default. Active-writer/rate-limit conditions remain retryable and never create a replacement task.

**The durable workflow history is human-readable.** Visible Planner/Reviewer turns never carry an `outputSchema`: each CLI review is readable Markdown (VERDICT / FINDINGS with severity, blocking and file:line / TEST GAPS / SUMMARY) in the original task's language. Structured normalization and authority alignment use independent `--ephemeral` CLI sessions with the same effective model and `model_reasoning_effort="low"`; they never use `resume`, never enter Desktop history, and never persist an internal id into `plannerThreadId`, `reviewerThreadId`, or `codexThreadId`.

**Every review turn carries its own full context — Git included.** DSH-led, bridge callback, first review and re-review all reuse the existing review prompt generator. The CLI stdin includes workflow identity, original task, approved plan, PREVIOUS APPLIED REVIEW, current fix summary, implementation summary, changed files, test results, bounded evidence, review scope, and the item-by-item authority gate. Git workspaces require independent read-only `git status`/`git diff`; non-Git workspaces use the same contract without inventing a different Reviewer policy.

**Review authority alignment (1.0.10).** After the visible review is normalized into the structured verdict, an INVISIBLE ephemeral fork (same read-only conversion machinery, low effort) checks every finding/test gap against an authority hierarchy: 1. a REPRODUCIBLE critical/high correctness/security/data-corruption defect (must carry concrete file:line + failing-scenario evidence) > 2. the ORIGINAL TASK and its explicit constraints (file scope, exact test counts, dependency limits, acceptance method) > 3. the APPROVED PLAN > 4. the previously applied findings and the current fix summary > 5. generic quality suggestions. Ordinary scope/test-count/verification-method conflicts resolve in the plan's favor: automated tests, STATIC CHECKS and REAL COMMAND verification are all formal evidence of a requirement — the Reviewer may no longer demand automated tests for behavior the task/plan verifies by real commands, and may not demand changes that exceed the task/plan's explicit bounds (a level-1 exception with reproducible evidence is the only override). The Planner contract mirrors this: it must never strengthen "tests cover A and B" into "exactly two tests" unless the user explicitly limited the count.

**The visible review is contract-checked from CLI JSONL.** The dispatcher extracts the last completed `agent_message`, requires the four readable section lines and the original task's language, and never accepts a structured ReviewResult envelope as visible output. A display violation may run one corrective visible CLI resume on the same task. No completion path calls App Server `thread/read`, `thread/fork`, `resumeThread`, or any Desktop navigation/refresh API; the Markdown is already persisted by CLI resume and the user can inspect the task later.

**Conflicts never cost the user a review cycle and never ask DSH to change code.** A conflict does not overwrite `latestReview`, increment `reviewCycles`, enter `fixing`, or send a fix instruction. One reconciliation CLI resume may rewrite the complete verdict on the same task; its prompt contains an explicit preservation manifest for every non-conflicting finding/test gap. Deterministic multiset checks reject deletion, field changes, duplicate-count drift and unrelated additions before re-alignment. A successful correction applies as one business cycle; two consecutive unresolved contract conflicts block without consuming a cycle.

### Reviewer writer-lock semantics

Before a visible CLI review or reconciliation, the plugin calls `thread/unsubscribe`/writer release for the selected visible task (`reviewerThreadId ?? codexThreadId`). After CLI completion it performs only idempotent cleanup: it does not re-subscribe, call `resumeThread`, read/fork the task for display, or invoke the Desktop opener. The review remains on the existing task; users open it manually when convenient. Legacy opener fields remain compatible but CLI audit records keep `desktopOpenState: "disabled"`.

### How the verdict comes back (automatic path)

`codex_workflow_submit` returns as soon as the submission and evidence are durably stored. A manager-owned backend CLI review then appends readable Markdown to the selected existing task; ephemeral CLI normalization/alignment produce the internal structured result. The plugin validates and stages that verdict, enqueues the deterministic `submit_verdict`, and the bridge runtime relays the outcome to the original DSH session. The CLI child never writes the bridge queue itself.

No periodic progress messages are injected while a review is running; `codex_workflow_status` is the on-demand progress view. Busy and rate-limit conditions remain silent background retries. Invalid task ids, missing final agent messages and terminal CLI process failures are persisted as an idempotent `submission_notice` and wake the original DSH session exactly once, including after a plugin restart.

A passing verdict tells DSH to report once and end the turn without calling `memory`, status, todo, shell, or workflow tools. If the terminal relay still leaves that exact agent activity running, a lifecycle guard cancels only the active turn after `terminalRelayTimeoutMs` while preserving queued inbox work. The guard disarms as soon as that activity reaches idle, so it cannot cancel a later user turn, and plugin teardown aborts and awaits all pending guards.

After Planner work completes, the managed App Server still follows its idle grace period. Reviewer CLI children are separately tracked and `cancel`, timeout, lease loss, and `stop()` terminate and await them; audit completion never reopens or refreshes Desktop.

`dsh-codex-workflow respond` is a **manual/compat fallback only** — for operators who want to type a verdict in by hand instead of letting the automatic path collect it, or to re-drive a verdict after the automatic pipeline was interrupted:

```powershell
$verdict = '{"verdict":"pass","findings":[],"testGaps":[],"summary":"ok"}'
$verdict | dsh-codex-workflow respond --workflow <workflowId> --codex-thread $env:CODEX_THREAD_ID --submission <submissionId> --stdin
dsh-codex-workflow status --request <requestId> --json
```

`--submission <uuid>` (optional in `respond`) pins the verdict to the exact submission the review answered; without it the legacy behavior applies only when the workflow has no active submission. Every `respond` is validated, idempotent per request id, and replayed safely — it never bypasses the evidence-fingerprint check (a verdict whose workspace changed since review is refused).

The verdict is applied in the original DSH session with the same blocking/non-blocking/no-change/max-cycle policy as the DSH-led flow: blocking findings return DSH to `fixing` (then re-`submit`), only non-blocking findings stop at `waiting_review_decision` for the user, and `pass` completes the workflow. If the workspace changed between submission and verdict, the verdict is refused and DSH is asked to re-`submit` for a fresh review — an old verdict can never pass changed code.

### CODEX_THREAD_ID

The bridge never invents the source task id. `dispatch`/`respond` default `--codex-thread` from `CODEX_THREAD_ID` and fail with a paste-ready explanation when it is absent. On the first review the callback validates and resumes that id, persists it as the workflow's review task id, and reuses it on later cycles.

## DSH-led flow (legacy, compatible)

In a DSH conversation:

```text
让 Codex 先规划这个改动，我来执行，完成后再让 Codex 审查。
```

Tools: `codex_workflow_start`, `codex_workflow_continue`, `codex_workflow_review`, `codex_workflow_review_only`, `codex_workflow_submit`, `codex_workflow_decide`, `codex_workflow_status`, `codex_workflow_cancel`.

### Autonomous planning trigger

The plugin registers one `systemPrompt` policy section that lets the current DSH model decide whether a user-requested development task should start Codex planning before any implementation change. It does not inspect user messages in a background listener and does not use a keyword classifier.

- `complex` (default): auto-start for multi-file/cross-layer work, architecture/API/data/persistence/concurrency/security/lifecycle/migration/release changes, root-cause-unclear defects needing regression tests, and mature/stable/end-to-end requests. Clear low-risk local edits stay in DSH.
- `always`: auto-start for every write-intent development task.
- `off`: inject no auto-trigger policy; explicit use of the workflow tools remains available.

Questions, explanations, translation, read-only inspection/research and Git-only operations never auto-trigger. A user instruction to work directly, skip planning or not use Codex always wins. Plugin-generated plan/review/fix/submission messages and a session that already owns an active workflow never start another one. When complexity is uncertain, DSH may do only the minimum read-only inspection needed to decide; on a match it briefly announces the decision and calls `codex_workflow_start` exactly once before modifying the workspace. A session-scoped SQLite lease plus the active-workflow check is the final race-proof guard, so concurrent attempts can create only one workflow and one Planner task.

## State machine

```
planning -> waiting_input -> executing -> reviewing -> fixing -> passed
executing/fixing -> codex_workflow_submit (returns immediately) -> queued -> sending -> retrying -> verdict_ready -> received -> applied -> delivered
                                                             `-> failed (invalid thread, no verdict, invalid identity/schema)
first sending: read-only source validation -> resume source task for review; later sending: resume that same task
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
- Reviewer CLI calls bind the exact DSH workspace cwd and run with `--sandbox read-only`, `approval_policy=never`, and no Git-root requirement; Git, non-Git and nested-repository workspaces use the same path.
- The selected existing Codex task is the review task. An active writer remains retryable with bounded backoff; the plugin never creates a replacement visible task to bypass it.
- Cancellation interrupts the exact active Planner turn or CLI child. Submission leases prevent a stale owner from applying a newer review, and `stop()` waits for child exit before teardown completes; provisional normalization/alignment JSON never becomes `latestReview`.

## Storage

Workflow records, leases, the bridge queue and the **live-session registry all live in ONE SQLite database**: `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite`. The only state on disk outside it is `bridge/review-schema.json` (the enforced verdict schema) and, briefly, the legacy file-queue source directories that are **imported once on first init** (receipts, retry semantics and attempts preserved). `bridge/sessions.json` is gone — live sessions are rows in `coord.sqlite` (`live_sessions`) with per-owner leases, so multi-process runtimes merge instead of last-writer-wins and a crashed runtime's sessions expire via TTL. Records never contain login tokens. Old JSON workflow records are imported lazily with `origin: "dsh"` and keep their behavior.

## Operations CLI

`dsh-codex-workflow` is also the audit/ops surface (all commands support `--json`):

- `workflows [--cwd] [--dsh-session] [--phase]` — list workflow summaries (never payloads).
- `show --workflow <id>` — plugin version plus one workflow's source/review task ids, stage, submission/callback state, review cycle, last error and evidence summary. In new planned/bridge workflows both ids intentionally identify the same Codex task; old workflows may still report a distinct Reviewer id.
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
- `autoTriggerMode`: `complex` (`off | complex | always`)
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
- `openCodexDesktopOnReview`: compatibility field; CLI audits keep Desktop auto-open disabled and never refresh or focus the window
- `desktopOpenRetryBaseMs`: `2000` (200 ms–60 s; initial retry backoff)
- `desktopOpenRetryMaxMs`: `60000` (1–60 s; capped retry backoff)

State lives in `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite` (queue + leases + workflows + live sessions); `bridge/review-schema.json` holds the enforced verdict schema. Records never contain login tokens.

## License

MIT
