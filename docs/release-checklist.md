# Release checklist — dsh-codex-workflow 1.1.14

This is the operator checklist for shipping the CURRENT release (1.1.14; keep this line in sync with `package.json` on every release). It assumes the automated gates
succeeded; this page is about the things automation cannot cover, plus the
rollback story. It never authorizes touching user credentials or configuration
outside `$DSH_HOME/storages/dsh-codex-workflow/`.

## Automated gates (run in CI and locally)

For a checkout linked to a running DSH, use `pnpm verify:isolated`. Inspect its retained summary, input hashes, per-check logs and artifact hashes; original sources and canonical build content/mtime/ctime must match throughout. Validate the exact staged build, then deliver it through the existing idle/workflow/queue/process-instance guards. A successful isolated verifier returns a path; it does not deploy the artifact. Missing Git context, stale stage/evidence, source drift, changed build metadata or absent entrypoints must reject the result.

Verify/release gates require their scoped native `*.tests.jsonl` receipts: one original start identity, each expected file's summary, one final cumulative summary and stream completion, plus the actual zero command exit. Validate all counters, file inventory and async diagnostics. Never substitute TAP/spec text for a missing native receipt; a worker can exit zero before its assertions finish. `scripts/test-receipt.mjs` owns argument pairing and completed-receipt validation; its companion reporter creates the output exclusively. Human reporters remain separate, and inherited receipt settings activate only in the original source directory.


Retry-clock changes must pass `test/retry-monotonic-clock.test.ts` across control, Planner, Reviewer and CLI entries. Cover clock rollback/advance, repeated corrections, zero budgets, explicit clock hooks and caller cancellation; assert the original thread target, last failure/outcome and admitted request count. In-process retry budgets use monotonic elapsed milliseconds. Durable timestamps and scheduler/lease records retain their own timestamp semantics.


Retry wake-up admission must pass `pnpm exec tsx --test --test-concurrency=1 test/retry-wakeup-budget.test.ts test/transient-retry.test.ts test/codex-cli-audit.test.ts test/workflow.test.ts test/foreground-mixed-terminal-failure.test.ts`. Verify exact and overshot deadlines, cancellation identity ahead of exhaustion, zero-budget initial calls, the last real transient result, and same-thread retry inside the budget. This single-call backoff bound does not stop already admitted operations or reset the workflow's independent continuation budget.

Shared diagnostic summaries must pass `pnpm exec tsx --test --test-concurrency=1 test/compact-diagnostic.test.ts test/transient-retry.test.ts test/codex-cli-audit.test.ts`. Verify UTF-8 byte bounds including markers, exact omitted source bytes, complete character boundaries at tiny budgets, retained original ends, and terminal CLI classification before compaction. This summary budget is separate from the App Server's UTF-16 tail limit and does not measure tokens or fees.

```powershell
pnpm install --frozen-lockfile
pnpm verify          # typecheck + full test suite + build
pnpm doctor:offline  # CI-safe offline doctor (skips only codex/login checks)
pnpm release:check   # verify + offline doctor + pack audit (tgz always cleaned)
```

Run `pnpm release:check` twice in a row and confirm:

- the second run passes identically;
- no `*.tgz`, no `.codex-pack-review`, no temp tarballs remain after either run.

`git diff --check` must be clean.

When available memory is limited, set `$env:DSH_WORKFLOW_TEST_CONCURRENCY = "2"` before the full gates. The test launcher accepts 1–4, defaults to 4, and runs every matching test file with the original assertions, case concurrency and timeouts. Record the selected file concurrency with gate results; invalid values fail before spawning tests.

For hidden or redirected Windows gate processes, set `$env:DSH_WORKFLOW_TEST_REPORTER = "tap"` before verify/release so numeric summaries use ASCII (`# tests …`, `# pass …`, `# fail …`). The optional setting accepts `spec` or `tap`, inherits through the release script's test invocation, and leaves Node's default when unset/empty. Explicit `--test-reporter` arguments retain priority. Check test/pass totals, fail/cancelled/skipped/todo counts and the actual command exit code; a truncated log or zero-exit suite containing skips/TODOs is not the full gate. Preserve the first process identity, logs and terminal receipt for background checks. Reporter text remains version-sensitive; use TestsStream events for a dedicated programmatic protocol.

Shared Reviewer cancellation must pass `pnpm exec tsx --test --test-concurrency=2 test/shared-reviewer-cancellation.test.ts test/bridge-new-review-round-request.test.ts test/bridge-unavailable-review-routing.test.ts`. The isolated native-timeout actor intentionally exits nonzero; its outer regression passes only when the held lease phase was reached, cancellation was preserved, cleanup finished and no additional model turn ran. Keep the original 30-second business test limits. An after hook and abort-aware wait must clean the original local fixture; never mark a cancelled gate as passing or kill an unrelated process to unblock it.

