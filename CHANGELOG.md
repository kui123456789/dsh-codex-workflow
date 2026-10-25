# Changelog

All notable changes to `dsh-codex-workflow`.

## [1.1.15] - 2026-10-25

- Support DSH 0.2.1-rc.3 while retaining the existing development baseline and older host ranges.
- Register the authenticated model-catalog and workflow-state routes through the HTTP service context required by newer Cordis hosts.
- Preserve native Codex one-shot child conversations on activation-only hosts without invoking the parent model loop; retain the legacy subagent API on older hosts.
- Persist sidebar state in the plugin's SQLite database on newer hosts instead of appending unsupported custom events to their session journals. Restore the sidebar through a read-only RPC with cancellation and stale-response protection; older hosts continue using their native projection even when sidecar state exists.
- Verify the selected desktop runtime consistently, including distributions without declaration files, real RPC registration/unload, updated persistence services, and cold parent/child journal recovery. Existing historical chat logs are not rewritten or migrated.
- Serialize Windows process-tree queries for the same original backend so fork, start-receipt and interruption bookkeeping do not launch competing CIM scans. Each executed query still takes a fresh snapshot within its existing native query budget; retired owners and released receipts cannot start unnecessary queued queries.
- Prefer an existing standard PowerShell 7 installation for lower-overhead Windows CIM queries, with Windows PowerShell fallback. Keep the same CreationDate-to-FILETIME identity source and four-second query timeout.

## [1.1.14] - 2026-10-18

- Harden bridge verdict delivery: retry evidence validation and post-relay bookkeeping failures, preserve reclaimable claims when retry persistence fails, and restore the terminal relay watchdog after receipt recovery without repeating the relay.
- Retry legacy workflow and queue imports after I/O or SQLite failures without treating them as completed migrations; retain malformed-file isolation. Imported receipts complete existing queue rows so they cannot be delivered again.
- Publish pre-schema backups atomically from unique temporary files without overwriting a backup won by another store. Keep backup failures closed and retryable.
- Complete independent teardown steps even if an earlier disposer fails, preserving the first error and the original process ownership checks.
- Compare native child identity instead of numeric PID inequality in initialization recovery tests, allowing operating-system PID reuse.
- Retain the DSH 0.1.7-rc.2 development baseline while declaring the exact 0.2.0-rc.2 and 0.2.1-rc.2 peer alternatives. Synchronize release checks and register workflow event types before persisted host replay.
- Add a source-checkout visual demo for planning, execution, review, and same-thread recovery; it uses simulated events and makes no model calls.

The following accumulated reliability changes are included in this release:

- Scope same-thread Reviewer continuation to failures raised by an actual model call. Progress, checkpoint and storage errors that only resemble a transient transport diagnostic now terminate the current round without issuing another model turn; explicit upstream model-failure markers remain recoverable.

- Release a claimed ephemeral Reviewer when binding persistence fails after cancellation, lease loss, stop, or thread loss prevents retention. This keeps the exact subscription and App Server round from leaking while preserving same-thread retry when the operation is still eligible.

- Retain an ephemeral Reviewer when its DSH binding callback fails with a transient-looking local error, and retry that binding callback before any later model turn. The same Reviewer and subscription are reused; non-ephemeral binding failures keep their existing terminal behavior.

- Retain immutable startup census observations on the original native child and preserve them through lost-process cleanup or the existing PID-only startup-retirement barrier. Each cleanup reports the original startup prefix plus only its latest refresh attempt; late capture cannot backfill ownership or authorize a replacement.

- Preserve sanitized process-census diagnostics on original cleanup errors. Record only fixed observation codes, elapsed duration, numeric exit data and whitelisted errno/signals; keep commands, environment, stdout, stderr and raw error text private. Diagnostics cannot authorize continuation or replace an original process.
- Preserve the same sanitized diagnostics during lost-process descendant refresh, distinguishing missing identity evidence, unavailable capture, incompatible birth domains and conflicting original instances. Refreshed evidence still requires independent exit confirmation; uncertain cleanup retains the same original and blocks replacement.

- Attach the same sanitized census observations to fork creation and conversion cleanup barriers, so a failed fork-tree retirement reports bounded diagnostic codes without exposing raw process-query output or weakening the no-replacement rule.

- Preserve sanitized original retirement-census observations on cleanup errors: fixed failure codes, elapsed duration, numeric exit code and whitelisted errno/signals. Keep raw command, environment, stderr and output private; observer failures cannot change capture evidence, model retry or original-process cleanup barriers.

- Measure original process-tree exit confirmation grace with the monotonic performance clock. Wall-clock rollback cannot extend an exhausted wait, and a forward adjustment cannot end a live wait early; preserve the original identity proof, one termination signal and independent exit confirmation.

- Retry an unavailable retirement census once while the same original native child remains live and owned by the SDK. Capture before closing that child; repeated unavailability or owner retirement preserves the cleanup barrier and never authorizes a replacement backend.

- Attempt every owned cleanup step in the multi-manager foreground recovery regression before reporting its first stop error. Join finally and after on one cleanup flight; a rejected stop keeps the native test failed without stranding the remaining original SDK or fixture storage.

- Reject invalid Bridge retry deadlines before changing the fenced queue row, preserving its attempts, owner and lease instead of creating an unreachable NULL-deadline retry. Keep heartbeat regressions on the same 200ms TTL with a controlled Date clock.

- Return detached model-catalog snapshots and keep the App Server cache immutable against caller mutations.
- Share concurrent model-catalog reads within one App Server generation without sharing caller cancellation.
- Fail closed when the pre-schema-v2 coordination backup cannot be written, preserving the original database for recovery.

- Retain actual native ChildProcess instances in model-catalog lifecycle regressions; a reused numeric PID cannot fail historical cleanup checks or authorize model work.

- Recognize both numeric and signal exits before stdin closure and termination escalation, preventing repeated EOF or kill attempts against an already completed original App Server child.

- Validate persisted Planner/Reviewer retry checkpoints with strict JSON types on read, write and migration; reject corrupt continuation selectors before status or SQLite updates, while retaining legacy interruption-only records.
- Make the owned launcher recovery regression and its cleanup compare captured process births so a reused numeric PID cannot fail the test or receive a stale termination request.

- Preserve known terminal callback diagnostics when an SDK child closes by signal; unknown signal exits retain their existing retryable behavior.

- Keep known terminal diagnostics terminal when a CLI child closes without a numeric exit code. Unknown signal exits retain their existing retryable behavior; preserve caller cancellation, original errors and single model admission.

- Preserve terminal failure diagnostics during legacy failed-submission migration. Require the shared transient classifier before writer-hint recovery; keep exact legacy busy migration and explicit first-review retries available.

- Connect shared Reviewer observation tests to native test cancellation, named fixture waits and idempotent after cleanup. Preserve failure reporting, original scenario deadlines and ownership assertions; stop only the case's owned fake backend after a timeout.

- Apply the shared recoverable-error classifier to both callback continuation and retained-thread recovery. Terminal details override embedded timeout/rate-limit/writer hints; do not send another visible request, convert a failed result or park terminal failures. Preserve genuine one-time continuation, original Reviewer retention after repeated generic failures, cancellation and confirmed cleanup.

- Correct Planner and shared Reviewer model instructions to identify the current DSH child Session and Codex Review sidebar as the readable output destination. Preserve read-only scope, task language, Markdown sections and separate structured conversion; validate the instructions delivered to foreground and Bridge flows without changing their thread lifecycle.

- Apply App Server text/plan replacement snapshots by exact kind and full item id in the original native child segment, including tool-buffered text. Retire the superseded transient attempt before publishing the corrected snapshot on the same turn/step; preserve committed history, ordinary deltas and continuation identities. Ignore identical snapshots without another model request or display restart.

- Preserve streamed partial output when a native Codex child turn fails, is cancelled or begins continuation. Append the original diagnostic after the current segment and buffered tool-following text instead of overwriting it; keep successful authoritative output, failure state, tool balancing and original-child identity unchanged.

- Require original native test-event receipts for isolated verify/release gates. Preserve human reporters and actual exit codes, validate every test file and the final cumulative summary, and reject missing/duplicate/displaced receipts, premature zero-exit workers, skips/TODOs and async warnings. Create receipts exclusively and scope them to the original source directory so independent descendant launchers cannot claim the parent run.

- Add `pnpm verify:isolated`: snapshot verification inputs, run the complete gate chain in an independent build directory, retain logs and verified artifact hashes, and check original source/build content and HMR metadata for drift. Keep canonical Git diff checks in the source repository.

- Preserve exhausted sidebar retry allowances per original target and check the retry window before opening a native child or summary. Ordinary progress cannot restart exhausted retries; distinct targets and successful retries keep their normal paths.

