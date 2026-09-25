# dsh-codex-workflow

DeepSeek Harness plugin that gives Codex read-only planning/review roles while DSH remains the sole executor. Two flows share the same workflow engine:

- **Codex-led bridge (preferred)** — the Codex task that produced the plan sends it to the exact live DSH session through a durable SQLite bridge; DSH implements it, and the plugin runs the review in private App Server ephemeral threads before returning the verdict to the original DSH session (the originating Codex task is never resumed or written; it receives the outcome through the bridge relay).
- **DSH-led tools** — the DSH agent can autonomously start `codex_workflow_start` for complex development tasks, or the user can request it explicitly; implementation and review still run through the same workflow engine.

No browser is opened or controlled anywhere in the product path; no network listener, MCP, hooks, or skills are involved. Browser clicking is a development-only workaround and is not part of the plugin.

## Execution split (ephemeral review surface)

Planner and Reviewer turns run through the NPM Codex CLI's `codex app-server --stdio`, but plugin-created threads use `thread/start { ephemeral: true }`. They remain available for the current App Server process, do not receive Desktop names, and do not appear in `thread/list`. A restarted DSH process rebuilds a Planner context from the durable workflow record and creates a fresh ephemeral thread. Structured conversion and authority alignment continue to use `codex exec --ephemeral` or an equivalent private App Server turn.

Review progress and results are appended to the owning DSH Session as `dsh-codex-workflow/*` events and folded into the `codexWorkflow` Session projection. The browser half of the plugin registers a `codex-review` right-sidebar tab and opens it once per review round. The tab shows the current plan, progress, readable verdict, findings, test gaps and all rounds of the current workflow. The plugin never opens or focuses Codex Desktop.

## Requirements

- DeepSeek Harness `0.1.7-rc.2` (the verified host baseline; the declared peer range is `^0.1.7-rc.2`)
- Node.js `^22.19.0` or `>=24`
- Codex CLI with a valid ChatGPT login and App Server support (verified by `pnpm doctor`)

### Upgrading after a DSH update

Version 1.1.4 is verified against DSH `0.1.7-rc.2` with cordis `4.0.4`: `pnpm host:check` loads the built plugin against the **operator's installed** core packages (isolated temp storage, no live profile/session/model) and additionally asserts the declared peer range with the host's own `evaluatePluginCompatibility`, so the claim is measured rather than assumed. Other 0.1.x versions are NOT verified by this repository.

Two things matter when the host moves:

- **The host judges the peer range itself.** At profile startup `dsh` checks every `@deepseek-ai/dsh*` peer against the running version and asks for an exact-version exemption when one is unsatisfied (`dsh plugin allow-version`). Its documented semantics let **prereleases participate in ranges**, so a range is not judged by plain npm semver — that is why the gate reuses the host's evaluator instead of re-implementing it. `pnpm doctor` reports the same verdict (SKIPPED, never passed, when no DSH profile exists), so `pnpm release:check` inherits it.
- **Source installs must refresh their own dependencies.** `pnpm install` (plus `pnpm build`) after a host upgrade; upgrading `dsh` alone does not update a linked plugin's `node_modules`, and the plugin's `src` is type-checked against the versions pinned in its own `devDependencies`.

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

The pre-1.1.0 manual harnesses (`pnpm lifecycle:accept`, `pnpm review-only:accept`) were REMOVED: they drove the legacy CLI-visible wiring, predated the dedicated-Reviewer and App-Server-visible layouts, and could no longer be trusted as acceptance evidence. The gates that replaced them are the automated ones above plus `pnpm host:check` and an independent review round.

## Codex-led flow (preferred)

From the Codex task that owns the plan, dispatch it to the live DSH session:

```powershell
# 1. Find the live DSH session for this workspace
dsh-codex-workflow sessions --cwd $PWD --json

# 2. Dispatch the plan (payload enters through stdin, never arguments)
$payload = '{"task":"实现搜索功能","planMarkdown":"<proposed_plan>…</proposed_plan>","assumptions":[]}'
$payload | dsh-codex-workflow dispatch --cwd $PWD --codex-thread $env:CODEX_THREAD_ID --stdin
```