Shared initialization must pass `pnpm exec tsx --test test/shared-initialization-cancellation.test.ts`: one observer cancels without rejecting another native Planner's original receipt; a joined observer cancels before ACK; last withdrawal cleans the original PID once; later independent metadata waits for cleanup; already-aborted callers do not spawn; permanent stop cannot restart the backend. Initialization recovery is separate from original-thread workflow continuation.

Control RPC and stdio cleanup must pass `pnpm exec tsx --test test/rpc-settlement-cleanup.test.ts test/app-server-stdio-failure.test.ts`: a real held RPC timeout leaves no caller listener; a paused upstream and queued 4 MiB write can stop without an uncaught EOF; ordinary large writes succeed; a retired stream's late error cannot invalidate the successor. The stdio actor exits naturally and verifies only its own diagnostic PIDs. Local stream errors do not establish remote-turn cancellation.

Fork creation must pass `pnpm exec tsx --test test/fork-creation-receipt.test.ts`: late `thread/fork` replies survive abort/timeout, a repeated conversion consumes the same original fork once, changed material is rejected and unknown receipts cannot start models. Public late-fork cleanup keeps its source barrier through failed/held unsubscribe ACKs; concurrent retries share cleanup, then healthy public calls create independent forks. Synchronous cancellation before submission sends no fork. Stop uses the captured local process without model work or respawn; this fixture does not prove exit of an unobserved descendant backend.

The same fork suite must reject missing/unknown unsubscribe statuses and null results without deleting the original subscription owner or releasing its source barrier. Assert no source model or replacement fork while cleanup is unconfirmed, then hold a real valid ACK and confirm the same owner remains until its one release. The existing SDK idempotence case must still accept `unsubscribed`, `notSubscribed` and `notLoaded`. A subscription ACK does not establish turn interruption or immediate server unload.

Completed conversion cleanup must preserve the successful output or primary error, then recover only the failed release. Assert original model/fork counts stay one through failed/held ACKs, concurrent observers and one observer cancellation; caller edits cannot alter the cached result and callbacks are not replayed. Verify pending cleanup blocks idle loss, source unsubscribe can finish its own fork, and external handoff propagates unconfirmed cleanup. `test/fork-creation-process-exit.test.ts` must also prove a completed conversion's original backend is retired after launcher-first exit, without a fabricated unsubscribe ACK or another model.

Original process instance checks must pass `pnpm exec tsx --test test/process-instance-exit.test.ts`: deterministic birth queries release only obsolete cleanup, missing/denied/malformed evidence remains unconfirmed, original survivors block, legacy absent trees still confirm, and owner/epoch changes during a query cannot reuse its result. Verify actual SDK error→runtime→persisted retry evidence and one-time cleanup. Controlled metadata tests are separate from real OS PID reuse; keep their evidence distinct. Do not change process wait deadlines to obtain a pass.

Fork process teardown must pass `pnpm exec tsx --test test/fork-creation-process-exit.test.ts test/process-tree-cleanup.test.ts`: a real launcher/backend topology stops all captured original instances with no model or fabricated turn, including launcher-first exit and a rejected native termination helper followed by cleanup-only retry. Verify missing birth evidence and signal-only success cannot clear ownership; a live mismatched-birth process survives. Windows native termination is verified locally; Linux requires available Python/pidfd support and must report unconfirmed when unavailable, without falling back to bare-PID termination.

Idle handoff must pass `pnpm exec tsx --test test/external-handoff-process-exit.test.ts`: launcher exit cannot complete handoff while its original backend survives; rejected safe termination retains the tree and blocks startup. Verify a cleanup retry retires only those instances, concurrent startup waits then admits one explicitly requested successor, permanent stop retries cleanup without unlatching, and one observer cancellation leaves the shared cleanup intact. Native backend liveness does not by itself prove a real Codex file-writer lock or provider billing behavior.

Rejected initialization must pass `pnpm exec tsx --test test/initialization-process-exit.test.ts`: preserve the original handshake/cancellation error, retire captured launcher/backend instances, retain denied cleanup, and reject bootstrap when a lost launcher has no valid tree evidence. A later explicit metadata request racing the rejected attempt must wait for cleanup and then start once, rather than join the old failed initializer. All fixture model counts remain zero; recovery does not reconstruct an ephemeral Planner/Reviewer.

Ordinary permanent stop must pass `pnpm exec tsx --test test/permanent-stop-process-exit.test.ts`: initialize a real launcher/backend without any fork, confirm captured originals exit, and reject all later bootstrap. Denied native termination retains the same evidence for concurrent cleanup-only retries. Initialization/idle collisions share one retirement census and close; a failed census stays unknown after launcher exit instead of being recaptured. Assert one process startup, zero fork/model calls and exactly one backend EOF. Keep existing graceful-stop, observer-cancellation and fork-cleanup controls.