- Use one monotonic process clock for control, visible-turn and CLI retry budgets. System clock corrections cannot extend an expired budget or end a live budget early; explicit clock hooks, original outcomes and cancellation priorities remain available.

- Retire the browser sidebar scanner before releasing its subscriptions. Ignore already captured Host notifications and retry callbacks after unload, release each projection observer once when switching sessions, and make plugin disposal idempotent. Preserve normal discovery and original-child selection.
- Handle cold sidebar projection reads with one immutable loading snapshot shared by client/server getters. Render loading before data arrives, preserve the original face receiver and subscription updates, and distinguish loaded empty workflows from loading. Prevent undefined-projection crashes and fresh-object snapshot render loops without creating agents or model requests.

- Publish Planner process state across original-thread pause, continuation, pending receipt and confirmed failure cleanup. Preserve this optional field in the display projection and show a paused planning heading without granting resume eligibility. Invalidate v1 projection checkpoints for full original-log replay; retain legacy logs without guessing their process state. Extend real receipt/abort/cleanup regressions and the installed-host recovery smoke.

- Render review summary headings from the latest declared process state. Distinguish paused, failed, cancelled and stale progress from completion, retain running progress messages, and show Planner clarification/failure/readiness states. Label history cards as attempts so recovery is not presented as a new business review round; pause text does not grant continuation eligibility.

- Keep waiting and completed Reviewer conversations in the native sidebar by selecting the latest review's original child after `activeReview` clears. Prevent the summary fallback or an older Planner from displacing that conversation; retain the fallback for legacy childless reviews and open the new child for a genuine new review round.

- Strengthen the installed-host recovery smoke with native JSONL journals and independent reads after original-child disposal. Keep write handles across session publication and retirement, verify complete parent/child events and message replay, and preserve the original catalog identity across all eleven existing scenarios. This check remains isolated and scripted; it does not certify real-provider failures or browser behavior.

- Contain storage exceptions raised by manager lease heartbeat renewal. Treat an unconfirmed renewal as loss of the original admission, stop its timer and notify its existing owner once; do not let a SQLite busy/error escape into the host. Keep explicit renew/release failures, successful renewal, peer leases and original-review cleanup behavior unchanged.

- Make shared Reviewer test waits observe their TestContext signal and preserve the original cancellation reason. Register cleanup hooks for the six unavailable-review scenarios, join duplicate cleanup, and stop the owned manager before awaiting its background work. Keep existing 30-second case limits and cancelled-test verdicts; add isolated controls for held lease notices, background joins and a real native test timeout.

- Add an optional `DSH_WORKFLOW_TEST_REPORTER=spec|tap` test-launcher setting inherited by verify and release checks. TAP provides ASCII summary counters for redirected Windows consoles. Explicit Node reporter flags take precedence; invalid settings fail before spawning, while test discovery, concurrency, filtering and failure exit codes remain unchanged.

- Preserve the original CLI cancellation cause when an admitted operation hands its signal to a later stage after dispatcher stop. Match the still-owned signal and workflow/submission identity before applying the stopped admission gate; keep new stopped requests, displaced identities, callback errors and non-Error reason fallback unchanged.

- Retain CLI cancellation for the complete public review/conversion call across readable-output capture and result callbacks. Wait for admitted callbacks during stop, reject pre-aborted cached requests before capture, and prevent downstream model stages or successful delivery after cancellation. Share operation ownership with the existing retry loop and preserve callback failures, peer isolation and future explicit reuse.

- Retain CLI workflow/submission cancellation throughout each transient retry operation, including backoff between child processes. Use the same cancellation signal for admission, execution and waits, preserve the first cause, stop additional attempts after cancellation, and await owned retry completion during dispatcher stop. Make original-child termination idempotent when signal and direct cancellation overlap.

- Include pending CLI admission calls in workflow/submission cancellation and stop. Combine per-call cancellation with the caller signal, preserve the first reason and peer/owner isolation, clean the pending registry after handoff or failure, and recheck cancellation during synchronous spawn setup before prompt delivery.

- Reserve known CLI Reviewer thread admission before asynchronous waiting. Serialize same-thread callers through original process close and identity binding, retain cancelled tickets behind their predecessor, release on synchronous spawn failure, and keep different threads independent without adding a queue dependency.

- Observe caller cancellation while waiting for an occupied CLI Reviewer thread. Reject the cancelled waiter promptly with its original cause, remove its listener and create no child, while preserving the admitted owner's process, identity binding and other waiters; retain existing execution retry and deadline policies.

- Retain CLI caller cancellation observation through original thread identity binding after process close. Release the abort listener only when that admitted binding settles, preserve the first pending cause, and avoid normalization or another process after cancellation; keep original binding ownership and model timer bounds.

- Consume CLI stdin/stdout stream errors and synchronous prompt-write failures through the original child cleanup path. Preserve the first cause and prior cancellation, await original close and admitted identity binding, discard output after pending failure, and consume retired errors without affecting a successor or starting a model retry.

- Consume CLI stderr Readable errors without crashing the host or rejecting healthy stdout model results. Annotate only the owning process's failed exit with diagnostic loss, preserve original failure classification and cancellation, and consume retired stream errors without contaminating a successor.

- Enforce CLI stderr retention in UTF-8 bytes across chunks and final decoder flush, keeping complete trailing code points instead of slicing UTF-16 units. Recheck stdout after its decoder flush so final replacement characters cannot bypass the existing output limit; preserve the first pending error and original process/thread ownership.

- Enforce the configured retry delay ceiling after jitter and millisecond rounding. Positive jitter cannot exceed `transientRetryMaxMs` or prematurely exhaust a remaining budget that could admit a capped retry; preserve negative jitter, original-thread recovery and existing retry deadlines.

- Recheck cancellation and the original retry deadline after backoff sleeps in control, visible-turn and CLI retry loops. Delayed or exact-deadline wake-ups cannot start extra attempts; preserve the original cancellation cause, last transient result and actual attempt count. Initial zero-budget calls and separate workflow continuation limits stay unchanged.

- Enforce the shared diagnostic summary limit in actual UTF-8 bytes, including the omission marker. Preserve complete code points at both ends and report the exact number of removed source bytes; tiny limits return a complete prefix. CLI classification and retry behavior still use the full original diagnostic.

- Preserve original stderr buffered after actual process exit through a bounded 100ms diagnostic drain. Invalidate the exited thread immediately, settle its failure before successor admission and stop cleanup, and explicitly mark an inherited pipe that misses the diagnostic deadline. Keep physical process-tree proof and existing RPC/turn timers.
- Decode stderr with a UTF-8 StringDecoder owned by each original child, preserving characters split across real pipe chunks. Flush observed bytes when its diagnostic is finalized, keep the 16,384-unit tail bound, and discard a clipped leading low surrogate instead of publishing half an emoji. Retired bytes and diagnostic read errors retain their existing ownership rules.

- Consume stderr Readable errors without crashing the SDK or invalidating healthy stdin/stdout JSON-RPC. Keep the original thread and active turn usable, annotate only the current process's eventual exit with a fixed diagnostic-unavailable marker, and prevent late retired pipe errors from contaminating a successor.

- Handle spawn failures that return a ChildProcess without stdio. Register original lifecycle/error ownership before admitting RPCs, preserve the asynchronous native cause instead of a readline TypeError, and bound missing-stdio receipt waits with the existing control budget. Cancellation/stop consume late receipts; no-PID failures create no phantom retirement, while an actual incomplete child is retired normally.

- Preserve the first original stdin/stdout failure in one transport guard. Reject startup if stdin fails after the handshake ACK but before readiness, preserve the exact cause through shared observers and cleanup, and block later RPCs on a broken ready process without replacing its thread or hiding the error behind a generic write failure.

- Independently confirm missing original Windows processes when a kill-zero probe remains unknown or returns EPERM. Require complete saved birth identities and a successful, validated OS absence receipt; denied queries, partial replies and live matching instances keep their guards. Lost-process refresh shares this proof without signalling or borrowing reused PID descendants.

- Invalidate RPC availability when the original stdout closes or errors while its backend remains alive. Settle pending observers with the first output failure, retain original model/receipt cleanup responsibility, block implicit bootstrap, and isolate retired stream errors; keep actual exit/stderr diagnostics through a bounded close-observation window.

- Retain successful initialization's original backend identities after unexpected launcher exit. Refresh later descendants only through birth-matched surviving originals, keep failed cleanup guarded, and require cleanup before an explicit successor startup or permanent stop; unfinished identity collection prevents premature idle shutdown.

- Confirm ordinary App Server backend instances have exited before permanent SDK stop returns, even when no fork was created. Share one retirement census and close with idle/initialization cleanup; failed proof retains the stopped latch and permits only cleanup of those original instances.

- Retire a rejected initializer's captured original backend tree before admitting another startup, while preserving its primary handshake error. Keep lost-census cleanup unknown instead of respawning, and prevent later explicit requests from rejoining an already rejected initialization flight.

