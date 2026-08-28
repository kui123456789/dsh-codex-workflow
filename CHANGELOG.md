# Changelog

All notable changes to `dsh-codex-workflow`.

## [1.0.10] - Unreleased

### Added

- **Review authority alignment.** After the visible review is normalized into the structured verdict, an invisible ephemeral fork (same read-only conversion machinery, same model, low effort, INTERNAL output schema — never the public ReviewResult, never a tool parameter, never bridge protocol) checks every finding/test gap against the authority hierarchy: reproducible critical/high correctness/security/data-corruption defect (needs concrete code evidence) > ORIGINAL TASK and its explicit constraints > APPROVED PLAN > previously applied findings + current fix summary > generic quality suggestions. Output is `aligned` or `conflict` entries (kind, index, reason, violated constraint/plan entry, high-severity exception flag) covering findings AND test gaps.
- **One visible reconciliation correction per review call.** A conflict does NOT overwrite `latestReview`, does NOT consume a review cycle and does NOT enter `fixing` or send a fix instruction: the plugin appends ONE visible reconciliation turn on the SAME durable Codex task asking the Reviewer to rewrite the complete verdict per the hierarchy (same display contract, read-back enforced on the persisted history), then re-normalizes and re-aligns it. Reconciliation-corrected aligned verdicts apply as ONE business cycle; still-conflicting review calls restore the pre-review executing/fixing phase with a recorded review-contract error.
- **Two consecutive unresolved conflicts block the workflow.** `reviewContractFailures` counts consecutive review calls (DSH-led rounds AND bridge submissions) ending unresolved; an aligned review resets it to 0, and a second consecutive conflict moves the workflow to `blocked` with a reportable reviewer-contract failure (no code changes required, no user choice popup). DSH-led and bridge paths share the same validation, first reviews and re-reviews alike; cancel/teardown interrupts the exact active turn (visible reconciliation or ephemeral alignment fork) and releases the fork exactly once.
- **Durable conflict audit.** `WorkflowRecord` gains optional `reviewContractFailures` (default 0 for old records) and `latestReviewConflict` (conflicts, reconciled, resolved, at); `schemaVersion` stays 1 and the SQLite schema is unchanged. `codex_workflow_status`/`show` surface the latest conflict and whether it was auto-corrected; `latestReview` only ever holds applied verdicts.
- **Per-round review context includes the previous applied verdict.** Every review prompt (DSH-led custom target and background callback) now embeds PREVIOUS APPLIED REVIEW (the findings DSH was asked to fix) alongside the current implementation summary, so a later round cannot reverse an earlier applied verdict without justification. The review-authority alignment prompt additionally quotes the PREVIOUSLY APPLIED REVIEW and THIS round's fix summary (bridge path: the persisted `pendingReviewRequest`) as level-4 evidence, so a legitimately carried-forward finding is never misjudged as a generic conflict.
- **The unresolved-conflict streak resets on every aligned bridge round.** An aligned verdict (with or without a reconciliation correction) clears `reviewContractFailures` at staging time, so a NON-consecutive conflict never accumulates toward the two-strike block; an unresolved conflict restores the exact pre-review phase (executing OR fixing).

### Fixed

- **Planner contract: no invented count limits.** The planner prompt forbids strengthening "tests must cover A and B" into an exact test-COUNT restriction ("exactly two tests") unless the user explicitly limited the count, and accepts the task's own verification method (automated tests, static checks or real command verification) as formal evidence.
- **Reviewer contract: the absolute code+test rule is gone.** The item-by-item coverage gate no longer demands BOTH an implementation AND a regression test for every explicit requirement. Verification evidence follows the method the task/plan names (automated tests, static checks, REAL COMMAND verification); missing automated tests alone are blocking only when the task/plan explicitly requires them or a concrete regression risk is demonstrated, and reviewers may no longer demand changes exceeding the task/plan's explicit file count, test count, scope, dependency limits or manual acceptance method.
- **Turn-stopping no longer nudges fixes after a contract conflict.** `onTurnStopping` skips the "finish the fixes" steer while the record reports an unresolved review-contract conflict.

### Changed