Unexpected ordinary launcher exit must additionally retire a surviving backend and a child spawned after initialization. A later explicit health request waits for that cleanup, starts once, and rejects the old ephemeral owner. Denied native termination and missing startup identities must block successor admission; concurrent stop retries keep the same ownership record and stopped latch. `test/process-tree-refresh.test.ts` covers reused PIDs, unknown/partial identities and conflicting birth domains without signalling simulated processes. Keep original idle/clarification/pin timing assertions: initialization identity collection must prevent premature idle retirement.

Original output closure must pass `pnpm exec tsx --test test/app-server-output-close.test.ts test/app-server-stderr-origin.test.ts`: destroy the actual original Readable while its process remains alive, verify the first closure/error settles RPCs, clears availability and blocks metadata/model bootstrap. Readline error propagation must not crash the SDK. A known active turn retains its exact interruption pair; an unknown start retains its original pending receipt. Local output failure is never proof of backend/model exit. Stop confirms the captured originals; retired output errors cannot poison a successor. Keep current exit-prefix/stderr and actual old-pipe byte assertions; the separate 100ms close-observation window must not extend any RPC/model budget.

Windows independent absence must pass `pnpm exec tsx --test test/process-absence-fallback.test.ts test/process-instance-exit.test.ts test/process-tree-refresh.test.ts`: force only the signal-zero observation to EPERM for real captured SDK instances, then verify actual .NET absence checks confirm retired originals while live originals and denied queries preserve their SQLite guards. Partial, duplicate, foreign or failed confirmation results cannot clear a whole tree; failed identity queries and missing saved births do not acquire a fallback receipt. Descendant refresh must not borrow reused PID descendants. Absence inspection sends no termination signal; birth matching and lease generation fences remain required.

Initialization input failure must pass `pnpm exec tsx --test test/initialization-input-failure.test.ts test/shared-initialization-cancellation.test.ts test/app-server-stdio-failure.test.ts`: close the real original stdin Socket after the actual initialize ACK while withholding only delivery of a completed native census callback. Startup must reject instead of publishing ready, shared observers must retain the same physical cause, and caller-only cancellation must leave another observer's error intact. Ready-process faults must block metadata/thread bootstrap; secondary stdout errors cannot replace the first stdin cause. An active model retains its exact unconfirmed pair without another model or interrupt. Keep actual queued-write, retired-event and current stderr exit controls.

Missing stdio must pass `pnpm exec tsx --test test/missing-stdio-spawn.test.ts`: isolate a controlled native spawn-adapter replay with a real ChildProcess object, undefined stdio/PID, and Node's asynchronous error/close sequence. EMFILE/ENFILE/shared startup must preserve the exact original error and avoid SDK-host crashes. Cover caller-only/last cancellation, concurrent permanent stop, synchronous throw, close-only and receipt timeout. No-PID outcomes must create zero retirement records; a late original error must leave an explicitly requested real metadata successor intact. A real OS child started with ignored stdio must be retired through its captured birth tree. This is contract replay, not actual system-wide descriptor exhaustion; do not install a global uncaughtException workaround or relax control budgets.

Diagnostic stderr failure must pass `pnpm exec tsx --test test/app-server-stderr-failure.test.ts test/app-server-stderr-origin.test.ts`: destroy the actual original stderr Socket with an error in isolated SDK workers during initialization, readiness and an active model. The host must finish normally, keep the same RPC/thread owner and allow its genuine caller cancellation. A later actual process exit retains its established prefix and fixed diagnostic-unavailable marker without private error contents. Inject a real read fault into a retired pipe after observed old OS bytes arrive while the successor owns the SDK; it must not annotate the successor's exit with or without its own stderr. Keep all previous byte/provenance and physical cleanup assertions.

UTF-8 stderr must pass `pnpm exec tsx --test --test-concurrency=1 test/app-server-stderr-utf8.test.ts test/app-server-stderr-origin.test.ts test/app-server-stderr-failure.test.ts`: acknowledge a first real pipe write only after the parent observes an incomplete multibyte prefix, then write the remaining bytes and actually exit the backend. Assert exact Chinese/emoji text, one replacement for genuinely incomplete source bytes, and the unchanged 16,384-unit tail bound without a leading lone low surrogate. Preserve current exit prefix, private diagnostic fault isolation and old-pipe ownership. Require valid captured births before fault injection; do not invent identities to mask query failures or change per-scenario timeouts.

Windows process capture must pass `pnpm exec tsx --test test/process-tree-capture.test.ts`: replay the controlled CIM census from the preserved real failure, exclude an older child attached by a stale reused parent PID and its branch, retain valid nested/sibling descendants and equal creation times, and keep unknown/malformed birth evidence conservative. These census assertions test capture ownership; they do not manufacture a live OS PID reuse or relax the original process-exit deadline.