- Confirm the captured original idle App Server process tree has exited before external CLI handoff or successor startup. Retain failed retirement for cleanup of the same instances, keep caller cancellation separate from shared cleanup, and preserve the permanent stop latch through cleanup-only retries.

- Retain completed persistent-source conversion output separately from unconfirmed fork cleanup. Same-context retries release the original subscription and return the cached result without another model or fork; observer cancellation, original interruption proof, idle shutdown, source unsubscribe and external handoff preserve resource ownership until exact cleanup.

- Validate the required `thread/unsubscribe` status before clearing local subscription ownership or usage. Missing, unknown and null responses keep abandoned-fork cleanup guarded until a valid original acknowledgement; they cannot authorize another fork or source model turn.

- Confirm captured original fork backend instances have exited before reporting SDK teardown complete, including when the launcher exits first. Use birth-bound Windows handles or Linux pidfds, retain unconfirmed cleanup for stop-only retry, and never start a replacement backend or model during cleanup.

- Preserve the original persistent-source conversion fork across caller abort/timeout before its creation reply, preventing duplicate forks and orphaned subscriptions. Bind retries to the original process, source owner and conversion input; retain abandoned public-fork cleanup until the real unsubscribe ACK, and stop already-cancelled callers before submission. Explicit healthy public fork calls remain independent.

- Separate caller timeout/cancellation from the lifetime of a submitted model start, preserving its original late reply route and process-local recovery capability.
- Keep Planner, foreground Reviewer and bridge callback stages in the same child/thread while a start reply is pending; foreground resume and the original Bridge submission's background retry adopt that reply without repeating the model request or resetting continuation budgets.
- Persist safe pending-start markers and process guards, retain cancellation/stop cleanup until exact proof, and coordinate child/pin ownership across native input and concurrent recovery.
- Preserve original private review seeds and completed stage output during recovery; fresh callbacks replace abandoned observers, and internal conversion JSON stays out of the sidebar.
- Distinguish safe pending-receipt inspection and original-turn cleanup from a new model continuation in tool guidance and recovery documentation; Bridge recovery keeps its admitted background submission instead of using foreground resume or resubmitting unchanged material.
- Retain scoped protocol errors received before the original turn/review start reply and reconcile them only against that request's authoritative writer pair, including detached reviews.
- Preserve the earliest matching cause without letting foreign or ambiguous hints authorize cleanup or hide a later matching error; failed ACK recovery remains cleanup only, with no model replay.
- Exclude stale Windows parent-PID links whose child predates the captured parent instance, preventing unrelated older processes from holding original-turn cleanup open; unknown creation metadata remains conservative.
- Isolate parsed input/turn dispatch exceptions from the SDK host and latch the first protocol contract error to its uniquely registered original process, thread owner and turn.
- Register original turn ownership before asynchronous callbacks and reject protocol faults before returning completed output or resending native answers.
- Keep failed interruption ACKs in terminal cleanup waiting with the original child and cause; prevent Planner from treating cleanup-only protocol errors as ordinary model continuations.
- Scope App Server stderr diagnostics to each original child, preventing real late pipe output from contaminating an independent successor's public exit error.
- Preserve the current exit prefix, bounded text tail and failure policy while ignoring retired-child diagnostic events.
- Capture immutable original process birth identities for unconfirmed interruption and carry them through Planner, Reviewer, auxiliary cleanup and persisted guards.
- Distinguish exited originals from new instances at reused PIDs using Windows CIM or Linux boot/start ticks; preserve unknown identities and conservative legacy records without recreating threads.
- Recheck cleanup guard owners and lease epochs after asynchronous identity queries, rejecting changed rows or failed conditional updates before admitting new work.
- Unify control RPC settlement so timeouts and synchronous write failures release the original timer, pending entry and abort listener exactly once, preserving the primary cause.
- Consume original stdin stream errors after shutdown or process replacement; preserve the stop rejection when a queued write reports EOF after its original child exits.
- Isolate each caller's cancellation while sharing App Server initialization; preserve the original process for remaining observers and reject cancelled waits before the handshake completes.
- Abandon initialization only after its last observer withdraws; serialize independent later bootstrap behind original-process cleanup and retain permanent-stop fencing.
- Invalidate model directory/default caches when their original App Server process changes; preserve same-process cache hits and explicit model/effort overrides for independent new work.
- Fence asynchronous catalog parsing, default derivation and named/fallback Plan-mode metadata by their captured cache generation, so late old results cannot repopulate a successor's namespace.
- Prepare and recheck the actual process around public model metadata reads; admitted Planner/Reviewer settings remain frozen to their original thread owner.
- Preserve failed or malformed initialization causes, clean only the failed original child, and require initialization again before accepting a later SDK request.
- Make full-suite file concurrency configurable through `DSH_WORKFLOW_TEST_CONCURRENCY` (1–4, default 4), so memory-limited hosts can run the same complete suite with fewer workers.

