# dsh-codex-workflow

DeepSeek Harness plugin that gives Codex read-only planning/review roles while DSH remains the sole executor. Two flows share the same workflow engine:

- **Codex-led bridge (preferred)** — the Codex task that produced the plan sends it to the exact live DSH session through a durable SQLite bridge; DSH implements it, and the plugin runs every readable audit on the workflow's own **dedicated Reviewer task** before returning the verdict to the original DSH session (the originating Codex task is never resumed or written; it receives the outcome through the bridge relay).
- **DSH-led tools** — the DSH agent can autonomously start `codex_workflow_start` for complex development tasks, or the user can request it explicitly; implementation and review still run through the same workflow engine.

No browser is opened or controlled anywhere in the product path; no network listener, MCP, hooks, or skills are involved. Browser clicking is a development-only workaround and is not part of the plugin.

## Execution split (1.1.2)

Planner turns AND visible Reviewer turns run on the Codex App Server — `thread/start` → `thread/settings/update` → `thread/name/set` → `review/start` — so every task the plugin creates is stored with `source='vscode'`, the only source Codex Desktop's sidebar (`thread/list`) ever returns, and carries a readable name (`DSH Plan: …`, `DSH Reviewer: <workflowId>`). Measured on this host: 62 of 72 non-archived `vscode` tasks were listed and **0 of 15 `codex exec` tasks** were. The `codex exec` CLI is used ONLY for the internal structured conversions (`normalize`, `align`, `reconcile`), which run `--ephemeral`: they neither create nor resume a durable task and never enter Desktop history.

The plugin never opens, refreshes, navigates, or focuses Codex Desktop after a review completes.

## Requirements

- DeepSeek Harness `0.1.5-rc.1` (minimum supported version; this release updates the host API baseline)
- Node.js `^22.19.0` or `>=24`
- Codex CLI with a valid ChatGPT login and App Server support (verified by `pnpm doctor`)

### Upgrading after a DSH update

Version 1.1.0 targets DSH `0.1.5-rc.1` and newer compatible 0.1.x releases.
Older DSH versions need the older plugin release. Source installs must refresh
their local dependencies with `pnpm install --frozen-lockfile` and rebuild;
upgrading the host alone does not update a linked plugin's `node_modules`.

Run `pnpm host:check` to load and unload the built plugin using the actual DSH
core packages installed under `$DSH_HOME/profiles`. It checks that all eight
tools exist when activation resolves and disappear on unload, using temporary
storage and an empty agent registry. It does not restart the live profile or
perform a model call. For another installation, set
`DSH_CODEX_HOST_PACKAGE_JSON` to its `@deepseek-ai/dsh/package.json` path.
After the checks, load the new build through the normal operator-controlled
DSH profile restart; existing workflow storage requires no migration.

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

`pnpm run lifecycle:accept` is a manual harness that requires a live Codex login. It still drives the PRE-1.1.0 CLI-visible wiring (`codex exec --json resume <existing-task>` for visible Reviewer turns, shared task ids) and has **not** been updated for the dedicated-Reviewer (1.1.0) or App-Server-visible (1.1.2) layout; it is not part of `pnpm verify` / `pnpm release:check` and must not be used as evidence for a current release. The offline gates are `pnpm verify` and `pnpm release:check`.

## Codex-led flow (preferred)

From the Codex task that owns the plan, dispatch it to the live DSH session:

```powershell
# 1. Find the live DSH session for this workspace
dsh-codex-workflow sessions --cwd $PWD --json

# 2. Dispatch the plan (payload enters through stdin, never arguments)
$payload = '{"task":"实现搜索功能","planMarkdown":"<proposed_plan>…</proposed_plan>","assumptions":[]}'
$payload | dsh-codex-workflow dispatch --cwd $PWD --codex-thread $env:CODEX_THREAD_ID --stdin
```

The bridge resolves the exact session (explicit `--dsh-session` wins; otherwise the cwd must match exactly one live session, and ambiguity fails loudly). DSH receives the plan as a plugin relay message and implements it. When done, DSH calls `codex_workflow_submit`; the plugin validates the **exact stored Codex task id** read-only, then runs the readable audit on the workflow's **dedicated Reviewer task** — the originating task is never resumed and never written:

```text
Planner/source Codex task --App Server--> readable plan
dedicated Reviewer task --App Server thread/start + review/start--> visible Markdown review/rewrite
dedicated Reviewer task --codex exec --ephemeral --output-schema--> normalization/alignment JSON
```

**The Reviewer never shares a task (1.1.0), and it is always VISIBLE in Codex Desktop (1.1.2).** The first successful review binding creates a separate Reviewer task and persists it as `reviewerThreadId`; every later review, repair round and re-review resumes that same task, and writer release targets only it. A review never resumes the Planner task or the bridge's originating task, so an external writer holding them can no longer block a review with `thread-store conflict: thread X already has an active writer` — Codex Desktop keeps exactly such a writer lock on every thread it has loaded, and the plugin has no way to release it. The Reviewer is created by the App Server (`thread/start` → `thread/settings/update` → `thread/name/set` → `review/start`), so it is stored with `source='vscode'` — the only source `thread/list` returns — and named `DSH Reviewer: <workflowId>`. A task created by `codex exec` is stored with `source='exec'`, is never listed (measured: 0 of 15) and can never be rendered in Desktop, not even after `thread/name/set`; that is why the plugin no longer creates durable Reviewer tasks through the CLI. Records from before 1.1.2 (or whose `reviewerThreadId` still aliases the Planner/source task) are migrated lazily: the next review binds a visible Reviewer, records `reviewerThreadOrigin: "app-server"` (internal; never surfaced by `show --json`) and never resumes the old task again — migration adds no review cycle, no verdict and no bridge receipt change. The old `exec` task is left intact and renamed best-effort to `DSH Reviewer (legacy, not renderable in Desktop): <workflowId>` (`thread/name/set` needs no `thread/resume`, so the rename can never take a writer lock); only a DEDICATED legacy Reviewer is renamed — an id that still aliases the Planner or bridge origin task keeps its own title. A Reviewer task created for a binding that lost the CAS (concurrent cancel) or whose binding write failed is released best-effort rather than left subscribed, while a pre-existing Reviewer is never released by a failed resume (`thread/resume` is what claims the hold). The visible turn receives the configured `<reviewerModel>` and `<reviewerEffort>`; a blank model uses the resolved default. Active-writer/rate-limit conditions remain retryable, and a retry can no longer be blocked by the Planner or originating task.

**The durable workflow history is human-readable.** Visible Planner/Reviewer turns never carry an `outputSchema`: each review is readable Markdown (VERDICT / FINDINGS with severity, blocking and file:line / TEST GAPS / SUMMARY) in the original task's language, persisted on the Reviewer task by the App Server turn itself. Structured normalization and authority alignment use independent `codex exec --ephemeral` sessions with the same effective model and `model_reasoning_effort="low"`; they never use `resume`, never create a durable task, never enter Desktop history, and never persist an internal id into `plannerThreadId`, `reviewerThreadId`, or `codexThreadId`.

**Every review turn carries its own full context — Git included.** DSH-led, bridge callback, first review and re-review all reuse the existing review prompt generator. The `review/start` custom target (and the App Server turn on the callback path) carries workflow identity, original task, approved plan, PREVIOUS APPLIED REVIEW, current fix summary, implementation summary, changed files, test results, bounded evidence, review scope, and the item-by-item authority gate. Git workspaces require independent read-only `git status`/`git diff`; non-Git workspaces use the same contract without inventing a different Reviewer policy.

**Review authority alignment (1.0.10).** After the visible review is normalized into the structured verdict, an INVISIBLE ephemeral fork (same read-only conversion machinery, low effort) checks every finding/test gap against an authority hierarchy: 1. a REPRODUCIBLE critical/high correctness/security/data-corruption defect (must carry concrete file:line + failing-scenario evidence) > 2. the ORIGINAL TASK and its explicit constraints (file scope, exact test counts, dependency limits, acceptance method) > 3. the APPROVED PLAN > 4. the previously applied findings and the current fix summary > 5. generic quality suggestions. Ordinary scope/test-count/verification-method conflicts resolve in the plan's favor: automated tests, STATIC CHECKS and REAL COMMAND verification are all formal evidence of a requirement — the Reviewer may no longer demand automated tests for behavior the task/plan verifies by real commands, and may not demand changes that exceed the task/plan's explicit bounds (a level-1 exception with reproducible evidence is the only override). The Planner contract mirrors this: it must never strengthen "tests cover A and B" into "exactly two tests" unless the user explicitly limited the count.

