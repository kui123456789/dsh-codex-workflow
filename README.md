# dsh-codex-workflow

DeepSeek Harness plugin that gives Codex read-only planning/review roles while DSH remains the sole executor. Two flows share the same workflow engine:

- **Codex-led bridge (preferred)** — the Codex task that produced the plan sends it to the exact live DSH session through a durable SQLite bridge; DSH implements it, and the plugin appends every readable audit to that same Codex task before returning the verdict to the original DSH session.
- **DSH-led tools** — the DSH agent can autonomously start `codex_workflow_start` for complex development tasks, or the user can request it explicitly; implementation and review still run through the same workflow engine.

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

`pnpm run lifecycle:accept` runs the real review-persistence acceptance against your Codex App Server (needs a login): a durable Planner completes a readable Plan-mode turn, the plugin converts it through an ephemeral fork, and the acceptance proves the persisted plan has no JSON envelope while the fork NEVER appears in `thread/list` — polled WHILE its conversion turn is active and again after unsubscribe (`thread/list` is required; unavailability fails the gate instead of silently passing). Beyond the protocol probes it drives the REAL plugin stack: a narrow two-file defect workflow goes through `WorkflowManager.start` → real `review/start` on the ORIGINAL planner task → `changes_requested` → DSH fixes exactly per the approved plan → a real passing round on the SAME task id (≤ 3 rounds; round 2 not passing fails the acceptance with the Reviewer's real findings instead of a third identical submission); then a Codex-bridge workflow resumes its REAL source task via the background callback and delivers the verdict followup back to the DSH session; teardown during an in-flight normalization settles deterministically. The protocol acceptance defaults to low reasoning and the production-aligned 600-second turn timeout; `DSH_CODEX_LIFECYCLE_MODEL`, `DSH_CODEX_LIFECYCLE_EFFORT`, and `DSH_CODEX_LIFECYCLE_TIMEOUT_MS` can pin a slower/faster local acceptance environment without changing plugin runtime defaults.

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
Planner/source Codex task --thread/read(includeTurns:false)--> validated
same task --thread/resume + turn/start--> visible Markdown review
same task --thread/fork(ephemeral:true)--> outputSchema conversion --> JSON verdict
```

The first successful review binding persists `reviewerThreadId` as the same value as the original `codexThreadId`; every later repair review resumes it again. If Codex Desktop still owns the task's active writer, the callback records a retryable busy state and waits instead of creating another task. Every review turn is pinned to the workflow cwd with `read-only`, network disabled and `approvalPolicy: never`. Existing workflows that already have a distinct Reviewer id keep using that old task unchanged.

**The durable workflow history is human-readable.** Visible Planner/Reviewer turns never carry an `outputSchema` and never emit JSON: each review is readable Markdown (VERDICT / FINDINGS with severity, blocking and file:line / TEST GAPS / SUMMARY) in the original task's language. The structured verdict is produced by an **ephemeral conversion fork** (`thread/fork` with `ephemeral: true`, then one read-only `turn/start` carrying the schema, the same model at effort `low`). The fork never lands in the persisted history and is unsubscribed exactly once on every ending path; its id is never persisted into `plannerThreadId`/`reviewerThreadId`.

**Every review turn carries its own full context — Git included.** Every DSH-led `review/start` uses the SAME custom target (`{ type: "custom", instructions: ... }`) for Git and non-Git workspaces alike. The instructions embed the complete per-round context (workflow identity, original task, approved plan, the PREVIOUS APPLIED REVIEW and this round's fix summary, implementation summary, changed files, test results, bounded workspace evidence-diff), the review scope, and the item-by-item coverage gate: for Git workspaces the scope pins the review to the current staged/unstaged/untracked changes and requires an independent read-only `git status`/`git diff` check. The Reviewer thread's developer instructions (`thread/settings/update`) stay populated only as an auxiliary refresh: verdict correctness never depends on them, because a native review turn may not reliably see hidden thread settings.

**Review authority alignment (1.0.10).** After the visible review is normalized into the structured verdict, an INVISIBLE ephemeral fork (same read-only conversion machinery, low effort) checks every finding/test gap against an authority hierarchy: 1. a REPRODUCIBLE critical/high correctness/security/data-corruption defect (must carry concrete file:line + failing-scenario evidence) > 2. the ORIGINAL TASK and its explicit constraints (file scope, exact test counts, dependency limits, acceptance method) > 3. the APPROVED PLAN > 4. the previously applied findings and the current fix summary > 5. generic quality suggestions. Ordinary scope/test-count/verification-method conflicts resolve in the plan's favor: automated tests, STATIC CHECKS and REAL COMMAND verification are all formal evidence of a requirement — the Reviewer may no longer demand automated tests for behavior the task/plan verifies by real commands, and may not demand changes that exceed the task/plan's explicit bounds (a level-1 exception with reproducible evidence is the only override). The Planner contract mirrors this: it must never strengthen "tests cover A and B" into "exactly two tests" unless the user explicitly limited the count.

**The visible review itself is contract-checked on the PERSISTED history — with one rewrite turn when needed.** The authoritative display text is what `thread/read(includeTurns: true)` actually persists, which can differ from the streamed text the plugin aggregates in memory (real acceptance: a round streamed fine but persisted as Chinese prose + "Full review comments" with no VERDICT/FINDINGS/TEST GAPS/SUMMARY). Before every visible turn (the native review AND the display rewrite) the plugin captures a read-only baseline of the already-persisted turn ids, and after completion it read-backs the text appended since that baseline — the appended turns are located by the baseline id set, never by assuming the RPC turn id equals a persisted one (a real `review/start` appends a text-less review-mode marker turn whose id IS the RPC id, plus a second turn carrying the review text — often the same text rolled out twice, which the read-back treats as one text). Because the persisted rollout can LAG the `turn/completed` event, the read-back polls the history for a bounded window (60 s) and fails closed on timeout; several appended turns with DIFFERENT texts (concurrent writer) stay ambiguous and retryable — a missing/ambiguous read-back is never compensated by the in-memory streamed text. The appended text is validated: non-empty readable Markdown (never a structured JSON envelope), all four required sections present AS SECTION LINES (VERDICT/conclusion, FINDINGS, TEST GAPS, SUMMARY — or their Chinese heads 结论/问题/测试缺口/总结 — each anchored at the start of its own decorated/standalone line; a single paragraph merely CONTAINING the keywords is rejected), and for a Chinese original task the authoritative text must contain Chinese. A violating persisted review — e.g. the English one-liner "The uncommitted implementation strips… all 11 tests pass" or section-less Chinese prose — triggers exactly ONE visible **rewrite turn on the SAME durable Reviewer task** (no `outputSchema`, read-only, low effort, silent): it only re-presents the same verdict/findings/test-gaps in the original task's language with the four exact section lines; it never re-reviews, never adds/removes findings and never creates a second Reviewer. That rewrite turn is persisted like any normal visible turn (cancel/teardown interrupts exactly it) and its READ-BACK final message becomes the authoritative text the ephemeral conversion forks from. If the read-back is missing/ambiguous or the corrected text still violates the contract, the round falls back to the retryable executing/fixing phase — no verdict written, no review cycle consumed, and never a fallback to the in-memory streamed text (fail-open is forbidden). The background `submit` callback applies the same persisted-read-back contract, so a `pass` can never ride a streamed-compliant-but-persisted-violating review through.

**Conflicts never cost the user a review cycle and never ask DSH to change code.** When the authority alignment finds a conflict it does NOT overwrite `latestReview`, does NOT increment `reviewCycles` and does NOT enter `fixing`/send a fix instruction. Instead the plugin appends ONE visible reconciliation turn on the SAME durable Codex task asking the Reviewer to rewrite the complete verdict per the authority hierarchy, then re-normalizes (ephemeral fork) and re-aligns it. An aligned result — including a reconciliation-corrected verdict — is applied as ONE business review cycle; `latestReviewConflict` and `reviewContractFailures` (status surface) record the conflict, whether it was auto-corrected, and the unresolved-conflict streak. After TWO consecutive review calls that still conflict, the workflow becomes `blocked` with a reportable reviewer-contract failure — the Reviewer contract is diagnosed, no code change is demanded, and no user choice popup is shown. The same authority validation runs on the DSH-led path, the background bridge callback, first reviews and re-reviews alike; cancellation/teardown interrupts the exact active turn (visible reconciliation or ephemeral alignment fork) and releases the fork exactly once.

### Reviewer writer-lock semantics

While a review turn is active, the shared workflow task's writer belongs to the managed App Server, so Codex Desktop may show it as “opened in another app”. Do **not** click “Retry”/“Take over”, because that can steal the writer and abort the review. This is temporary: after the verdict or cancellation the plugin calls `thread/unsubscribe` for its subscription, without deleting, archiving or hiding the task; the ephemeral conversion fork is released separately in its own `finally`. Once a verdict is applied and the subscription is released, the bridge automatically opens/focuses `codex://threads/<uuid>` in Codex Desktop (configurable with `openCodexDesktopOnReview`). If Desktop is unavailable, the review remains persisted and the bridge retries the deep link with capped backoff after startup/restart.

### How the verdict comes back (automatic path)

`codex_workflow_submit` returns as soon as the submission and evidence are durably stored and marks that successful tool result as terminal for the current DSH turn. The Reviewer then runs in a manager-owned background task, so the DSH session becomes idle without another model step and ending the tool call cannot cancel the review. The Reviewer stays read-only and answers **as its final message** with a readable Markdown review; the plugin's ephemeral fork converts it into the structured JSON verdict matching the enforced output schema. The DSH plugin process (outside the Codex sandbox) receives the conversion result, validates it, durably stages it in the workflow record, and enqueues it as a `submit_verdict` bridge command with a deterministic per-submission request id. The bridge runtime then applies the verdict and relays the outcome to the original DSH session. The Reviewer never writes the bridge queue itself and never invokes the CLI.

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
- Reviewer App Server calls bind the exact DSH workspace cwd directly, so it may be a Git repository, a non-Git directory, or a workspace containing nested repositories. The Reviewer remains `read-only`, network-disabled, and approval-free.
- The originating Codex task is the review task. Metadata validation is read-only, but an active writer can temporarily block `thread/resume`; that condition stays durably `retrying` with bounded attempts and exponential backoff across DSH restarts. The plugin never creates a replacement visible task to bypass the lock.
- Cancellation interrupts the exact ACTIVE turn — a visible Planner/Reviewer turn or an ephemeral conversion-fork turn (the in-process active-turn map is authoritative, so an ephemeral fork turn id is never mispaired with a persistent thread id; only when nothing is active does cancel fall back to the persisted ids). Submission leases and task/turn ids prevent a stale owner from interrupting or applying a newer review; the DSH workflow and its evidence always remain visible via `codex_workflow_status`, which reports `reviewerActive: true|false` and never surfaces provisional JSON as `latestReview`.

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
- `openCodexDesktopOnReview`: `true` (after a completed review, open/focus the original `codex://threads/<uuid>` in Codex Desktop; set `false` on servers or headless hosts)
- `desktopOpenRetryBaseMs`: `2000` (200 ms–60 s; initial retry backoff)
- `desktopOpenRetryMaxMs`: `60000` (1–60 s; capped retry backoff)

State lives in `$DSH_HOME/storages/dsh-codex-workflow/coord.sqlite` (queue + leases + workflows + live sessions); `bridge/review-schema.json` holds the enforced verdict schema. Records never contain login tokens.

## License

MIT