- Bind model requests, native answers, interruption and subscription cleanup to the original App Server ChildProcess and thread registration; reject a replacement process even when it reuses the same public IDs.
- Carry opaque transport owners through Planner checkpoints, foreground/background Reviewer recovery and private alignment/reconciliation; preserve a successor's live writer, subscription and usage cache after old cleanup.
- Bind current and historical metering to the admitted execution owner, rejecting stale bindings before and after asynchronous persistence so old callbacks cannot replace a successor's source or model attribution.
- Document fixed vscode-jsonrpc and gRPC cancellation patterns and distinguish original-thread recovery from durable queue/result delivery after restart.
- Scope successful terminal and auxiliary cleanup receipts to their original execution owner; reused workflow/thread/turn IDs or a historical confirmed tombstone cannot acknowledge a new run.
- Require the exact session, token and lease epoch for persisted cleanup confirmation/release; preserve a successor's marker even when its scope and primary error match the old run.
- Publish each new terminal run's guard before its waiting marker, keep failed ACK recovery model-free, and share concurrent confirmation only within the same original owner.
- Preserve a newly registered auxiliary owner after an old ACK arrives, releasing only the old execution's process pin and retaining the new writer's subscription.
- Clarify no-ID status/resume and late original creation receipts: caller abort does not imply process restart, and duplicate-start guidance is not a permanent failed-start quota.
- Confirm original-turn cleanup after failed registration/settings callbacks and unexpected private user-input requests; retain failed ACKs with a cleanup-only marker, original cause and captured process tree.
- Keep terminal Planner/Reviewer recovery strictly cleanup-only, preserving the original thread/child/pin and primary error until exact confirmation; no automatic model continuation or replacement is permitted.
- Persist an independent terminal cleanup guard across Manager views, cancellation and scope changes; elapsed lease TTL does not prove writer termination, and confirmations never rewrite a successor's workflow.
- Preserve rejected background Reviewer resources through persistent retry and cancellation, and reconcile remaining resources after the owned SDK actually exits during plugin shutdown.
- Clear native input on terminal notifications while keeping terminal receipts, and retain specific returned conversion diagnostics instead of replacing permission/Schema failures with generic turn failure.
- Preserve completed Planner stages and resume only failed conversion or controlled completion on the original thread/child; keep one automatic continuation budget across clarification and manual resumes.
- Send short private-stage continuations without replaying the complete planning input; freeze effective model/effort choices and reject missing or changed checkpoints instead of reconstructing context.
- Capture validated successful Planner receipts before caller-abort checks, prevent completed conversion/completion replay, and show the actual completion output in the native child conversation.
- Collect admitted Planner creation responses within the original RPC deadline after caller abort; report pending startup, retain a returned original thread/child for continuation, and clean cancelled or stopped late resources once.
- Expose only the current session's latest failed Planner startup for no-ID diagnostics when there is no active workflow; reject terminal recovery and earlier-task fallback, and check cancellation before initial creation admission.
- Retain validated foreground review stages and resume only failed conversion, alignment or correction work, keeping the original Reviewer and child with one automatic continuation budget for the whole round.
- Preserve exact private-turn cleanup receipts, original scope/settings/evidence and unavailable-result guards; temporary final evidence reads can finish from the cached verdict without another model call.
- Reject default repeated registered terminal failures and unresolved contract rounds; require real original-scope changes or explicit independent-round intent, while retaining first-thread startup retry.
- Save CLI correction output before normalization, keep the legacy two-argument API, and use non-persistent exec calls without resuming placeholder thread IDs.
- Prioritize permission/authentication rejection over mixed stream/overload text in both retry layers, and preserve strictly classified raw generic CLI model failures through their process envelope.
- Retain the foreground unknown-interruption barrier when its launcher exits during process-tree capture, and durably save confirmed cleanup before an aborted continuation startup restores its waiting handle.
- Persist original backend-process evidence for unconfirmed foreground Reviewer interruption; an empty Manager runtime, unavailable SDK projection or explicit new-round flag cannot bypass an original live/unknown writer.
- Admit new foreground business reviews on the existing workflow after verified changes in its original evidence scope, including process loss; require explicit independent-round intent for unchanged evidence and keep that control out of review material.
- Confirm outstanding original Reviewer interruption before replacing its round, retain waiting resources on failed confirmation, and acquire the same review lease for direct original-thread resume.
- Distinguish concurrent foreground new-round intent from identical original review material, rejecting conflicting requests before another Reviewer is created.
- Align background status, turn-stop guidance and submission notices with original-thread or completed-result unavailability, preserving the primary failure and reporting distinct recovery reasons.
- Reject default unchanged-material submissions after original resource loss; verify changes in the original file scope or require an explicit new independent review request, keeping admission controls out of saved review material.
- Preserve first-review startup retry before thread registration, legacy callback behavior and unknown historical failures; add read-only interpretation of exact project-owned historical unavailable diagnostics.
- Transfer active and retained background Reviewer consumers on their original thread and native child; old lease loss and late finalizers cannot cancel or dispose a valid successor's shared resources.
- Route shared-model progress, display rewrites and metering hooks through the current admitted consumer; separate consumer wait cancellation from physical model cancellation and await owned cleanup before release.
- Report retired or missing original ephemeral background resources explicitly, including fresh-process recovery, instead of rebuilding the same review; preserve legacy callback adapters and explicit workflow cancellation/plugin stop.
- Retain exact review heartbeat registrations across asynchronous cleanup; old callback finalizers and ownership-error handlers cannot stop a still-running successor's timer.
- Validate heartbeat startup before replacing a registration, reject obsolete stale probes without revision writes, and preserve explicit cancellation/plugin-stop timer cleanup.
- Carry explicit Bridge progress guards through private alignment/reconciliation creation, turn registration, retry and conversion; revoked work cannot publish fallback progress or invoke another fallback model.
- Fence callback display/continuation hooks and live-batch emission with a current SQLite snapshot and actual lease, retaining valid-owner progress and dropping pre-takeover buffered updates after supersession.
- Preserve final observation authority for a terminal phase committed by the owning submission, without accepting arbitrary phase changes or weakening scope/lease checks.
- Snapshot effective foreground Reviewer request settings, preserving automatic/manual continuation choices and an unresolved model omission across global configuration changes; missing original settings fail explicitly without replacement.
- Use the captured model for foreground conversion, authority alignment and reconciliation; keep existing private effort policies and allow explicit new review rounds to select new unsaved settings.
- Fence Bridge final observation and cleanup-note updates by original submission context and the current actual lease; a revoked callback cannot update successor revision/timestamps or emit its review-end event.
- Capture immutable original Reviewer scope, settings and waiting attempt in process-local recovery handles; status, resume and explicit changed-workspace preparation share identity checks instead of retargeting a retained thread from changed records.
- Recheck Reviewer identity after interruption cleanup and claimed startup; reject missing/drifted identities without model work or replacement-history writes, retain the original handle for cleanup, and permit legitimate same-thread attempt advancement.
- Limit full-suite execution to four independent test-file processes while preserving all tests and scenario-level concurrency; avoid core-count-based worker bursts starving local transport and lifecycle fixtures.
- Route parent turn-stop guidance by workflow action: waiting Planner/Reviewer requires status and same-thread resume, and review-only startup failure requests the existing review without inventing implementation work.
- Check the current SQLite row revision, cancellation/teardown and active original operation before nudging; stale reads and already running continuations cannot prompt duplicate review work or consume a valid nudge key.
- Persist review-only workflows in a retryable pre-admission phase and finalize owned startup aborts without false running progress, model handles or review cycles; preserve another manager's lease and record.
- Serialize review-only creation with the session creation lease, recheck active workflows under that lease, and carry the original review scope through admission and child startup to reject displaced tasks before model work.
- Treat a read-only recovery drill query that reaches its observation deadline as `observation_timeout`, retaining the last original workflow/child receipt without cancelling or repeating the admitted prompt; preserve API and mutating RPC errors.
- Finalize foreground child/review-observation startup failures into the same retryable workflow without consuming a model turn or review cycle; return current cancellation and await late child cleanup on stop.
- Guard foreground child adoption, review-start/heartbeat transactions and Reviewer binding against the original scope and attempt; displaced startup cannot run a model or change a replacement record.
- Preserve a claimed waiting Reviewer when continuation startup aborts before observation; restore the exact recovery handle without changing the waiting record or releasing its original child/thread/pin.
- Track admitted Bridge startup through child creation and background transfer; teardown awaits late creation, and cancelled submissions return their current owned state.
- Recheck prepared ownership and the actual lease before and after child creation and inside review-start/progress transactions; reject late children without overwriting replacement handles.
- Preserve startup after a caller-only abort following durable preparation, dispose teardown-late native handles before opening turns, and release leases even when child disposal fails.
- Freeze Bridge submission input before asynchronous collection and recheck the original owner, route, phase and context inside admission transactions; rejected preparation cannot alter a displaced record during cleanup.
- Verify original evidence before every background callback attempt, including legacy recovery; refuse missing/insufficient or changed snapshots without creating a replacement Reviewer.
- Checkpoint a completed Bridge callback through authority-validation failures; retry only validation in the original DSH child without another readable Reviewer or metering source.
- Bind result reuse to the original submission context and workspace evidence, recheck before staging, and refuse silent re-execution when a durable pending marker survives without its process-local result.
- Repair pending markers during retry persistence, suppress unvalidated pass/result projections, and fence progress/heartbeats and lease cleanup against displaced owners.
- Reject foreground reviews of Bridge workflows before creating resources; preserve the original submit/background entry and check session ownership first.
- Release private alignment/reconciliation seeds after their full scope; retain unconfirmed original auxiliary turns for cancel/stop cleanup, without disguising them as visible Reviewer continuations or starting another review.
- Pin each private seed throughout creation, retry backoff and nested rechecks, including Bridge work after the original callback releases its Reviewer; transfer that same pin to unconfirmed cleanup.
- Clarify the interrupted-start tool contract: a missing returned id does not prove a missing record, and unconfirmed interruption permits cleanup-only resume before model continuation.
- Await original-turn interruption before rejecting model waits; preserve unconfirmed pairs with a typed marker that blocks model backoff and automatic continuation. Planner, Reviewer and Bridge confirm cleanup before reusing the original thread.
- Accept later terminal notifications as confirmation, prevent cleanup-driven process respawn after exit/stop, and scope transport callbacks to their current child process.
- Expand installed-host recovery coverage to eleven scenarios, including ordinary Planner/Reviewer interruption failures and cleanup retries; keep real-client stdio fixture evidence separate from scripted-host acceptance.
- Confirm interruption after a native Planner answer is submitted before offering another turn; retain unconfirmed original turns for cleanup-only resume retries, without replying twice or creating a replacement. Cancel/stop handle the retained original pair.
- Validate public foreground return ownership against the calling DSH session, and check Planner scope before cancelled fast returns; keep usage refresh limited to the original business result and owner.
- Capture the original Planner scope in waiting and clarification handles; fence late outcomes, conversion failures, automatic continuation and final mutations to that identity and legal phase. Changed identities report `identity_changed` without consuming the original handle or rebuilding a thread.
- Clear terminal Planner cancellation targets after suppressed native-input commits, preventing repeated cancel/stop from interrupting an already released turn; retain confirmed interruption/restore for an answer aborted before its RPC.
- Recheck foreground review evidence after every model stage before applying verdicts or contract failures; reject changed/unverifiable snapshots without consuming a cycle, emitting repair instructions or creating an automatic replacement Reviewer.
- Bind Git evidence fingerprints to the actual HEAD commit, distinguish verified unborn branches from broken references, and fence final acceptance/observations to the original owner, review attempt and baseline evidence.
- Confirm interruption of an unanswered native Planner turn before offering new-turn recovery; restore the original request when interruption is unconfirmed, and recheck cancellation/teardown after cleanup.
- Expand the installed-host recovery smoke to eight scenarios, including native and completed-question clarification answers and cancellation; record separate formal DSH question/answer acceptance.
- Preserve the original Planner child, thread and pin across native and completed-question clarification; reply or send short answers without starting a replacement or repeating the task.
- Merge identical concurrent clarification answers, cancel their admitted execution and retain submitted answers for original-session recovery after failure or interruption; release native input resources once when cancellation wins a pending commit.
- Retain Planner model and requested effort before startup, failure and interruption; reuse the client-resolved model across transient retries, continuation and visible completion without inheriting later config changes.
- Permit an explicit new review after an interrupted Reviewer's original workspace evidence changes; end the old round once and keep status/resume restricted to original-thread recovery.
- Diagnose changed or unreadable workspace evidence before offering a waiting Reviewer continuation; keep its original handle and recheck ownership and lifecycle after the read.
- Route the legacy Planner `continue` failure-recovery branch through the shared `resume` admission, preventing it from bypassing concurrency, original-thread availability and cancellation checks.
- Claim child disposal once across workflow cancellation and execution cleanup, including asynchronous teardown, without retaining completed child objects.
- Project durable usage history to a concise default Native tool display while retaining full canonical values and saved source history; `codex_workflow_status` can explicitly display usage sources for diagnostics.
- Validate actual complete-operation deadlines against the DSH host limit before registering tools or opening storage; preserve all supported combinations without shortening configured budgets.
- Emit native assistant tool-call advertisements before invocation events and balance stream steps for V4 stored-sidebar replay across continuation; existing corrupt logs are not rewritten automatically.
- Add a loopback-only native DSH smoke helper with private temporary authentication state, selected-session summaries and explicit child role/format diagnostics.
- Persist server-reported original-thread usage as opaque, deduplicated source snapshots in workflow records; retain observations across completion, cancellation, cache cleanup and storage reopen while reporting missing/partial data explicitly.
- Drain late usage before releasing foreground and callback subscriptions, and refresh successful foreground tool output after final metering writes.
- Isolate usage persistence from business-phase/lease fences, preserve retryable metering faults without re-running models, and mark counter regressions, integer overflow and mixed-model sources.
- Admit one foreground review per workflow/input, check review-cycle limits before model execution, and fence review writes to the live SQLite lease so competing or former owners cannot consume duplicate review rounds.
- Preserve measured usage for waiting foreground Reviewers and background Bridge submissions; keep internal fork counters separate from their original Reviewer.
- Continue local model turn timeouts once on their original thread; retain waiting handles after a second timeout, while control-RPC/terminal failures remain distinct.
- Reserve per-operation retry budgets and separate CLI conversion/alignment deadlines in tool timeouts; saturate overflow and release waiting thread subscriptions during cancel/stop.
- Capture actual App Server thread token notifications with bounded, deduplicated snapshots; expose measured original-thread input/cache/output counters in status without estimating total workflow cost.
- Clarify interrupted-start recovery directly in tool descriptions, including manual workflows with auto-trigger disabled; unavailable original handles report failure without parent-authored replacements.
- Add an isolated recovery smoke against the installed DSH ToolRuntime, SubagentRuntime and native session projections, separate from production UI/model acceptance.
- Retain background submission Reviewer threads and native child conversations across scheduled retries; deduplicate identical sends, reject changed request identity, and retry validated result conversion without repeating a readable review.
- Restore background running observations/heartbeats during continuation; release retained subscriptions and process pins on cancel/stop, including asynchronous cleanup and creation windows.
- Expose `status.continuation` from process-local thread availability; probes do not spawn processes or send RPCs, and observed loss of an ephemeral Reviewer fails the original submission explicitly.
- Merge concurrent same-workflow continuation requests after checking DSH session ownership; reject conflicting instructions and wait for admitted continuations during cancellation/teardown.
- Keep interrupted Planner/Reviewer handles addressable without a returned workflow id, append continuation messages to the original child, and send short Reviewer continuation instructions on the original Codex thread.
- Reject continued reviews whose workspace evidence changed; clear stale recovery/error state after success and balance interrupted tool calls before child conversation replay.
- Record fixed-commit GitHub comparisons and the adopted mechanisms in `docs/research/` and `docs/iterations/`.