Stderr ownership must pass `pnpm exec tsx --test test/app-server-stderr-origin.test.ts`: current-child diagnostics survive, drained originals do not contaminate successors, and actual retired OS-pipe bytes cannot enter successor errors with own or absent stderr. The actor terminates only its captured diagnostic child, exits naturally and verifies its captured original trees. Keep the old exit prefix and classification; this does not prove that exit collects every late stdio byte.

Exit diagnostic draining must pass `pnpm exec tsx --test --test-concurrency=1 test/app-server-exit-stderr.test.ts test/app-server-stderr-utf8.test.ts test/app-server-stderr-failure.test.ts test/app-server-stderr-origin.test.ts`. Verify actual post-exit buffered data, a detached inherited writer that remains alive after the diagnostic deadline, same-address successor admission and stop during draining. Capture complete original births before exit, including the inherited writer. The 100ms bound settles only the diagnostic; the original tree still requires independent retirement proof. Existing control RPC and model wait timers remain armed.

Parsed protocol failures must pass `pnpm exec tsx --test test/app-server-protocol-failure.test.ts`: actual malformed stdout frames cannot crash the SDK host; first causes and original ACK targets survive known and callback-handoff cases; foreign or ambiguous frames cannot borrow another turn; Planner failed ACKs retain terminal cleanup and manual resume starts no model. Unknown pending writers without a usable original receipt are outside this ownership test; do not fabricate a pair or infer their completion.

Pending start receipts must pass `pnpm exec tsx --test test/app-server-pending-receipt-failure.test.ts`: gate a real upstream reply after its writer starts, send the malformed frame through its actual stdout, and verify only the authoritative reply admits original-turn cleanup. Healthy delays still succeed, earliest matching causes survive foreign hints, detached review uses its returned destination, and Planner failed ACKs retain the original child for cleanup-only resume. Unscoped or ambiguous frames cannot borrow a pending operation; no-reply, invalid-reply and pre-receipt cancellation do not acquire a cleanup pair through hints.

Submitted-start lifetime must pass `pnpm exec tsx --test test/start-receipt-lifecycle.test.ts test/callback-start-receipt.test.ts test/start-receipt-input-handoff.test.ts test/bridge-start-receipt-lifecycle.test.ts`. Caller abort/timeout must retain the same operation and late-reply route, report model continuation unavailable before receipt, and never repeat its model stage. Verify fresh callback registration, native-input ownership, stage budgets, private seed/fork reuse, canonical marker removal, concurrent cancellation, and one child/pin release after exact cleanup or original process-instance exit. Local waiter settlement, unsubscribe and launcher exit alone do not prove the remote model ended.

Backend model metadata must also pass:

```powershell
pnpm exec tsx --test test/model-selection-cache-generation.test.ts test/model-catalog-generation.test.ts test/model-catalog.test.ts
```

Warm A's model directory/default, verify repeated same-process reads keep the
cache, then actually exit A or complete its idle shutdown and launch B with
different metadata. Check B's public directory/default and independent Plan,
conversion and silent-review settings; explicit overrides must win. Hold an
old catalog/default/Plan response across reset and verify it cannot backfill B,
including a ready-cache asynchronous handoff and an original request failure.
Rejected RPC initialization and malformed initialize responses must preserve
their cause, actually exit their original child, and require initialization
again before a subsequent SDK request; no thread or model is admitted through
the failed handshake. Permanent stop and an admitted lost original thread must
not spawn a replacement merely to read cached metadata. Keep caller cancellation
independent; this change does not add singleflight or auxiliary tuple indexing.
See the [catalog generation iteration](iterations/2026-10-06-thirtysixth-model-catalog-generation.md).

Terminal cleanup must pass `pnpm exec tsx --test test/app-server-cleanup-only.test.ts test/planner-terminal-cleanup.test.ts test/reviewer-terminal-cleanup.test.ts test/terminal-cleanup-guard.test.ts`. Verify the original primary error, exact failed/held/confirmed ACK pair, zero model continuation, one release after real termination, cold-Manager refusal even after cancellation/expired TTL, and no successor-row mutation. A local unsubscribe or successful first stop is insufficient evidence that the remote writer ended.

Confirmation generation isolation must also pass:

```powershell
pnpm exec tsx --test test/terminal-cleanup-guard.test.ts test/confirmation-generation.test.ts test/auxiliary-confirmation-generation.test.ts test/terminal-cleanup-generation-lifecycle.test.ts
```

Use a real exited SDK process and a new local protocol process that deliberately
reuses the textual thread/turn pair. Its failed ACK must keep its own child,
subscription and pin without model calls. Repeated/concurrent cleanup of the
same original owner confirms once. Verify exact workflow/session/token/epoch
matching, rejection of missing legacy markers and historical tombstones, and
creation of a new guard before a waiting marker becomes visible to a cold
Manager. A late old ACK must preserve a successor's complete SQL row and
auxiliary registry entry; it releases only its own pin and never unsubscribes
the successor's reused address. See the [generation iteration](iterations/2026-10-06-thirtyfourth-cleanup-confirmation-generation.md).