**The visible review is contract-checked against the PERSISTED history.** The App Server path takes the authoritative display text from `thread/read(includeTurns: true)` for the turn appended since the pre-turn baseline — the streamed aggregation can differ from what Codex Desktop actually stores, so it alone never gates the contract. A missing or ambiguous read-back is retryable and never falls back to in-memory text. The text must carry the four readable section lines and the original task's language, and a structured ReviewResult envelope is never accepted as visible output; a display violation runs one corrective visible turn on the same **dedicated Reviewer** task. Nothing on the completion path calls the Desktop opener or any navigation/refresh API — the Markdown is already persisted on the Reviewer task and the user can inspect it whenever they like.

**Conflicts never cost the user a review cycle and never ask DSH to change code.** A conflict does not overwrite `latestReview`, increment `reviewCycles`, enter `fixing`, or send a fix instruction. One reconciliation turn may rewrite the complete verdict on the same task; its prompt contains an explicit preservation manifest for every non-conflicting finding/test gap. Deterministic multiset checks reject deletion, field changes, duplicate-count drift and unrelated additions before re-alignment. A successful correction applies as one business cycle; two consecutive unresolved contract conflicts block without consuming a cycle.

### Reviewer writer-lock semantics

Before an App Server review turn, the plugin `thread/resume`s the dedicated Reviewer task (`reviewerThreadId` — always a dedicated, visible task since 1.1.2) and releases it again (`thread/unsubscribe`) when the operation settles; a legacy `exec` task is never resumed at all, it is only renamed with `thread/name/set`, which takes no writer lock. Idempotent cleanup only: the plugin does not re-subscribe for display, read/fork the task for rendering, or invoke the Desktop opener. The review remains on that Reviewer task; users open it manually when convenient. Legacy opener fields remain compatible but audit records keep `desktopOpenState: "disabled"`.

### Transient upstream failures are retried (1.1.1)

Capacity and throttling problems are temporary, so they never end a workflow any more. One shared policy (`src/transient-retry.ts`) classifies `server_overloaded` / "Selected model is at capacity" / 429 / `usage limit` / 502-504 / dropped streams / a thread writer held by another process, and retries the operation with exponential backoff plus jitter inside `transientRetryBudgetMs` (default 20 minutes). It covers every VISIBLE App Server turn — planner start/continue, the completion turn, the DSH-led `review/start` review turn, the display rewrite and reconciliation — plus the callback path's visible turn (which stays `retryable_busy` for the bounded callback retry and the periodic `recoverCallbacks` sweep) and the CLI audit's ephemeral conversions (`normalize`, `align`, `reconcile`).

Terminal conditions are never retried: a thread that does not exist, schema or display-contract violations, approvals, and any cancellation. A visible turn is retried only when it failed WITHOUT producing visible output, so a retry can never duplicate a plan, an audit or a rewrite, and a pending backoff is interrupted immediately by cancel/teardown. When the budget is spent the outcome stays RETRYABLE (the workflow records the reason and the user can run it again) — it is never reported as a terminal failure. Long diagnostics keep head AND tail, so the persisted error always shows the real reason.

### Review progress and heartbeats (1.1.2)

A running review is observable from the durable record, not from model output. Each attempt persists `processState` (`running` / `waiting` / `completed` / `failed` / `cancelled` / `stale`), `reviewStep` (`review_native_turn`, `review_readback`, `review_display_rewrite`, `review_conversion`, `review_alignment`, `review_reconciliation`, `review_finalizing`), `reviewAttempt`, `reviewStartedAt`, `lastProgressAt`, `reviewElapsedMs`, `activeTurnId` and a short `lastProgressMessage` — safe phase diagnostics only, never model text or raw JSONL. `codex_workflow_status` returns them with the record.