## [1.1.13] - 2026-09-27

- Recoverable Planner and Reviewer model failures now continue once on the same App Server thread and native DSH child instead of replaying the task in a new subagent.
- A second failure keeps the original in-process thread available through `codex_workflow_resume`; terminal protocol, permission, contract and cancellation errors keep their existing fail-closed behavior.
- Added a DSH Built-in Plugins settings tab for Planner/Reviewer model and reasoning-effort selection.
- Model and effort fields are live settings; new workflow turns pick up changes without restarting DSH.
- Tool progress in the Codex Review fallback sidebar is grouped into collapsible sections, with full text retained inside each section.
- Windows command activity keeps quoted paths and arguments visible instead of stopping at the first space.

## [1.1.12] - 2026-09-27

- Planner and Reviewer runs now create native DSH child sessions with `origin: "subagent"`.
- The right sidebar opens DSH's built-in `subagentchat` resource for the child session; Codex App Server remains the execution backend.
- Codex output is written as native DSH assistant stream events, so the sidebar uses the normal DSH conversation renderer instead of a custom text projection.
- The plugin now requires the DSH `subagents` service and registers its Codex provider through the native subagent seam.

## [1.1.11] - 2026-09-26

- The DSH Codex Review sidebar now shows bounded live Planner and Reviewer text, visible reasoning summaries, and tool activity before turns complete.
- Live updates are batched into durable Session events, preserving the displayed run across page refreshes without exposing private reasoning text or raw tool output.
- Planning publishes an immediate running state, so the sidebar opens when Codex begins rather than waiting for a finished plan.

## [1.1.10] - 2026-09-26

- The browser follows `sidebarRight.mounted` to identify the visible session. The Session list has no `current` property; reading it prevented every automatic tab open.
- The host recognizes the four plugin event types before replaying existing sessions and resumes persisting them with `session.append`.

## [1.1.9] - 2026-09-26

- The Codex Review right sidebar now opens when `codex_workflow_start` publishes a plan, before the first review round; review events continue to reuse the same tab.
- The host plugin now declares its `sessionProjections` dependency and registers the projection synchronously before Session Controller history replay.
- Plugin-owned session events are emitted through the host event bus with `ignorable: true`, allowing older clients to replay history while the current projection consumes the events.

## [1.1.8] - 2026-09-26

- Ephemeral Planner/Reviewer threads now run structured conversion on the same thread instead of forking, because Codex App Server does not provide a rollout for ephemeral fork sources.
- Ephemeral review paths no longer attempt persisted thread read-back; readable streamed output is used for the private conversion and DSH Session projection.
- Added regression coverage proving ephemeral conversion emits a schema turn without `thread/fork`.

## [1.1.7] - 2026-09-26

- Planner and Reviewer execution now uses Codex App Server ephemeral threads, so new workflow tasks stay out of Codex Desktop history and cannot be held by Desktop's writer lock.
- Review lifecycle events are persisted in the DSH Session and exposed through the `codexWorkflow` projection.
- Added a DSH Web client half with an automatically opened `Codex Review` right-sidebar tab for plans, progress, findings, test gaps and review history.
- Legacy durable Planner/Reviewer ids remain readable for diagnostics but are never resumed or opened by new workflow rounds.
- Restored the real-process staged-verdict crash test: recovery preserves the original request identity and remains idempotent across a second process.
- Removed the unused `QueueRepositoryAdapter` and `LeaseRepositoryAdapter`; the active process transport remains wired through `app-server.ts`.
- Removed 21 obsolete skipped tests that asserted the pre-1.1.7 persistent Reviewer/Desktop-lock design; active tests now cover ephemeral creation, fresh rounds, no naming, no resume and process-local cancellation.
- Verification after these fixes: `pnpm verify`, `pnpm host:check` and `pnpm release:check` are required gates.

## [1.1.6] - 2026-09-25

- **Modular workflow architecture.** Planner, Review, Submission and Lifecycle execution now live in application modules with a single shared runtime-state owner; App Server, Bridge and Coordination SQL operations use narrow gateways and repositories.
- **State and compatibility preserved.** Workflow schema v1→v2 serialization/migration, bridge wire contracts, DSH tools, CLI commands, cancellation, recovery and Reviewer cleanup behavior remain compatible.
- **Verification:** 439 tests pass; `pnpm release:check` and `pnpm host:check` pass against DSH `0.1.7-rc.2`.

## [1.1.5] - 2026-09-25

- **A freshly created Reviewer is no longer resumed — that resume is what broke EVERY bridge review on DSH 0.1.7.** The background submission callback created its dedicated Reviewer with `thread/start` and then immediately called `thread/resume` on it. `thread/resume` paginates the thread's history, and a task that has never run a turn has a **registered rollout path whose file does not exist yet**, so the App Server rejects it: `reviewer failed: invalid paginated history lineage for <threadId>: missing source rollout`. Reproduced twice on workflow `00a043f3` (two different Reviewer threads, `reviewStep: review_native_turn`, ~3.8 s, terminal — no cycle consumed). Evidence: `~/.codex/state_5.sqlite.threads` had the row with a `rollout_path`, while that file was absent on disk.
- The fix mirrors what the DSH-led path has always done: **creation already leaves the task loaded under this client**, so the subscription is ours without a resume. The callback now resumes only a PRE-EXISTING Reviewer (the reuse path, where a rollout exists because the task ran a turn before), which is also where the 1.1.3 writer-conflict retry matters.
- Coverage: the rollout constraint is active in the new regression case, so a resume of the created task WOULD fail — the round completing is the proof it is gone; the "each review resumes the dedicated Reviewer" assertion became "only a REUSED Reviewer is resumed", and the pre-existing-Reviewer case (failed resume is never released) is unchanged.
- Verification: `pnpm verify` and `pnpm release:check` green (**432 tests / 432 pass**), `pnpm host:check` green against the installed DSH `0.1.7-rc.2` (8 tools, `peerCompatible: true`).