- Tool budgets cover the new authority path: `REVIEW_MAX_TURNS` is now 7 (native review + display rewrite + conversion + alignment fork + reconciliation turn + second conversion + second alignment), the review timeout reserves a third persisted-read-back window, and `MAX_SERIAL_RPCS` grows to 40 — provably never pre-empted by the host at the 600 s turn ceiling.
- Package and runtime version are now `1.0.10`; no WorkflowRecord or SQLite migration is required.

## [1.0.9] - Unreleased

### Added

- **DSH autonomous planning trigger.** The plugin now injects a dedicated `systemPrompt` policy that allows the current DSH model to call `codex_workflow_start` before implementation when a development task is complex. The default `autoTriggerMode: complex` covers cross-file/architectural/security/lifecycle/release work and root-cause-unclear defects; `always` covers every write-intent development task, while `off` keeps explicit tool use only.
- **Explicit trigger exclusions and user override.** Questions, read-only work, Git-only operations, clear low-risk local edits, plugin-generated workflow messages and sessions with an active workflow do not auto-trigger. A user instruction to work directly, skip planning or avoid Codex always wins, and DSH announces an autonomous trigger before calling the Planner exactly once.

### Fixed

- **Concurrent DSH starts are fenced.** The DSH-led Planner path now uses the same session-scoped SQLite creation lease as bridge dispatch. Concurrent attempts for one session can create only one WorkflowRecord and one Planner task; the loser receives a clear instruction to continue or inspect the active workflow.

### Changed

- `codex_workflow_start` now documents autonomous pre-change use and the one-workflow-per-session rule.
- Package and runtime version are now `1.0.9`; no WorkflowRecord or SQLite migration is required.

## [1.0.8] - 2026-08-27

### Changed

- **One visible Codex task per planned workflow.** After DSH implements the plan, the readable review is appended to the original Planner/source Codex task instead of creating a separately visible Reviewer task. Every repair review resumes that same task, so planning, implementation handoff and audit history stay together in Codex Desktop.
- **Bridge workflows reuse `codexThreadId`.** The first background review validates the source task with `thread/read(includeTurns:false)`, resumes that exact task and persists the same id as `reviewerThreadId` for existing status/cancel/recovery contracts. If the task still has an active writer, the submission remains durably retryable; the plugin never escapes the conflict by opening another visible task.
- **DSH-led planned workflows reuse `plannerThreadId`.** The first `codex_workflow_review` resumes the Planner task and refreshes the read-only review contract there. `review_only` still creates one review task because no Planner exists.
- **Backward compatibility.** Workflows that already persisted a distinct `reviewerThreadId` continue resuming it without migration. Ephemeral JSON normalization, persisted Markdown read-back, display rewrite, cancellation, restart recovery and review-cycle rules are unchanged.
- Package and runtime version are now `1.0.8`.

### Fixed

- Codex Desktop no longer accumulates a second visible task for every planned workflow's audit phase.
- Cancellation and teardown now target the active review turn even when it runs on the original Planner/source task; the ephemeral conversion fork remains separately tracked and invisible.

### Changed (acceptance hardening)