The bridge resolves the exact session (explicit `--dsh-session` wins; otherwise the cwd must match exactly one live session, and ambiguity fails loudly). DSH receives the plan as a plugin relay message and implements it. When done, DSH calls `codex_workflow_submit`; the plugin validates the **exact stored Codex task id** read-only, then runs the readable audit in a fresh private Reviewer thread. The originating task is never resumed and never written:

```text
Planner/source Codex task --App Server--> readable plan
private ephemeral Reviewer thread --App Server thread/start + review/start--> readable Markdown review/rewrite
private ephemeral conversion --codex exec --ephemeral --output-schema--> normalization/alignment JSON
```

**Planner and Reviewer threads created by 1.1.7 are ephemeral.** Each Planner or Reviewer starts with `thread/start { ephemeral: true }`, is used by the current NPM Codex CLI App Server process, and is never named or persisted as a new `plannerThreadId`/`reviewerThreadId`. Ephemeral ids do not appear in `thread/list`, so Codex Desktop does not load them or hold their writer locks. A second review always creates a new ephemeral Reviewer and never calls `thread/resume` on an old Reviewer. Legacy ids remain readable for diagnostics only; they are not resumed, renamed or handed off. After a DSH restart, the Planner context is reconstructed from the workflow record and a new ephemeral thread is created. The visible turn receives the configured `<reviewerModel>` and `<reviewerEffort>`; a blank model uses the resolved default.

**The DSH session history is human-readable.** Visible Planner/Reviewer turns never carry an `outputSchema`: each review is readable Markdown (VERDICT / FINDINGS with severity, blocking and file:line / TEST GAPS / SUMMARY) in the original task's language. Structured normalization and authority alignment use independent `codex exec --ephemeral` sessions with the same effective model and `model_reasoning_effort="low"`; they never use `resume`, never create a durable task, never enter Desktop history, and never persist an internal id into `plannerThreadId`, `reviewerThreadId`, or `codexThreadId`.

**Every review turn carries its own full context — Git included.** DSH-led, bridge callback, first review and re-review all reuse the existing review prompt generator. The `review/start` custom target (and the App Server turn on the callback path) carries workflow identity, original task, approved plan, PREVIOUS APPLIED REVIEW, current fix summary, implementation summary, changed files, test results, bounded evidence, review scope, and the item-by-item authority gate. Git workspaces require independent read-only `git status`/`git diff`; non-Git workspaces use the same contract without inventing a different Reviewer policy.

**Review authority alignment (1.0.10).** After the visible review is normalized into the structured verdict, an INVISIBLE ephemeral fork (same read-only conversion machinery, low effort) checks every finding/test gap against an authority hierarchy: 1. a REPRODUCIBLE critical/high correctness/security/data-corruption defect (must carry concrete file:line + failing-scenario evidence) > 2. the ORIGINAL TASK and its explicit constraints (file scope, exact test counts, dependency limits, acceptance method) > 3. the APPROVED PLAN > 4. the previously applied findings and the current fix summary > 5. generic quality suggestions. Ordinary scope/test-count/verification-method conflicts resolve in the plan's favor: automated tests, STATIC CHECKS and REAL COMMAND verification are all formal evidence of a requirement — the Reviewer may no longer demand automated tests for behavior the task/plan verifies by real commands, and may not demand changes that exceed the task/plan's explicit bounds (a level-1 exception with reproducible evidence is the only override). The Planner contract mirrors this: it must never strengthen "tests cover A and B" into "exactly two tests" unless the user explicitly limited the count.

**The visible review is contract-checked before it reaches DSH.** The readable Markdown is projected into the owning DSH Session as namespaced `dsh-codex-workflow/*` events. The browser client folds those events into the `codexWorkflow` projection and opens the `codex-review` right-sidebar tab once per review round. A structured ReviewResult envelope is never accepted as visible output; a display violation runs one corrective private turn. Nothing on the completion path calls the Desktop opener or any navigation/refresh API.