An independent DSH-owned timer (`reviewHeartbeatMs`) keeps the heartbeat fresh while a review runs, so a wedged review is visible even when the model produces nothing; `status` reports `stale` once the last heartbeat is older than `reviewStaleMs`, and completion, failure, cancellation and teardown stop the timer and record the terminal state.

### How the verdict comes back (automatic path)

`codex_workflow_submit` returns as soon as the submission and evidence are durably stored. A manager-owned App Server review then appends readable Markdown to the workflow's dedicated Reviewer task; `codex exec --ephemeral` normalization/alignment produce the internal structured result. The plugin validates and stages that verdict, enqueues the deterministic `submit_verdict`, and the bridge runtime relays the outcome to the original DSH session. The review never writes the bridge queue itself.

No periodic progress messages are injected while a review is running; `codex_workflow_status` is the on-demand progress view. Busy and rate-limit conditions remain silent background retries — including a transient failure inside the visible review turn, which stays retryable instead of becoming a terminal callback failure. Invalid task ids, missing final agent messages and terminal failures are persisted as an idempotent `submission_notice` and wake the original DSH session exactly once, including after a plugin restart.

A passing verdict tells DSH to report once and end the turn without calling `memory`, status, todo, shell, or workflow tools. If the terminal relay still leaves that exact agent activity running, a lifecycle guard cancels only the active turn after `terminalRelayTimeoutMs` while preserving queued inbox work. The guard disarms as soon as that activity reaches idle, so it cannot cancel a later user turn, and plugin teardown aborts and awaits all pending guards.

After Planner work completes, the managed App Server still follows its idle grace period. Reviewer operations are tracked as active turns, and `cancel`, timeout, lease loss, and `stop()` interrupt and await them before the App Server is stopped; review completion never reopens or refreshes Desktop.

`dsh-codex-workflow respond` is a **manual/compat fallback only** — for operators who want to type a verdict in by hand instead of letting the automatic path collect it, or to re-drive a verdict after the automatic pipeline was interrupted:

```powershell
$verdict = '{"verdict":"pass","findings":[],"testGaps":[],"summary":"ok"}'
$verdict | dsh-codex-workflow respond --workflow <workflowId> --codex-thread $env:CODEX_THREAD_ID --submission <submissionId> --stdin
dsh-codex-workflow status --request <requestId> --json
```

`--submission <uuid>` (optional in `respond`) pins the verdict to the exact submission the review answered; without it the legacy behavior applies only when the workflow has no active submission. Every `respond` is validated, idempotent per request id, and replayed safely — it never bypasses the evidence-fingerprint check (a verdict whose workspace changed since review is refused).

The verdict is applied in the original DSH session with the same blocking/non-blocking/no-change/max-cycle policy as the DSH-led flow: blocking findings return DSH to `fixing` (then re-`submit`), only non-blocking findings stop at `waiting_review_decision` for the user, and `pass` completes the workflow. If the workspace changed between submission and verdict, the verdict is refused and DSH is asked to re-`submit` for a fresh review — an old verdict can never pass changed code.

### CODEX_THREAD_ID

The bridge never invents the source task id. `dispatch`/`respond` default `--codex-thread` from `CODEX_THREAD_ID` and fail with a paste-ready explanation when it is absent. The stored id is the workflow's ORIGIN task: the callback validates it read-only and then creates/resumes the dedicated visible **Reviewer** task, so the origin task is never resumed, renamed or written (1.1.0) and the review is visible in Desktop (1.1.2).

## DSH-led flow (legacy, compatible)

Both `codex_workflow_review` and `codex_workflow_review_only` run the SAME pipeline: the visible review turn executes on the App Server — creating (and naming) the dedicated Reviewer task on the first round — while the structured conversion runs in an independent `codex exec --ephemeral` session. The Reviewer identity is persisted before the conversion, so a round that fails during review or conversion keeps the same task for the retry, and an existing task that cannot be loaded still fails instead of being silently replaced. The first round never has to resume an empty App Server task: the turn that creates the Reviewer also runs on it.