- **Display contract sections are line-anchored.** Each required readable section (VERDICT/结论, FINDINGS/问题, TEST GAPS/测试缺口, SUMMARY/总结) must now appear as a section LINE (start of its standalone, optionally markdown-decorated line); a single paragraph that merely contains the keywords no longer satisfies the contract and correctly triggers the one rewrite turn.
- **Persisted read-back tolerates the real roll-out shape.** The read-back now polls a bounded 60 s window for the appended text (tolerating rollout lag), accepts the review text rolled out twice (marker-turn `exitedReviewMode.review` + streamed `agentMessage`), and stays fail-closed on different-text ambiguity or timeout — never falling back to the in-memory streamed text.
- **Tool timeouts cover the worst-case serial paths.** `codex_workflow_start`/`continue` reserve FOUR serial turns (visible + conversion + completion + conversion) and `codex_workflow_review`/`review_only` THREE (native + display rewrite + conversion), plus `MAX_SERIAL_RPCS = 20` for the control RPCs of those paths and one bounded read-back window per readable turn — provably never pre-empted by the host at the production-aligned 600 s turn ceiling.
- **`lifecycle:accept` is a REAL plugin E2E, not a client probe.** It drives `WorkflowManager.start` → real `review/start` on the ORIGINAL planner task → `changes_requested` → DSH fix → pass on the SAME task id within the fixed 3-round limit (round 2 not passing fails with the Reviewer's real findings; no third identical submission), plus a Codex-bridge background-callback round reusing its real source task; `thread/list` is REQUIRED for the ephemeral-invisibility gate and the fork is polled WHILE its conversion turn is active.

## [1.0.7] - 2026-08-27

### Changed

- **Codex Desktop no longer shows raw JSON in the durable task history.** The persistent Planner and Reviewer tasks only ever produce human-readable Markdown in the original task's language; all structured output moves to an ephemeral `thread/fork` (`ephemeral: true`) inside the managed App Server, so the JSON conversion turns never land in the visible thread history.
- **Ephemeral fork conversion (new client capability).** `normalizeInFork` forks the source thread with `ephemeral: true` and runs one read-only conversion `turn/start` inside it: `approvalPolicy: never`, `sandboxPolicy: readOnly` + `networkAccess: false` per turn, the enforced output schema, the SAME model as the source task, effort fixed at `low`, and the non-collaborative "default" mode with JSON-only conversion `developer_instructions`. Every ending path — success, turn failure, cancellation, timeout — unsubscribes the fork exactly once (`unsubscribed`/`notSubscribed`/`notLoaded` all count as release). Fork ids are transient and are NEVER persisted into `plannerThreadId`/`reviewerThreadId`.
- **Planner**: the visible turn keeps Plan mode but drops `outputSchema`; Codex persists Plan-mode output as a readable Markdown item — a `plan` item on the first generation, and legitimately an `agentMessage` item after a native clarification/continue path (both render as readable plans in Desktop; literal XML tags are not part of the model-output contract). The visible reply must be a non-empty, complete decision-complete plan in the task's language with NO structured-JSON envelope (an empty reply or a leaked `status`/`planMarkdown` envelope fails the workflow BEFORE any conversion fork), clarification goes through the native input request (or fallback numbered questions) and failures are readable explanations. **READY is only accepted when the CURRENT visible reply ITSELF is a complete plan**: a confirmation/acknowledgement ("已确认…后续将规划…"), a promise to plan later, a short summary or an answer-only reply is NEVER injected — when the conversion nevertheless said ready, the plugin runs ONE controlled completion turn on the SAME persistent Planner task (a normal visible Plan-mode turn that reuses the same task id and is cleaned from the active-turn mapping on EVERY ending path via try/finally) and re-converts; only a genuinely complete plan from one of the replies enters executing, otherwise the workflow FAILS without writing planMarkdown. The final visible item TYPE of a completed turn is surfaced as the audit field `TurnCompleteResult.itemType` (round 1 `plan`, clarification resume `plan`/`agentMessage`), but it is NOT a readiness gate. After each completed visible reply (first planning, completion turn and every `continue`, which always reuses the original Planner task) an ephemeral fork converts it into the existing `PlannerResult`. **Planner normalization failure is terminal**: the workflow fails and the raw Markdown is never accepted as a plan.
- **Reviewer (all four paths — first review, re-review, DSH-led review, background `submit` callback)**: the visible Reviewer turns now emit a readable Markdown review (VERDICT / FINDINGS with severity, blocking, file:line / TEST GAPS / SUMMARY, in the original task's language) instead of a JSON verdict; the JSON verdict is derived by the ephemeral conversion fork. **Reviewer normalization failure stays retryable and consumes no review cycle.** Re-reviews keep reusing the same persistent Reviewer task.
- **The visible-review display contract is enforced on the PERSISTED history BEFORE the ephemeral conversion — with ONE controlled rewrite turn on the SAME durable Reviewer task when the persisted review violates it.** Fixes the acceptance defect where a round could end on an English one-liner ("The uncommitted implementation strips… all 11 tests pass") without the required sections, and where a round's PERSISTED text (Chinese prose + "Full review comments") lacked the four sections even though the streamed text looked fine: after `review/start` completes, the DSH-led path READ-BACKS the actually-persisted final `agentMessage`/`plan`/`exitedReviewMode` text of the round's appended turn (`thread/read(includeTurns: true)`, located via a pre-turn baseline id set — the RPC turn id is never assumed to equal the persisted rollout id) and validates THAT text (non-empty, NOT a structured JSON envelope, the four readable sections verdict/conclusion + findings + test gaps + summary — each may say "none" — and for a Chinese original task the authoritative text must contain Chinese). A violating persisted review triggers exactly ONE visible rewrite turn on the SAME persistent Reviewer task (no `outputSchema`, read-only/network-disabled/approval-never per turn, low effort, silent): it only re-presents the SAME verdict/findings/test-gaps in the original task's language with the fixed sections, never re-reviews, never adds/removes findings and never creates a second Reviewer; the rewrite turn is persisted like any visible turn and its READ-BACK final message becomes the AUTHORITATIVE text for the ephemeral conversion. If the read-back is missing/ambiguous (zero or several appended turns, not yet completed) or the corrected text still violates the contract, the workflow returns to its retryable executing/fixing phase — no `latestReview`, no consumed review cycle, and NEVER a fail-open fallback to the in-memory streamed text. The rewrite turn is registered as the ACTIVE visible turn, so cancel/teardown interrupt exactly it (thread id unchanged). The background `submit` callback path applies the SAME persisted-read-back contract on the same durable Reviewer before its conversion, and a missing/ambiguous/display-violating read-back (twice) is retryable — a `pass` can never ride a streamed-compliant-but-persisted-violating review through.
- **All review paths share one `review/start` custom target carrying the full per-round context AND the item-by-item plan-coverage gate.** Fixes the acceptance defect where the Git path kept the native `uncommittedChanges` target and relied on hidden `thread/settings/update` developer instructions for its context — a real App Server native review turn does not reliably see those thread settings, so the Reviewer could miss the Chinese task/plan entirely. The DSH-led review now ALWAYS sends `{ type: "custom", instructions: ... }` (Git and non-Git alike) whose instructions embed workflow identity, original task, approved plan, implementation summary, changed files, test results, and the bounded workspace evidence; for Git workspaces the instructions additionally pin the review scope to the current staged/unstaged/untracked changes and require an independent read-only `git status`/`git diff` check; every path carries the hard gate that every explicit ORIGINAL TASK / APPROVED PLAN requirement must show BOTH an implementation AND a regression test — anything missing yields `changes_requested` (never `pass`), and `pass` is allowed only when every explicit requirement has code and test evidence. The durable Reviewer thread's developer instructions remain populated as an AUXILIARY refresh only (verdict correctness never depends on them). One durable empty Reviewer thread is still created/resumed per workflow (never copying source history; the same persisted `reviewerThreadId` is reused on re-reviews, so no second Reviewer appears in Desktop).
- **Status gates**: the DSH-led review path only parses/applies a verdict when BOTH the visible review turn AND the ephemeral normalization turn genuinely completed (`status === "completed"`) — interrupted/failed/timed-out turns never leak residual text, always fall back to the original executing/fixing phase and consume no cycle.
- **Effective models are pinned and persisted.** The planner's EFFECTIVE model (tool override, bundle config, or the Plan collaboration mode's resolved model — reported via the client's `onModel` and persisted as `plannerModel`) is reused by `continue`, restarts and every conversion fork; the reviewer's effective model (override/config/resolved server default) is persisted at review-only creation and passed explicitly to every conversion fork. Nothing silently re-picks a different `model/list` default.
- **Per-control-RPC timeout.** Control RPCs (`thread/start`, `turn/start`, `thread/fork`, `collaborationMode/list`, `thread/unsubscribe`, ...) are bounded by a tighter derived `rpcTimeoutMs` (default `min(turnTimeoutMs, 60s)`); tool timeouts are now a PROVABLE budget: two turn waits + `MAX_SERIAL_RPCS` control RPCs at their own timeout + cleanup margin, so slow RPCs can never make the host pre-empt a tool before its cleanup. `stop()` additionally settles every pending control RPC and turn waiter immediately.
- **Backend normalization failures are retryable.** A missing/invalid/failed ephemeral-conversion output in the background callback is an infrastructure-class failure — the submission persists `retrying` with the attributed cause, never a terminal failure/notice, zero review cycles; persistent recovery and restarts auto-continue the same submission. Only an invalid source task stays terminal.
- **Exact active-turn mapping.** An in-process map tracks the genuinely active thread/turn pair per workflow — visible Planner/Reviewer turns AND ephemeral conversion forks. `codex_workflow_cancel` interrupts the in-process active turn first (an ephemeral fork turn is interrupted on the FORK thread/turn pair, so an ephemeral turn id can never be mispaired with a persistent thread id) and only falls back to same-kind persisted ids when nothing is active. The background dispatcher additionally holds a per-workflow/per-submission cancellation LATCH: any turn that starts after cancel/lease loss — including an ephemeral fork that only begins after the visible turn completed — is interrupted immediately and can never occupy the Reviewer writer.
- **Teardown awaits foreground work.** The manager tracks every foreground tool flow (Planner start/continue, DSH-led review/review-only incl. their normalization), interrupts its active turn and AWAITS it before the App Server stops and the stores close; the App Server client rejects pending RPCs/turn waiters with a `stopped` error so nothing can later write into a closed store.
- **Final teardown can never be respawned; idle shutdown is recoverable.** `CodexAppServerClient.stop()` is single-flight with an immediate teardown latch: the first call sets the latch (every later `start()`/request fails explicitly with the `stopped` error), becomes the ONE settle promise that all concurrent and repeated `stop()` calls await, and returns only after the old child has exited — a turn-waiter settle racing stop() can no longer trigger a best-effort interrupt through a replacement child, and the plugin teardown path provably leaves no process behind. The idle countdown (default `idleProcessMs` 5000ms) runs a separate RECOVERABLE single-flight `idleShutdown()`: it gracefully closes only the current idle child and NEVER arms the permanent latch, so the same client respawns a fresh App Server for the next `start()`/`health()`/turn.
- Package and runtime version are now `1.0.7`.

### Fixed

- Codex Desktop's Planner and Reviewer task histories no longer show the blue structured-JSON envelope produced by `outputSchema`-pinned turns; the readability and the original task language are preserved in the visible replies.
- The ephemeral conversion fork can never leak into the durable record: `reviewerThreadId`/`plannerThreadId` keep pointing at the visible tasks even while the fork turn is the active cancel target.
- The visible Reviewer prompt no longer asks for a JSON final message (the silent single-verdict contract moved to the conversion instructions), so the persisted Reviewer history reads as prose, not as a schema envelope.
- **Git reviews can no longer run blind.** The Git path previously sent the native `uncommittedChanges` `review/start` target and depended on hidden thread-settings developer instructions for the full context; a real App Server native review turn does not reliably use that channel, so the Reviewer could pass/fail without ever seeing the original task or the approved plan. Git and non-Git reviews now use the same custom target whose instructions always carry the complete per-round context, the review scope, and the item-by-item coverage gate directly into the current review turn.
- **A display-violating visible review can no longer reach the persisted history as the authoritative message.** A lazy/English/one-line native review (no VERDICT/FINDINGS/TEST GAPS/SUMMARY sections, a JSON envelope, or a Chinese task answered in a non-Chinese language) is caught before conversion and rewritten once on the SAME Reviewer task in the task's language with the fixed readable sections — the corrected final message is what Desktop and the ephemeral conversion see; a rewrite that still violates the contract fails retryably without a verdict or a consumed cycle.
- **The display contract is enforced on the PERSISTED history, not the streamed text — via an append-boundary read-back.** Real App Server acceptance showed that the in-memory `TurnWaitResult.text` (streamed/`turn/completed` aggregation) can differ from what `thread/read(includeTurns: true)` actually persists (native Chinese prose for a round whose streamed text looked fine), and that the `review/start` RPC turn id is NOT the persisted `thread.turns[].id` (round-1 RPC `01a040d9-…` vs persisted `01a040d8-a6d8-…`). The DSH-led review and the background callback therefore capture a `thread/read(includeTurns: true)` BASELINE of the durable Reviewer thread's already-persisted turn ids BEFORE each visible turn (native review AND display rewrite) starts, and after completion read back again: the authoritative display text is the final `agentMessage`/`plan`/`exitedReviewMode` output of the turn that was APPENDED since the baseline (located by the baseline id set — never by assuming RPC-id equality). Exactly zero new turns (missing), more than one (ambiguous/concurrent writer), a not-yet-completed appended turn, or a still-violating appended text all FAIL CLOSED into the retryable executing/fixing phase — no `latestReview`, no consumed cycle, and the streamed text is NEVER accepted as a substitute. The same fail-closed rule applies to background submissions (`retryable_busy`), so a `pass` can never ride a streamed-compliant-but-persisted-violating history.
- A cancellation racing the visible→fork window can no longer leave a stale owner's ephemeral turn running on the Reviewer thread (cancel latch + immediate fork interrupt).
- A DSH-led failure mid-review (visible turn failed/interrupted/timed out, normalization failed/interrupted) can no longer apply residual text or consume a review cycle.
- The lifecycle acceptance now covers the Planner (ready + real native clarification, persisted as a readable `plan`/`agentMessage` item with no JSON envelope), HARD-gates ephemeral-fork invisibility (absent from `thread/list`, the visible task directory, after unsubscribe; direct-id reads are recorded as observations since the server keeps them until async GC), and deterministically proves teardown hit an in-flight normalization (fork `onStarted` gating, no timing assumptions).
- **An idle close no longer permanently kills the plugin's App Server client.** An idle `scheduleIdle()` firing the full `stop()` latched the client forever with the `stopped` error (default `idleProcessMs` 5000ms), so any later DSH-led `codex_workflow_review`/`review_only` after an idle gap failed with `Codex app-server stopped` even though the workflow stayed retryable with zero review cycles consumed. Idle now runs a recoverable, single-flight shutdown: `start()` racing it awaits the old child's full exit, re-checks the permanent latch, and spawns exactly one replacement; the final `stop()` colliding with an in-flight idle shutdown waits for that close, stays single-flight, and leaves no child behind. Covered by four App Server regressions (idle→restart succeeds, start×idle race spawns one replacement, final stop refuses restart, final×idle collision stays single-flight with no leftover child).

## [1.0.6] - 2026-08-19

### Changed

- **Final-verdict semantics**: an agent message is only accepted as the verdict after a SUCCESSFUL `turn/completed` for that exact thread/turn. Every message streamed during the turn is treated as provisional, and when a finished turn contains several JSON messages only the LAST completed assistant output wins — a "provisional pass then changes_requested" sequence can never be applied early. Interrupted/failed/cancelled turns never produce a verdict.
- **Silent, non-collaborative Reviewer**: every Reviewer turn (first review and resumed re-review) is pinned to the App Server "default" (non-collaborative) collaboration mode and receives protocol-level `developer_instructions` (plus a prompt block) requiring silent review — no commentary/progress, no sub-agent, delegation or task creation, exactly one final JSON verdict. Verified against the real app-server's `collaborationMode/list` contract.
- **Writer-lock release**: the App Server client now supports `thread/unsubscribe` (idempotent; the persisted Reviewer is never deleted or archived). The server answers one of three statuses — `unsubscribed`, `notSubscribed` or `notLoaded` — all treated as success; the client no longer misclassifies `notLoaded` as `unsubscribed`. After every review cycle — pass, changes_requested, terminal error, or interrupt/cancel — the plugin releases its hold on the Reviewer thread exactly once, guarded by a per-thread active-turn refcount so concurrent reviewers are never released under each other. Source tasks are never subscribed or unsubscribed. The existing idle countdown still closes the managed App Server only when no planner/reviewer turn or request is active globally.
- **Default Reviewer model**: when no `reviewerModel` is configured, the silent Reviewer uses the App Server's default model (`model/list` `isDefault: true`, deterministic first-non-hidden fallback) and that model's `defaultReasoningEffort` when no review effort is configured — it no longer silently picks the list-first entry.
- `codex_workflow_status` now reports `reviewerActive: true|false` from the live Reviewer dispatcher (only a turn actually executing), so persisted-but-finished states like retry backoff or verdict delivery never read as active; `latestReview` still only ever holds an applied verdict (never provisional JSON).
- Package and runtime version are now `1.0.6`.

### Fixed

- Codex Desktop no longer shows two `pass` and one `changes_requested` verdicts for one review: intermediate commentary/progress JSON is no longer surfaced, and the plugin no longer depends on the last streamed message of an unfinished turn.
- A half-configured fresh Reviewer no longer holds a writer lock when its setup fails: `startReviewerThread` unsubscribes the thread if settings/naming fails after `thread/start`, and the callback announcer releases a newly created thread even when `onThread` ownership persistence fails.
- `reviewerActive` reflects only a Reviewer turn that is genuinely executing (queried from the live dispatcher), so retry backoff, verdict delivery and terminal states never read as an active writer lock.

### Fixed (background lifecycle)

- **A DSH tool-return or `agent/turn-stopping` never aborts the Reviewer.** `codex_workflow_submit` returns promptly (<5s) while the Reviewer keeps running to completion in the background; the `agent/turn-stopping` handler only steers the executor and can never stop the callback or abort the submission controller. Covered by an end-to-end regression that also asserts no `turn/interrupt` is issued and no idle shutdown fires while a turn is active.
- **Every non-verdict outcome now carries a distinguishable cause** instead of a generic busy: `turnResult`/dispatcher report and persist `submissionCallbackReason` (`interrupted turn`, `cancelled by user`, `lease lost (callback taken over)`, `plugin teardown`, `turn timeout`, `rate limit`, `active writer`, `callback aborted (cancel/restart)`).
- **No stuck `sending`/`queued` states.** An interrupted/failed/timeout turn persists `retrying` with a future `submissionRetryAt` and its reason; a callback aborted before a verdict leaves a recoverable `retrying` record. The persistent recovery loop re-claims and auto-continues such submissions to their verdict (tested end-to-end).

### Fixed (review persistence)

- **Defensive shutdown hardening.** `CodexAppServerClient.stop()` now shuts the managed App Server down gracefully — it sends EOF on stdin and waits for the app-server to flush its rollout and exit before escalating to SIGTERM/SIGKILL. This lowers the risk of an abrupt shutdown racing the app-server's final rollout write after `turn/completed` (an abrupt TerminateProcess on Windows could in principle cut an in-flight write and leave a completed turn short of its final message). The root cause has not been isolated: in the real compare experiment both the kill sequence and the stdin-EOF sequence read the completed turn back with its final message intact. Explicit cancel/teardown still interrupt active turns first; when the client is idle there is no active turn, so EOF is never sent to abort a live review. `thread/unsubscribe` remains but is no longer relied on as the only writer-lock release.
- **Real persistence acceptance**: `pnpm run lifecycle:accept` runs a genuine two-round review against the real Codex App Server — create a durable Reviewer, complete a structured-verdict turn, unsubscribe, close the client, then a FRESH App Server `thread/read(includeTurns:true)` verifies the tested sequence persisted the turn as `completed` with the final assistant JSON, then resume the SAME Reviewer for a second completed turn and re-verify persistence. This is a regression against the tested sequence, not a proof of a root cause. The fake-server unit tests cannot substitute for this acceptance. The client gains a public `readThread(threadId, includeTurns)` diagnostic.

## [1.0.5] - 2026-08-19

### Changed

- A successful review relay now instructs DSH to emit one final implementation/test report, call no tools (including `memory`), and end the turn immediately.
- Added `terminalRelayTimeoutMs` (default `60000`, `0` disables, maximum 10 minutes). It watches only the activity awakened by a passing verdict and preserves queued inbox work when cancelling a stuck turn.
- Package and runtime version are now `1.0.5`.

### Fixed

- A completed workflow no longer remains visually “running” when the DSH model emits its final report and then stalls in an empty trailing tool call. The terminal relay guard disarms on idle, cannot affect a later user turn, and is aborted and awaited during plugin teardown.
- Idle bridge polling no longer opens write transactions for an empty queue or rewrites an unchanged live-session registry, preventing the CLI from being starved into `database is locked` failures on slower Windows hosts.
- Plugin teardown now keeps the bridge pump marked active through its final session-registry refresh, so `stop()` cannot release SQLite storage while an overlapping timer tick or pump finalizer is still running.
- A cancellation racing between `turn/start` completion and waiter registration now still sends `turn/interrupt`, so the Codex task is not left active after the DSH call has already ended.

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