RPC transport ownership must also pass:

```powershell
pnpm exec tsx --test test/app-server-thread-owner.test.ts test/thread-owner-cleanup.test.ts test/planner-thread-owner.test.ts test/reviewer-thread-owner.test.ts test/callback-thread-owner.test.ts test/workflow-usage-thread-owner.test.ts test/workflow-usage-binding-owner.test.ts
```

Exit the actual original protocol process, then start an independent process
that reuses its public thread/turn/native-request text. Old resume/cancel/stop
must send zero model, answer, interrupt or unsubscribe operations to the new
owner. Verify current-owner controls, same-process re-registration, preparation
and registration await fences, and the new writer's successful completion.
Check private seeds and waiting Planner/Reviewer/Bridge handles, original child
disposal exactly once, and preservation of the successor's pin and usage cache.
Counter changes on B must not overwrite A's historical source; stale A bind or
release must not retire B, and an awaiting B bind must not mix its model into
a C takeover. Record the full gate and formal reload receipts separately from
these local protocol tests. See the [transport owner iteration](iterations/2026-10-06-thirtyfifth-original-thread-transport-owner.md).

Planner creation cancellation must also pass `pnpm exec tsx --test test/planner-late-thread-start.test.ts test/start-boundary.test.ts`. A held original creation response reports `running`; a caller abort retains its returned original identity, while cancel/stop clean it once. No-ID startup diagnostics must remain session-scoped and cannot authorize terminal recovery or select an older task.

Check `codex_workflow_status({})` and `codex_workflow_resume` with `workflowId`
omitted on the original DSH session. Distinguish a running creation receipt,
an available original handle and unavailable startup diagnostics. A failed
startup is not a permanent start quota; an interrupted active workflow must
never be replaced or completed in the parent chat. These isolated checks do
not establish real-provider fault behavior or repair existing corrupt chats.

Planner stage recovery must pass `pnpm exec tsx --test test/planner-stage-recovery.test.ts test/planner-settings-recovery.test.ts`. Successful readable/conversion/completion stages must not replay; one auto budget spans the original run and manual resumes. Check short private prompts, actual child output, exact interruption ACK, scope/settings rejection, and zero model calls after a successfully converted receipt is interrupted before final commit.

With an installed DSH host, also run `pnpm host:check` and
`pnpm host:recovery:check`. The latter exercises native tool/subagent/session
services with temporary JSONL persistence. Every scenario must report
`persistedColdReplay: true`: an independent backend reads the original parent
and child after child disposal, preserving complete events, messages and catalog
identity. In-memory `Session.create` replay alone does not satisfy this check.
With injected local model failures, it must show
one original child/thread, stable replay, and one cleanup per scenario. This
does not replace the formal-profile UI and real-model smoke below.

For native Reviewer sidebar changes, run `pnpm exec tsx --test test/reviewer-sidebar.test.ts test/client-sidebar.test.ts`.
Waiting/completed projection updates must keep the original native conversation,
cold replay must prefer that Reviewer over an older Planner, a genuine new
review round must select its new child, and legacy childless records must keep
their summary fallback. Browser acceptance must verify the selected original
resource, not only that a tab exists.

Summary status changes must pass `test/review-status-ui.test.ts`: fold real
review start/progress/end and Planner events, then render the actual client.
Saved waiting, failure, cancellation and stale progress must not display
completion; active progress and empty/completed controls remain accurate.
Recovery attempt labels must not imply another business review cycle.
Verify the selected native summary in isolated DSH before claiming browser
acceptance; a pause label does not prove an original thread is resumable.

Planner process-state changes must pass `test/planner-status-display.test.ts`,
including real v1 checkpoint invalidation/refold and legacy logs without that
field. Receipt, submitted-answer abort and terminal-cleanup suites must verify
their actual parent events: waiting is published only for committed original
state, resumed planning explicitly becomes running, a ready plan is completed,
and rejected-model cleanup retains a failed heading. Cancel/stop must not let
late receipt cleanup publish a fresh pause. `host:recovery:check` must confirm
the same Planner's wait→running→completed sequence and persisted cold replay.

Cold sidebar changes must pass `test/projection-loading-ui.test.ts`: pending
undefined/null and absent faces render loading with stable snapshot identity;
loaded empty data remains ordinary waiting. Original notifications replace
loading with pause/running/completion while getters retain their receiver.
For history UI acceptance, preserve original journals and avoid adding agents
or repeating model turns; fixture navigation changes are separate from the
production renderer.

Sidebar lifecycle changes must pass `test/sidebar-disposal.test.ts`: an
already captured mounted/projection notification cannot acquire resources after
plugin disposal; retained retry callbacks cannot restart discovery. Each
session's observer and plugin registrations release once, while live retries
and original-child selection still work. Controlled late timer callbacks test
the retirement boundary; they do not demonstrate a browser timer cancellation
failure. Keep browser teardown separate from model-thread cancellation.