`pnpm review-only:accept` is a manual, live-login harness for the legacy CLI-visible layout; like `lifecycle:accept` it predates the App-Server-visible Reviewer and is not part of the release gate — use `pnpm verify` and `pnpm release:check`.

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
first sending: read-only origin validation -> create + run the first visible turn on a dedicated App Server Reviewer task; later sending: resume that same Reviewer task
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
- Reviewer turns bind the exact DSH workspace cwd and run read-only (`sandboxPolicy: readOnly`, no network, `approvalPolicy: never`); Git, non-Git and nested-repository workspaces use the same path. The `codex exec --ephemeral` conversions are equally read-only (`--sandbox read-only`, `approval_policy=never`) and require no Git root.
- The dedicated Reviewer task is the only review target. An active writer on the Planner/origin task is irrelevant (1.1.0); a writer conflict on the Reviewer itself remains retryable with bounded backoff, and the plugin never creates a replacement visible task to bypass it. A legacy CLI-created Reviewer is replaced once, by design, because it can never be rendered (1.1.2).
- Cancellation interrupts the exact active Planner/reviewer turn or ephemeral fork. Submission leases prevent a stale owner from applying a newer review, and `stop()` interrupts and awaits every reviewer operation before the App Server is stopped; provisional normalization/alignment JSON never becomes `latestReview`.

## Storage

Workflow records, leases, the bridge queue and the **live-session registry all live in ONE SQLite database**: `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite`. The only state on disk outside it is `bridge/review-schema.json` (the enforced verdict schema) and, briefly, the legacy file-queue source directories that are **imported once on first init** (receipts, retry semantics and attempts preserved). `bridge/sessions.json` is gone — live sessions are rows in `coord.sqlite` (`live_sessions`) with per-owner leases, so multi-process runtimes merge instead of last-writer-wins and a crashed runtime's sessions expire via TTL. Records never contain login tokens. Old JSON workflow records are imported lazily with `origin: "dsh"` and keep their behavior.

## Operations CLI

`dsh-codex-workflow` is also the audit/ops surface (all commands support `--json`):

- `workflows [--cwd] [--dsh-session] [--phase]` — list workflow summaries (never payloads).
- `show --workflow <id>` — plugin version plus one workflow's source/review task ids, stage, submission/callback state, review cycle, last error and evidence summary. Since 1.1.0 the Reviewer id always names a dedicated Reviewer task, distinct from the Planner/source id; since 1.1.2 that task is App Server-created (visible in Desktop, named `DSH Reviewer: <workflowId>`). The internal origin marker (`reviewerThreadOrigin`) is never surfaced here. Records written before 1.1.2 may still show a CLI-created id until their next review migrates them.
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
- `transientRetryBaseMs`: `3000` (200 ms–5 min; first backoff for a TRANSIENT upstream failure)
- `transientRetryMaxMs`: `60000` (200 ms–15 min; per-attempt backoff ceiling)
- `transientRetryBudgetMs`: `1200000` (0–2 h; total wall clock one operation may spend retrying; `0` disables automatic retry)
- `transientRetryJitterRatio`: `0.25` (0–1; ±jitter applied to every backoff)
- `reviewHeartbeatMs`: `15000` (250 ms–5 min; period of the DSH-owned Review heartbeat that keeps `lastProgressAt`/`reviewElapsedMs` fresh without depending on model output)
- `reviewStaleMs`: `60000` (1 s–24 h; a review whose last heartbeat is older than this is reported as `stale`)
- `turnTimeoutMs`: `600000`
- `idleProcessMs`: `5000` (starts only after all App Server work is idle)
- `terminalRelayTimeoutMs`: `60000` (0 disables; maximum 10 minutes; cancels only a stuck terminal pass relay and preserves inbox work)
- `openCodexDesktopOnReview`: compatibility field; the plugin never auto-opens, refreshes or focuses Codex Desktop after a review — the Reviewer task is visible in the sidebar by construction (1.1.2) and the user opens it when convenient
- `desktopOpenRetryBaseMs`: `2000` (200 ms–60 s; initial retry backoff)
- `desktopOpenRetryMaxMs`: `60000` (1–60 s; capped retry backoff)

State lives in `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite` (queue + leases + workflows + live sessions); `bridge/review-schema.json` holds the enforced verdict schema. Records never contain login tokens.

## License

MIT