**Conflicts never cost the user a review cycle and never ask DSH to change code.** A conflict does not overwrite `latestReview`, increment `reviewCycles`, enter `fixing`, or send a fix instruction. One reconciliation turn may rewrite the complete verdict on the same ephemeral Reviewer; its prompt contains an explicit preservation manifest for every non-conflicting finding/test gap. Deterministic multiset checks reject deletion, field changes, duplicate-count drift and unrelated additions before re-alignment. A successful correction applies as one business cycle; two consecutive unresolved contract conflicts block without consuming a cycle.

### Reviewer writer-lock semantics

Before an App Server review turn, the plugin uses the newly created ephemeral Reviewer already held by that App Server client. It never resumes a previous Reviewer, never names the ephemeral thread and never invokes the Desktop opener. Legacy opener fields remain compatible but audit records keep `desktopOpenState: "disabled"`.

**Desktop cannot lock a new 1.1.7 review.** Because plugin-created Planner and Reviewer threads are ephemeral and omitted from `thread/list`, opening an old Desktop task cannot block a new review. Control RPC failures remain bounded and retryable, but no retry resumes or reuses a legacy Desktop task.

Ephemeral threads are released with the App Server process lifecycle. Cancellation and teardown interrupt the exact active turn or conversion fork before the client stops; no Desktop task is reopened or refreshed.

### Host compatibility (DSH 0.1.7 contract, introduced in 1.1.3)

DSH `0.1.7` replaced the shared catch-all `plugin` message source with a **merge-extensible sum type**: `MessageSourceMap` is augmented by each producer in its own module, and `MessageSource.kind` answers *who produced this* while `form` answers *what kind of thing it is* (the two axes are deliberately independent). There is no `plugin` kind to borrow any more.

The plugin therefore declares its own kind in `src/message-source.ts` — exactly the way first-party producers such as `dsh-agent-instructions` do — and builds every injected message from it (`relaySource()` for a plan handoff / verdict / outcome, `noticeSource(summary)` for a one-off notice). A cast would have compiled, but it would have hidden the contract from the compiler and left the harness unable to attribute this plugin's context to a declared producer.

### Transient upstream failures are retried (1.1.1)

Capacity and throttling problems are temporary, so they never end a workflow any more. One shared policy (`src/transient-retry.ts`) classifies `server_overloaded` / "Selected model is at capacity" / 429 / `usage limit` / 502-504 / dropped streams / a thread writer held by another process, and retries the operation with exponential backoff plus jitter inside `transientRetryBudgetMs` (default 20 minutes). It covers every VISIBLE App Server turn — planner start/continue, the completion turn, the DSH-led `review/start` review turn, the display rewrite and reconciliation — plus the callback path's visible turn (which stays `retryable_busy` for the bounded callback retry and the periodic `recoverCallbacks` sweep) and the CLI audit's ephemeral conversions (`normalize`, `align`, `reconcile`).

Terminal conditions are never retried: a thread that does not exist, schema or display-contract violations, approvals, and any cancellation. A visible turn is retried only when it failed WITHOUT producing visible output, so a retry can never duplicate a plan, an audit or a rewrite, and a pending backoff is interrupted immediately by cancel/teardown. When the budget is spent the outcome stays RETRYABLE (the workflow records the reason and the user can run it again) — it is never reported as a terminal failure. Long diagnostics keep head AND tail, so the persisted error always shows the real reason.

### Review progress and heartbeats (1.1.2)

A running review is observable from the durable record, not from model output. Each attempt persists `processState` (`running` / `waiting` / `completed` / `failed` / `cancelled` / `stale`), `reviewStep` (`review_native_turn`, `review_readback`, `review_display_rewrite`, `review_conversion`, `review_alignment`, `review_reconciliation`, `review_finalizing`), `reviewAttempt`, `reviewStartedAt`, `lastProgressAt`, `reviewElapsedMs`, `activeTurnId` and a short `lastProgressMessage` — safe phase diagnostics only, never model text or raw JSONL. `codex_workflow_status` returns them with the record.

An independent DSH-owned timer (`reviewHeartbeatMs`) keeps the heartbeat fresh while a review runs, so a wedged review is visible even when the model produces nothing; `status` reports `stale` once the last heartbeat is older than `reviewStaleMs`, and completion, failure, cancellation and teardown stop the timer and record the terminal state.