Sidebar retry changes must pass `test/sidebar-retry-budget.test.ts` for native-child and summary surfaces. Check late callbacks before resource acquisition, exhausted allowances under repeated progress, distinct-target isolation, normal success and disposal. No exhaustion test may acquire another model thread or grant another continuation.

Foreground recovery and new business rounds must pass:

```powershell
pnpm exec tsx --test test/foreground-new-review-round.test.ts test/review-admission.test.ts test/review-restart-eligibility.test.ts
```

Verify real changes in the original persisted evidence scope after process
loss, unchanged-input rejection, and explicit independent-round intent. An
unconfirmed original interruption must preserve its writer/child/pin until
ACK; direct resume and new review both respect a live external review lease.
An empty second Manager must also reject a live writer through a different
SDK. A stopped Windows launcher does not prove its backend stopped: require
confirmed original-turn interruption or OS exit of the captured process tree.
The tests use real SDK and native DSH services with a local protocol fixture,
not a production provider or a real-model Token-cost measurement.

Completed foreground stage recovery must also pass:

```powershell
pnpm exec tsx --test test/foreground-review-stage-recovery.test.ts test/foreground-cli-stage-recovery.test.ts test/foreground-mixed-terminal-failure.test.ts
```

Completed readable/conversion/correction work must run once across failures.
Check exact private ACK cleanup, original-thread loss, missing artifacts,
scope drift, terminal rejection and zero-model final evidence recovery.
The CLI fixture uses real local child processes; non-persistent calls must
include `--ephemeral` without `resume` and preserve the existing API.

The review entry/resource suites also check the following boundaries:

```powershell
pnpm exec tsx --test test/bridge-review-entry-admission.test.ts test/auxiliary-thread-lifecycle.test.ts test/bridge-auxiliary-pin.test.ts
```

They check Bridge routing before another Reviewer is created, private pins
through retry backoff/nested rechecks, and cleanup after interruption confirmation.
A successful `thread/unsubscribe`
alone does not prove a running model ended. These local fixtures do not repair
historical corrupt sessions or recover an ephemeral thread after process loss.

Completed Bridge reviews also need checkpoint coverage:

```powershell
pnpm exec tsx --test test/bridge-review-checkpoint.test.ts test/bridge-review-checkpoint-lifecycle.test.ts
```

Authority retries must keep the original child and completed result, emit no
second readable review, and leave applied cycles and observed usage unchanged.
Changed scope/evidence, replaced leases, marker-write faults and process loss
must preserve their exact rejection and one-time cleanup behavior. A pending
checkpoint is not an accepted verdict.

Evidence admission and historical recovery must also pass:

```powershell
pnpm exec tsx --test test/bridge-evidence-admission.test.ts test/bridge-evidence-recovery.test.ts
```

Invalid initial input creates no submission or model/child resources and can
be corrected on the same workflow. Replaced owners/phases and caller mutation
must not pair new input with old evidence. Historical recovery without a
verifiable original snapshot fails once; it cannot start a replacement review.

Asynchronous child adoption and startup must pass:

```powershell
pnpm exec tsx --test test/bridge-child-adoption.test.ts test/bridge-startup-lifecycle.test.ts
```

Cancelled/displaced startup creates no Reviewer and cannot overwrite a newer
child handle or record. Plugin stop waits for admitted creation and cleanup;
late native handles open no turn. Caller-only abort after durable preparation
continues the original submission. Display cleanup errors cannot retain leases.

## Real-environment smoke (operator, with a live Codex login)

For Chinese DSH prompts and identity checks, use the [same-session recovery guide](dsh-same-session-recovery.md). Keep caller-stop recovery distinct from explicit workflow cancellation and natural provider faults.

1. `pnpm doctor` (full mode) → `DOCTOR_OK`, SQLite journal `delete`, Codex login,
   compatibility CLI syntax, and App Server health confirmed.
2. In the formal DSH profile, verify the model-facing trigger policy:
   - with `autoTriggerMode: complex`, send a cross-file implementation task;
     DSH first announces the Codex planning decision and calls
     `codex_workflow_start` before any write/edit/state-changing command;
   - send an obvious low-risk single-file edit and confirm it does not
     auto-trigger;
   - send a complex task with an explicit “直接做，不使用 Codex” override and
     confirm it does not auto-trigger;
   - temporarily test `always` (the simple write-intent task triggers) and `off`
     (nothing auto-triggers, while an explicit Planner request still works),
     then restore `complex`;
   - while one workflow is active, send another qualifying request and confirm
     no second WorkflowRecord or Planner task is created.