## [1.1.4] - 2026-09-25

- **A review round now RELEASES the Reviewer claim it took, and the release no longer rides on the business signal.** A DSH-led round claims the Reviewer — the first round creates it (`thread/start` + settings/name), a later round claims the SAME task with `thread/resume` — and never gave that claim back, so a round used to leave its own hold behind for the next one to trip over; and because the release was passed the caller's `AbortSignal`, a cancelled or timed-out round could abort the very `thread/unsubscribe` that frees the lock. **Two different holders are involved and they used to stack** — this entry fixes only the plugin's own: the conflict measured on workflow `d9cfdedc` was held by **Codex Desktop's own app-server** (`docs/find-lock-holder.ps1` reported PID 39572 `codex.exe`, parent `ChatGPT.exe`; the same class of hold is documented in `docs/reviewer-thread-lock-2026-09-24.md`), and a foreign hold can only be released from Desktop — 1.1.3 backs off through it, and 1.1.4 removes the plugin's own contribution so a round can no longer leave a second, self-inflicted hold behind. That is why the retry then spent **25 attempts and the full ~20-minute budget** before returning a retryable failure.
- `reviewOnce` now records whether THIS round claimed the Reviewer (`reviewerClaimed`) — set on both the creation path and the `prepareBoundReviewer` path — and releases it in the `finally`, before the review observation is finished. The release is a **subscription release only** (`thread/unsubscribe`): the external handoff `releaseThreadForExternal` is deliberately NOT used, because it ends in an `idleShutdown()` that detaches the child, clears its turn bookkeeping and closes its stdin — calling that per round could tear the SHARED App Server out from under a concurrent bridge callback or planner turn. A gateway without `unsubscribeThread` therefore releases nothing instead of taking that path. Both `releaseReviewerSubscription` and `releaseUnboundReviewer` take no business signal (`void signal`), so cancellation can never cancel the cleanup. Releasing is idempotent and best-effort: a release that cannot be sent never changes the review outcome, the next round simply backs off through the leftover hold (1.1.3) instead of failing instantly, and the failure is appended to the round's terminal progress message instead of being swallowed — that append is itself best-effort, so an absent note means "nothing was reported", not "the hold is gone". The visible Reviewer task itself is untouched, the review stays on it in the Codex store.
- **Every signal-free cleanup is now BOUNDED by its own deadline (`reviewerReleaseTimeoutMs`, default 10 s).** Removing the business signal also removed the only bound on the call, so a `thread/unsubscribe` — or an external handoff that includes an idle shutdown — that never settles would have wedged the caller: the round's `finally`, and with it cancel/teardown. All three cleanup sites now run through one `boundedCleanup` helper (round release, legacy handoff before the CLI callback resumes the thread, reconciliation handoff before the CLI audit resumes it); a timeout is reported, never fatal.
- Cleanup failures are **buffered and flushed after the round's terminal observation write**: that write replaces `lastProgressMessage`, so a note recorded earlier would be silently discarded — which is exactly what happened to the first attempt at this reporting. The buffer is cleared when a round begins, so a note from an unflushed round can never be attributed to a later one. Unbound-Reviewer releases (`releaseUnboundReviewer`) report through the same channel instead of dropping the diagnostic.
- Regression coverage asserts the release at the end of every completed round (`unsubscribedThreads` must contain the Reviewer for each DSH-led review, including the migrated/replaced-Reviewer, post-retry, CANCELLED-after-claim and FAILED-round cases), that the external handoff path is never taken by a round release (`releasedThreads` stays empty — verified against a gateway whose `unsubscribeThread` is really absent, not merely deleted from an instance), that the release carries no business signal, that a failed release preserves the round outcome, is visible on the progress message and is recovered by the next round, that a NEVER-SETTLING release or external handoff cannot wedge the round, and that an unbound release failure is reported — plus, unchanged, that a legacy or origin task is never resumed and therefore never released.
- Verification: `pnpm verify` and `pnpm release:check` green (**432 tests / 432 pass**), `pnpm host:check` green against the installed DSH `0.1.7-rc.2` (8 tools, clean unload, `peerCompatible: true`).

## [1.1.3] - 2026-09-24

- **The Reviewer's App Server CONTROL RPCs are retried through a writer conflict.** 1.1.2 made the Reviewer task visible in Codex Desktop — and that is exactly what makes this a common path rather than a rare one: opening the task (just reading the review) makes Desktop hold its writer lock, so the next round's `thread/resume` fails with `thread <id> already has an active writer`. `resumeThread`, the per-round instruction refresh and the Reviewer creation were called directly, so the round died instantly; the 1.1.1 CLI path retried precisely this condition for up to 20 minutes. They now run through the shared bounded policy (`retryTransient` + `transientReason` + `transientRetry*`), and a spent budget surfaces as `TransientRetryExhaustedError` → the round stays RETRYABLE with no cycle and no `reviewContractFailures` (the callback path maps it to `retryable_busy`, then follows the bounded callback retry + the periodic `recoverCallbacks` sweep).
- **The plugin never releases a lock it does not own, and never locks itself out.** `thread/resume` is what ACQUIRES the plugin's subscription, so a FAILED resume holds nothing; a successful resume followed by a failed settings refresh DOES hold it, so that subscription is released before the retry backs off and the retry re-resumes. A foreign writer (Codex Desktop) is never touched. Backoff holds no writer lock and registers no active turn, and cancel/teardown interrupts a pending backoff immediately through the same `AbortSignal`.
- **Reviewer creation retries the SAME task.** `thread/start` runs once (`startReviewerThreadShell`) and every retry re-configures that exact id (`configureReviewerThread`), so a flaky settings/name call cannot leak one orphan, named-less task per attempt; a terminally failed creation still releases the unbound task (it stays in the Codex store, but nothing holds it). `startReviewerThread` keeps its old contract for other callers and now composes the two steps.
- **Reconciliation preservation is judged CORRECT and stays fail-closed** (no behavior change). The deterministic check already treats findings/test gaps as a multiset, lists conflicted indexes separately from the verbatim preservation manifest, and only a rewrite that preserves every non-conflicting entry may apply; a rejection restores the pre-review phase with no cycle, no `latestReview` and no fix instruction, and the DSH-led and bridge paths both keep it retryable. New regression coverage pins the exact-index semantics (adjacent entries, the finding/test-gap boundary, duplicates of a required entry) alongside the existing end-to-end rejection tests.
- **DSH 0.1.7-rc.2 / cordis 4.0.4 adaptation.** The declared peer range moves to `^0.1.7-rc.2` and the dev dependencies are pinned to the same versions (cordis `4.0.4`), so `pnpm typecheck` and the suite run against the host the plugin actually targets. The vestigial `@deepseek-ai/dsh-code-runtime` dev dependency is gone: nothing imported it, no transitive dependency needed it, and the package is not published at `0.1.7-rc.2` at all. Measured with the host's own evaluator: the previous `^0.1.5-rc.1` range was in fact still COMPATIBLE with `0.1.7-rc.2`, because `dsh` lets prereleases participate in ranges — the adaptation is about developing against the verified baseline, not about a host-level exemption.
- **The one real breaking change: `MessageSourceMap` has no catch-all `plugin` kind any more.** DSH 0.1.7 made message sources a merge-extensible sum type that each producer augments in its own module (`kind` = who produced it, `form` = what kind of thing it is). `src/message-source.ts` now declares `kind: "dsh-codex-workflow"` with `relay`/`notice` forms and builds every injected message from it (`relaySource()`, `noticeSource()`), replacing the interim `as any` cast — a cast compiled, but it hid the contract from the compiler and left the harness unable to attribute this plugin's context to a declared producer. All four injection sites (plan handoff, verdict, submission notice, continuation notice) are typed end to end.
- **The host-compatibility gate now checks the peer range itself.** `pnpm host:check` additionally evaluates the plugin manifest with the host's OWN `evaluatePluginCompatibility` (the same code path that asks the user for an exact-version exemption) and reports `peerCompatible` plus the declared peers; `pnpm doctor` gained the same check, SKIPPED — never falsely passed — when no DSH profile exists, so `pnpm release:check` inherits it. Verified non-vacuous: narrowing the range to `@deepseek-ai/dsh-tools@^0.1.9-rc.1` makes the evaluator report the unsatisfied peer and the host's own `dsh plugin allow-version` remedy. Note the evaluator only judges `@deepseek-ai/dsh` / `dsh-*` peers; the cordis range is the plugin's own dev/test concern.
- Verification: 424 tests pass via `pnpm verify` and `pnpm release:check`, and `pnpm host:check` is green against the operator's installed `0.1.7-rc.2` (8 tools registered, clean unload, `peerCompatible: true`). New coverage asserts a bound-Reviewer writer conflict is retried and the round completes, a conflict that never clears stays retryable with no cycle/contract failure and releases nothing, cancel during the backoff ends the round at once, a transient configure failure retries the SAME task (one `thread/start`), an exhausted configuration releases the unbound task, and the callback path retries the conflict (fixture switch `FAKE_CODEX_BUSY_RESUME_ATTEMPTS` models a lock that clears) while a spent budget stays `retryable_busy` and never releases a pre-existing Reviewer.