### How the verdict comes back (automatic path)

`codex_workflow_submit` returns as soon as the submission and evidence are durably stored. A manager-owned App Server review runs in a fresh ephemeral Reviewer; `codex exec --ephemeral` normalization/alignment produce the internal structured result. The plugin validates and stages that verdict, enqueues the deterministic `submit_verdict`, and the bridge runtime relays the outcome to the original DSH session. The review never writes the bridge queue itself.

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

The bridge never invents the source task id. `dispatch`/`respond` default `--codex-thread` from `CODEX_THREAD_ID` and fail with a paste-ready explanation when it is absent. The stored id is the workflow's ORIGIN task: the callback validates it read-only and then creates a private ephemeral Reviewer, so the origin task is never resumed, renamed or written and the review is projected into the owning DSH session.

## DSH-led flow

Both `codex_workflow_review` and `codex_workflow_review_only` run the same pipeline: each round creates a fresh ephemeral Reviewer in the NPM Codex CLI App Server, runs the readable review and private structured conversions, then emits the full result to the DSH Session projection. No new Planner/Reviewer thread id is persisted, and a retry or later round never resumes a legacy Desktop task.

The legacy `pnpm review-only:accept` harness was removed with `pnpm lifecycle:accept` (see above); use the automated gates instead.

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
each sending: read-only origin validation -> create + run a fresh ephemeral App Server Reviewer task
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
- Each review round has its own ephemeral Reviewer target. An active writer on the Planner/origin task or an old Desktop task is irrelevant; legacy Reviewer ids are diagnostic only and are never resumed.
- Cancellation interrupts the exact active Planner/reviewer turn or ephemeral fork. Submission leases prevent a stale owner from applying a newer review, and `stop()` interrupts and awaits every reviewer operation before the App Server is stopped; provisional normalization/alignment JSON never becomes `latestReview`.

## Storage

Workflow records, leases, the bridge queue and the **live-session registry all live in ONE SQLite database**: `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite`. The only state on disk outside it is `bridge/review-schema.json` (the enforced verdict schema) and, briefly, the legacy file-queue source directories that are **imported once on first init** (receipts, retry semantics and attempts preserved). `bridge/sessions.json` is gone — live sessions are rows in `coord.sqlite` (`live_sessions`) with per-owner leases, so multi-process runtimes merge instead of last-writer-wins and a crashed runtime's sessions expire via TTL. Records never contain login tokens. Old JSON workflow records are imported lazily with `origin: "dsh"` and keep their behavior.

## Operations CLI

`dsh-codex-workflow` is also the audit/ops surface (all commands support `--json`):

- `workflows [--cwd] [--dsh-session] [--phase]` — list workflow summaries (never payloads).
- `show --workflow <id>` — plugin version plus source task id (if supplied externally), stage, submission/callback state, review cycle, last error and evidence summary. New ephemeral Planner/Reviewer ids are process-local and are not persisted; legacy ids remain available only for diagnostics. The internal origin marker (`reviewerThreadOrigin`) is never surfaced here.
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
- `reviewerReleaseTimeoutMs`: `10000` (250 ms–5 min; deadline for the round's Reviewer-subscription release — the cleanup takes no business signal, so this bound is what keeps a hung `thread/unsubscribe` from wedging the round and its cancel/teardown)
- `turnTimeoutMs`: `600000`
- `idleProcessMs`: `5000` (starts only after all App Server work is idle)
- `terminalRelayTimeoutMs`: `60000` (0 disables; maximum 10 minutes; cancels only a stuck terminal pass relay and preserves inbox work)
- `openCodexDesktopOnReview`: compatibility field; the plugin never auto-opens, refreshes or focuses Codex Desktop. Review content is shown in the DSH `Codex Review` right sidebar.
- `desktopOpenRetryBaseMs`: `2000` (200 ms–60 s; initial retry backoff)
- `desktopOpenRetryMaxMs`: `60000` (1–60 s; capped retry backoff)

State lives in `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite` (queue + leases + workflows + live sessions); `bridge/review-schema.json` holds the enforced verdict schema. Records never contain login tokens.

## License

MIT