3. **Current acceptance path (1.1.14).** The manual harnesses this step used to
   name (`pnpm lifecycle:accept`, `pnpm review-only:accept`) were REMOVED: they
   drove the pre-1.1.0 CLI-visible wiring and could no longer be trusted as
   evidence. Run instead:
   - `pnpm verify` and `pnpm release:check` (typecheck + the full suite + build +
     offline doctor + pack audit + the static gates);
   - `pnpm host:check` against the operator's installed DSH (it also asserts the
     declared peer range with the host's own evaluator);
   - one REAL `codex_workflow_start`: confirm DSH publishes a child Session with
     `origin: subagent`, opens the built-in `subagentchat` right tab, displays
     Codex planning before the call returns, and restores the child chat after refresh;
   - one REAL review round (`codex_workflow_review_only`, or a DSH-led
     `start` → `review`) and confirm: `thread/start` receives
     `ephemeral: true`, no `thread/name/set` or legacy `thread/resume` is sent,
     no new plugin thread appears in Codex Desktop `thread/list`, and the
     a separate native DSH child Session displays the Reviewer while it runs,
     and its verdict and findings remain visible after refresh;
   - one real bridge relay (Codex-led `dispatch` → `codex_workflow_submit`) and
     confirm the verdict returns to the originating task exactly once.

   The bullets below are the HISTORICAL pre-1.1.10 acceptance script — keep them
   only as a record of what used to be asserted. They must not be used as
   evidence for the ephemeral Reviewer path.
4. Historical script (pre-1.1.0, no longer runnable — kept for reference):
   - the old harness used low reasoning and a 600-second turn timeout by default; When the account's default model is temporarily slow,
     pin an available model with `DSH_CODEX_LIFECYCLE_MODEL` rather than
     weakening any history/task-id assertion;
   - `dsh-codex-workflow sessions --cwd $PWD --json` lists the live session;
   - `dispatch` a plan and `codex_workflow_submit` it exactly once;
   - the readable review is appended to the exact source Codex task;
     `show --workflow <id>` reports matching source/review ids and version
     `1.0.14` (an old workflow that already persisted a distinct Reviewer id
     prefers that legacy task for resume, writer release and callback state);
   - **single-task history**: the source task contains the plan and every
     visible review round, and Codex Desktop shows no additional Reviewer task;
     `review_only` is the sole exception because it has no Planner/source task
     and therefore creates one durable review task;
   - **desktop readability**: the Planner remains App Server/Desktop-backed;
     visible Reviewer/reconciliation turns are real `codex exec --json resume`
     calls on the existing task and persist ONLY readable Markdown in the
     original task's language. Normalization/alignment are `--ephemeral` CLI
     calls and never enter Desktop history. Audit completion must not refresh,
     navigate, focus or reopen Desktop; opener call count remains `0`;
   - **Git review context**: every DSH-led/bridge CLI review (Git AND
      non-Git) receives a prompt whose instructions embed the full
     per-round context (original task, approved plan, the PREVIOUS APPLIED
      REVIEW and this round's fix summary, implementation summary,
      test results, evidence diff) plus the item-by-item coverage gate; on a
     Git workspace the Reviewer is told to review the current
     staged/unstaged/untracked changes and to independently run read-only
      `git status`/`git diff`; an explicit plan requirement without an
      implementation must come back `changes_requested`,
       never `pass` - verify by opening the shared workflow task or capturing its
      instructions, and by observing a missing-requirement round return
      `changes_requested`;
   - **visible-review display contract**: the last completed CLI JSONL
      `agent_message` is readable Markdown with
      the four sections (VERDICT/conclusion, FINDINGS, TEST GAPS, SUMMARY)
      in the original task's language — a Chinese task must never end on an
      English one-liner, a JSON envelope or a section-less reply; when the
      visible review violates the contract, exactly ONE visible CLI rewrite
       appears on the SAME workflow task (same reviewer effort, no schema) that only
      re-presents the same verdict/findings/test-gaps in the task's
      language, and the rewrite's final JSONL agent message is what the
      ephemeral normalization sees (no second visible task; cancel/timeout
      terminates the exact CLI child). The plugin does not read, fork or
      re-subscribe the Desktop task after CLI completion;
   - **review authority alignment (1.0.14 CLI path, 1.0.10 semantics)**: after each review round an
      invisible ephemeral CLI alignment checks the verdict against the
      authority hierarchy (reproducible critical/high defect > original task >
      approved plan > previous applied findings > generic suggestions); an
      aligned round applies as one cycle with `reviewContractFailures` reset
      to 0; a conflict triggers exactly ONE visible reconciliation turn on
      the SAME workflow task (readable review, four sections, no JSON).
      Its prompt lists every non-conflicting finding/test gap verbatim;
      multiset preservation rejects deletion, field edits, duplicate-count
      changes and unrelated additions before re-normalization/re-alignment.
      A reconciliation-corrected
      verdict applies as ONE cycle with `latestReviewConflict.resolved=true`;
      a still-conflicting round restores executing/fixing WITHOUT
      `latestReview`, WITHOUT a consumed cycle and WITHOUT a fix instruction;
      two consecutive unresolved conflicts move the workflow to `blocked`
      with a reportable reviewer-contract failure (no code changes demanded,
      no user choice popup); `codex_workflow_status` and
      `show --workflow <id>` surface `latestReviewConflict` and
      `reviewContractFailures`;
   - before each visible CLI audit the plugin releases the selected task writer
     (`reviewerThreadId ?? codexThreadId`); after completion it does not
     re-subscribe, call `resumeThread`, refresh Desktop, or create an opener
     retry. Ephemeral CLI calls have no persistent task id to store or release;
   - a re-review resumes the SAME source/workflow task id (never a second task);
   - `codex_workflow_status` reports `reviewerActive: true` during the CLI child and
     `false` afterwards; `latestReview` never contains provisional JSON;
   - delay the Reviewer for more than 30 seconds: `codex_workflow_submit`
     returns within 5 seconds, concludes that DSH turn without another model
     step, the DSH session becomes idle, and status remains
     `sending`/`retrying` until the background verdict arrives;
   - abort the originating tool signal after submit returns: the background
     Reviewer continues and the verdict still wakes the same session;
   - force invalid-task/no-verdict/process failures: one durable terminal notice
     is relayed, including across restart, with no duplicate submit steer;
   - if the source task has an active writer, the review remains durably
     retryable and starts only after that writer releases it; no replacement
     task is created to bypass the lock;
   - a second review reuses that same task instead of starting another;
   - while a review runs, the CLI child remains tracked; cancel, timeout, lease loss, restart and teardown terminate it (SIGTERM/SIGKILL escalation where required), and `stop()` waits until no audit child or App Server writer remains;
   - after a passing verdict, DSH reports once without invoking `memory` or any other tool and returns to idle; force a hanging terminal relay and confirm it is cancelled once after `terminalRelayTimeoutMs` with its inbox preserved;
   - let a terminal relay reach idle normally, then start a new user turn and confirm the old guard never cancels it; stop the plugin with a guard pending and confirm no late cancellation occurs;
   - a blocking `changes_requested` returns DSH to `fixing`; re-submit works;
   - only non-blocking findings stop at `waiting_review_decision`;
   - a workspace change between submit and verdict produces a VOID relay
     (`void`/`no longer valid`) and stays `executing`, never forges `passed`;
   - re-`submit` after invalidation succeeds (phase gate is consistent).