## [1.1.2] - 2026-09-24

- **Reviewer tasks are visible in Codex Desktop again.** The plugin's reviews used to run through `codex exec`, and a task created by the CLI is stored with `source='exec'`. The Desktop sidebar is fed by the App Server's `thread/list`, which only ever returns `source='vscode'` tasks: measured on this host, 62 of 72 non-archived `vscode` rows were listed and **0 of 15 `exec` rows were, permanently** — so every CLI-created Reviewer landed in a task the user could never open (the "untitled, does not render" row). `codex exec --thread-source vscode` does not help (it writes `thread_source` only; `source` stays `exec`), and `thread/name/set` cannot fix it either (verified: it renames an `exec` task without a resume, and the task still never appears).
- **The visible review turn now always runs on the App Server** — `thread/start` → `thread/settings/update` → `thread/name/set` → `review/start` — on both the DSH-led path (`review`, `review_only`) and the background submission callback, which is wired back to `AppServerCodexCallbackDispatcher`. The name is `DSH Reviewer: <workflowId>`, and the first review turn produces the rollout the later rounds resume (an empty App Server task has no rollout for `codex exec resume` to find — the 1.0.14 constraint that had pushed creation to the CLI). The Planner path is unchanged, and the 1.1.0 invariant still holds: a review never resumes the Planner task or the bridge's originating task.
- **The CLI keeps only the internal conversions.** `normalize`, `align` and `reconcile` still run `codex exec --ephemeral` (no durable task, no Desktop history). `reviewOnceViaCli` — the last path that created a persistent CLI Reviewer — is gone, so `workflow.ts` no longer calls `createReview`/`review` at all. `CodexCliAuditDispatcher` remains the audit gateway and is still usable as a standalone `CodexCallback`, but it is no longer the plugin's visible-review path.
- **Lazy, non-destructive migration of existing CLI Reviewers.** A record without the App Server origin marker (or whose `reviewerThreadId` still aliases the Planner/source task) counts as unbound: the next review creates a visible Reviewer, persists it with `reviewerThreadOrigin: "app-server"` (internal, never in `show --json`) and never resumes the old task again. The orphaned `exec` task is left intact and renamed best-effort to `DSH Reviewer (legacy, not renderable in Desktop): <workflowId>` — `thread/name/set` needs no `thread/resume`, so the rename can never take a writer lock. The rename applies ONLY to a dedicated, CLI-created Reviewer: an id that still aliases the Planner or the bridge origin task is that task's own title and is never overwritten. Migration adds no review cycle, no verdict and no bridge receipt change.
- **No orphaned Reviewer subscriptions.** A Reviewer task created for a binding that lost the CAS (a concurrent cancel) or whose binding write failed is released best-effort before the outcome is returned; likewise a task that a callback invocation itself created and then could not resume. A PRE-EXISTING Reviewer is deliberately never released by a failed resume — `thread/resume` is what claims the subscription, so releasing there would decrement another review's hold.
- **1.1.1 parity on the now-default App Server callback path.** A transient upstream failure inside its visible turn (`server_overloaded` / "at capacity" / 429 / 5xx / a dropped stream / a writer held elsewhere) is classified by the shared `transientReason` and returned as `retryable_busy` instead of ending the submission as a terminal `CodexCallbackProcessError`; every other failure stays terminal. The submission then follows the existing bounded callback retry and the periodic `recoverCallbacks` sweep, so it stays retryable instead of stalling.
- **The DSH-led visible review turn keeps the 1.1.1 in-tool retry.** The CLI audit used to retry its visible review turn internally (`runWithTransientRetry`); moving that turn to the App Server would have silently dropped the protection, so `review/start` now runs through the same shared wrapper as every other visible turn (planner, completion, display rewrite, reconciliation). The loop was extracted once (`retryTransientTurn` + `transientTurnReason`) instead of being duplicated, and it still retries ONLY a turn that failed without producing visible output whose diagnostic is transient. The failure message of a genuinely terminal review turn now also carries the upstream `error` text — `reason` alone reads just "turn failed" and hides why the round died.
- **Review progress is observable while a review runs.** Every review attempt now persists safe phase diagnostics on the workflow record — `processState` (`running` / `waiting` / `completed` / `failed` / `cancelled` / `stale`), `reviewStep` (`review_native_turn`, `review_readback`, `review_display_rewrite`, `review_conversion`, `review_alignment`, `review_reconciliation`, `review_finalizing`), `reviewAttempt`, `reviewStartedAt`, `lastProgressAt`, `reviewElapsedMs`, `activeTurnId` and a short `lastProgressMessage` — never model text or raw JSONL. `codex_workflow_status` returns them with the record; `show --json` keeps its existing projection.
- **DSH-owned heartbeats make a stuck review visible.** An independent timer (`reviewHeartbeatMs`, default 15 s) refreshes `lastProgressAt`/`reviewElapsedMs` without depending on model output, so a wedged review is observable even when the model produces nothing; `status` classifies a review whose last heartbeat is older than `reviewStaleMs` (default 60 s) as `stale`, and completion, failure, cancellation and teardown stop the timer and record the terminal state. New config: `reviewHeartbeatMs` (clamped 250 ms–5 min) and `reviewStaleMs` (clamped 1 s–24 h), also carried by `cordis.patch.yml`.
- Verification: 416 tests pass via `pnpm verify` and `pnpm release:check` (413 for the visibility change set plus 3 for the review-progress feature). New coverage asserts the Reviewer creation RPC order and its name, that a rename never resumes the task, that a failed `thread/name/set` still releases the created task, that an empty App Server task cannot be resumed before its first turn (the rollout constraint) and the first turn runs on the created task, that a CLI-audited review creates no durable CLI task while still converting through `audit.normalize`, that a failed ephemeral conversion keeps the visible Reviewer bound and consumes no cycle, that a transient failure on the VISIBLE review turn is retried in-tool (and a terminal one is not), that legacy CLI Reviewers are migrated (old task renamed, new visible task bound, origin recorded) while a shared Planner/origin alias is NEVER renamed, that an unbound created Reviewer is released on a cancelled or failed binding (and a pre-existing one never is), that transient turn failures on the callback path stay retryable, and that a long Reviewer turn heartbeats independently and is classified `stale` (or `cancelled`) when it stops. The read-only evidence probes against the real Codex store are recorded in `docs/reviewer-thread-visibility-2026-09-24.md`.
- `pnpm lifecycle:accept` (the manual, live-login harness) still drives the pre-1.1.0 CLI-visible wiring and has NOT been updated for the dedicated-Reviewer layout; it is not part of `pnpm verify` / `pnpm release:check` and must not be used as evidence for this release.

## [1.1.1] - 2026-09-24

- **Transient upstream failures are retried instead of ending the workflow.** An upstream `server_overloaded` reply — `Selected model is at capacity. Please try a different model.` — matched none of the old retry patterns (`rate limit|429|active writer`) and was therefore classified as a TERMINAL `CodexCallbackProcessError`: the audit failed, the workflow stopped at `executing`, and a human had to run the same call again. Capacity is temporary.
- New shared module `src/transient-retry.ts` with ONE classification (`isTransientFailure` / `transientReason`) and ONE bounded-backoff policy (exponential + jitter, wall-clock budget) used by every model call: the CLI audit (`review`, `createReview`, `reconcile`, the display rewrite), the App Server turns (planner start/continue, the completion turn, the display rewrite, reconciliation) and `normalize`/`align`. Terminal conditions — a thread that does not exist, schema/display-contract violations, approvals, cancellation — are still never retried.
- The CLI retry loop no longer uses 9 attempts x ~22 s of linear delay against four hard-coded patterns: it backs off exponentially within `transientRetryBudgetMs` (default 20 min), and a retry RESUMES the task created by the first attempt so a second identity is never opened. When the budget is spent the outcome stays RETRYABLE, never a terminal failure.
- A visible turn is only retried when it failed WITHOUT producing visible output (nothing was persisted, so re-running cannot duplicate a plan, an audit or a rewrite); cancellation and teardown interrupt a pending backoff immediately.
- **Diagnostics keep both ends.** `compactDiagnostic` retains head + tail of a long diagnostic: the old `slice(0, 2048)` kept only the head of the JSONL stream and hid the fatal `task_complete`/error record — exactly the line that explains the failure.
- Tool timeout budgets now include the retry allowance (`startToolTimeout` / `reviewToolTimeout`), so the host can no longer pre-empt a legitimately backing-off operation. A config object that omits the retry fields is normalized, so an absent budget can never turn the bounded retry into an endless loop.
- New config: `transientRetryBaseMs` (3000), `transientRetryMaxMs` (60000), `transientRetryBudgetMs` (20 min; `0` disables), `transientRetryJitterRatio` (0.25).

## [1.1.0] - 2026-09-24

- **The Reviewer always runs on its own dedicated task.** A review no longer resumes the Planner task (DSH-led workflows) or the bridge's originating Codex task (App Server callback path). Codex Desktop keeps a `thread-writer-locks/<id>.lock` writer handle on every thread it has loaded, so resuming a shared task made reviews fail with `thread-store conflict: thread <id> already has an active writer`; the plugin cannot release a lock held by another process. A real workflow stayed blocked from 22:22 until Codex Desktop was restarted, ~1h40m, while the CLI audit retried and finally surfaced the raw conflict.
- The first review of a workflow creates a dedicated Reviewer task and persists it as `reviewerThreadId` only after its identity is confirmed; every later review, repair round, re-review, display rewrite, normalization fork and authority-alignment fork targets that same task, and writer release targets only it.
- **Lazy migration.** Records written before 1.1.0 whose `reviewerThreadId` still aliases `plannerThreadId` (or the bridge `codexThreadId`) are treated as unbound: the next review binds a dedicated Reviewer and replaces the alias. The identity guard against binding a second, different Reviewer stays in force for every non-alias record.
- The originating task is no longer written by the plugin on any path; the readable verdict reaches the originating Codex task and the original DSH session through the existing bridge relay.
- Regression coverage: a busy Planner/origin task (writer conflict on every resume) no longer blocks the review, legacy shared identities migrate to a dedicated Reviewer, and the reviews of a round still produce exactly one visible task.

## [1.0.15] - 2026-09-23

- **Fix the ephemeral fork on Codex CLI 0.154.0.** `thread/fork` now sends `excludeTurns: true` for the ephemeral conversion and authority-alignment forks. App Server 0.154.0 rejects an ephemeral fork without it (`-32600 ephemeral paginated thread/fork requires \`excludeTurns: true\``), so every planning and review flow failed at structured normalization. The parameter only trims the RPC RESPONSE payload (the fork comes back with zero turns); the fork still inherits the source thread's context, so conversion turns keep seeing the visible reply they must convert. Non-ephemeral forks and `thread/resume` are unaffected.
- Verified against codex-cli 0.154.0 with a direct App Server protocol probe (missing → `-32600`, present → fork succeeds, persistent fork still succeeds without it) and a real end-to-end run of the production path (`startThread` → visible turn → `normalizeInFork`), where the conversion fork correctly read a code word that existed only in the parent thread's visible reply. `pnpm verify` passes with 388 tests.

## [1.0.14] - 2026-09-14

- **Fix first review-only task creation.** The first visible CLI audit now runs a persistent `codex exec --json` turn directly instead of creating an empty App Server task that `exec resume` cannot find.
- Persist the validated `thread.started` identity before normalization, including when the first CLI process fails. Later reviews and display rewrites resume that exact task; existing Planner, bridge and legacy Reviewer identities are never replaced.
- Reject missing, invalid or conflicting creation identities and stop if task persistence fails or cancellation wins. Teardown waits for both child exit and the identity write before returning.
- Add regression coverage for creation, split JSONL events, retries, cancellation and teardown, plus `pnpm review-only:accept` for real CLI creation → changes_requested → repair → same-task pass.

## [1.0.13] - 2026-09-13

- **DSH 0.1.5 compatibility.** Raise the host peer baseline to `0.1.5-rc.1` and Cordis `4.0.2`, and align development peers so old core modules cannot silently remain in the test dependency tree.
- Read durable inbox history through `Session.snapshotEvents()`; the removed `Session.events` property caused dispatch and verdict delivery to retry instead of reaching the original session. Crash-replay deduplication now runs against real DSH Session objects in the regression suite.
- Import `JsonValue` from its current public package, `@deepseek-ai/dsh-util-values`.
- Await asynchronous plugin initialization so Cordis activation resolves only after all eight tools and the bridge runtime are registered. Add a real Cordis/SystemPrompt/ToolRuntime activation and unload regression test.
- No workflow or SQLite migration is required. Existing plans, audit history, session bindings and user configuration remain compatible; DSH versions below the new baseline are no longer supported by this release.

## [1.0.12] - 2026-08-29

- **Orphan workflow recovery.** On a normal runtime refresh, workflows whose DSH session has disappeared are safely marked `cancelled` only after a two-lease grace period. Audit records are retained, live sessions are never touched, and active bridge submissions remain recoverable.
- **Historical state is preserved.** Recovery re-checks each row before updating it, records a diagnostic reason, and does not delete coordination or audit data. Existing terminal workflows remain unchanged.
- **Desktop is not interrupted.** The recovery path only updates the local coordination store; it does not open, refresh, navigate, focus, or restart Codex Desktop.
- **npm CLI entrypoint is preserved.** The package `bin` path uses npm's normalized relative form, preventing npm 11 from stripping the `dsh-codex-workflow` command during publication.
- Package and runtime version are now `1.0.12`; no WorkflowRecord or SQLite migration is required.

## [1.0.11] - 2026-08-29

- Reviewer execution now uses backend `codex exec` CLI while Planner execution remains on the App Server/Desktop.
- Visible CLI reviews and reconciliation reuse the existing workflow task without creating another Desktop task.
- Audit completion no longer opens, refreshes, navigates, or focuses Codex Desktop.
- Reviewer configuration now reaches every real CLI child: visible review/reconciliation pass optional `-m <model>` plus `model_reasoning_effort="<reviewerEffort>"`; ephemeral normalization/alignment reuse the model and force `low` effort.
- Legacy records prefer `reviewerThreadId` over `codexThreadId` for CLI resume, writer release, result identity and callback persistence.
- Reconciliation prompts include a verbatim preservation manifest, and deterministic multiset checks reject dropped/rewritten non-conflicting entries, duplicate-count drift, and unauthorized additions without applying a verdict or consuming a cycle.
- CLI audit children are tracked through confirmed exit: same-thread resumes serialize, timeout/cancel/lease loss/teardown use SIGTERM-to-SIGKILL escalation, submission cancellation also owns ephemeral normalization/alignment children, and concurrent `stop()` calls wait for every child to close.

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
- **Alignment output is fail-closed on semantic contradictions.** `parseAlignment` validates against the exact review it was asked to check: `aligned: true` together with conflict entries, `aligned: false` without any conflict, malformed entries and out-of-range indexes all throw, so a contradictory alignment result can never bypass reconciliation — the round stays retryable with no cycle/latestReview/fix prompt (concrete reason preserved on the bridge submission).
- **Reconciliation must preserve every non-conflicting entry.** A deterministic preservation check (severity/blocking/title/body/file/line per finding, full text per test gap) runs on every corrected verdict: a rewrite may only drop the aligned-conflict entries; silently swallowing a real, aligned review entry is a hardened retryable failure (no cycle, no latestReview, no fix prompt), so a corrupt cross-review can never ship a wrong verdict.
- **Authority semantic matrix is pinned by tests (M1-M5).** Contract-level assertions encode every plan-mandated judgement rule (real-command CLI verification must not be escalated into automated-test demands; static checks and real command evidence satisfy file-list/package.json style requirements; a plan-mandated regression test that is missing stays aligned/blocking; a REPRODUCIBLE high/critical defect with concrete file:line evidence crosses the plan's ordinary bounds; generic quality suggestions never do) plus flow tests for the M3 and M4 paths.
- **Real demo-smoke lifecycle acceptance.** `pnpm lifecycle:accept` now drives a REAL Codex segment for the exact demo-smoke contract (three files, exactly two `node:test` cases, CLI verified by REAL command output): the real Planner plans it, DSH creates exactly the three planned files, npm test and both CLI invocations genuinely run, and the real Reviewer runs through the REAL review-authority alignment/reconciliation chain — the acceptance asserts the workspace still contains exactly the three files, the workflow passes, and no JSON envelope ever lands in the persisted task. The formal-DSH-reload runtime probe (pluginVersion, single desktop shell, single DSH, 127.0.0.1:3080) remains an operator-scheduled external step per the project's standing constraint that the agent never restarts DSH itself.

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