4. Failure drills (see also the process-level suite in `test/process-fault.test.ts`):
   - kill a DSH process mid-claim, restart → the stale `processing` row is taken
     over and delivered exactly once;
   - two processes racing claims on one DB → disjoint claims, no duplicate;
    - cancel a CLI review/reconciliation → only the exact audit child is
      terminated; the task history and other submissions remain untouched;
    - the legacy codex-callback child that ignores SIGTERM → dispatcher
      SIGKILL-escalates;
   - cancel a workflow, then deliver a late verdict → `cancelled` receipt, DSH
     never wakes up.
5. Ops check:
   - `workflows`, `show --workflow <id>`, `queue --json`, `retry --request <id>`
     (dead-letter→retry, idempotent), `prune --older-than <ms> --commit`
     removes only terminal data (dry-run default).

## Rollback

- The previous stable version `1.1.4` is a normal `pnpm` package; downgrading is
  just reinstalling it. Its legacy file-queue data is still imported by the current plugin, and the
  import is one-way (the SQLite queue is authoritative once written).
- If the current release must be pulled: stop the plugin/dispatch traffic first, restore the
  package, and verify with `pnpm doctor` before resuming. Record database and
  log state are not modified by a version change (only by `prune --commit`).
  Old workflow records need no migration (1.1.4/1.1.5/1.1.6 added only behavior; the
  last schema-visible change was 1.0.10's OPTIONAL fields
  `reviewContractFailures`/`latestReviewConflict`, which old records default to
  0); records with a distinct `reviewerThreadId` continue using that task.

## Do NOT

- Do not push to user `$DSH_HOME` outside `storages/dsh-codex-workflow`.
- Do not modify or rotate any credentials (this plugin never stores them).
- Create the `v1.1.10` Git tag and corresponding GitHub Release only after all
  automated and real-environment checks pass.
- Do not commit or touch `docs/research/` or `docs/superpowers/` (untracked).

## Residual risk register

- **Offline doctor** cannot prove Codex login/model/app-server availability;
  those checks are reported SKIPPED and must be confirmed by a full `pnpm doctor`
  in a real environment.
- **Windows permissions**: on hosts without the needed symlink/ACL rights the
  platform-specific permission scenarios are covered by tests only when the
  platform allows them; the runnable suite is otherwise platform-neutral.
