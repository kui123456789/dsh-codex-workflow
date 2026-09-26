import { collectEvidence, isGitRepository } from "../evidence.js";
import { reviewDisplayError, reviewRewritePrompt } from "../review-contract.js";
import { REVIEW_OUTPUT_SCHEMA } from "../schemas.js";
import type { WorkflowStore } from "../store.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexCliAuditGateway } from "../codex-cli-audit.js";
import { ReviewObservation } from "./review-observation.js";
import { TurnGateway } from "./app-server/turn-gateway.js";
import { applyReviewConsistency, formatFindings, parseReview, pluginMessage, reviewConversionPrompt, reviewContractInstructions, reviewInstructions } from "../workflow.js";
import type { ReviewConflictInfo, ReviewInput, ReviewResult, TurnWaitResult, WorkflowConfig, WorkflowPhase, WorkflowRecord } from "../types.js";
import type { WorkflowRuntimeState } from "./workflow-runtime-state.js";
import type { CodexReviewEndEvent } from "../review-events.js";
import type { LiveRelay } from "./live-relay.js";
import type { CodexChildSessionHandle } from "../codex-child-session.js";

type AnyFn = (...args: any[]) => any;

export interface ReviewExecutionContext {
  store: WorkflowStore;
  config: WorkflowConfig;
  runtime: WorkflowRuntimeState;
  reviewObservation: ReviewObservation;
  turnGateway: TurnGateway;
  audit?: CodexCliAuditGateway;
  trackNoChange: AnyFn;
  createReviewerThread: AnyFn;
  releaseUnboundReviewer: AnyFn;
  reportCleanupNote: AnyFn;
  alignReview: AnyFn;
  reconcileReview: AnyFn;
  computeReviewOutcome: AnyFn;
  registerActiveTurn: AnyFn;
  registerEphemeralTurn: AnyFn;
  startReviewWithTransientRetry: AnyFn;
  startTurnWithTransientRetry: AnyFn;
  releaseReviewerSubscription: AnyFn;
  flushCleanupNotes: AnyFn;
  errorMessage: (error: unknown) => string;
  createLiveRelay(record: WorkflowRecord, stage: "reviewing", reviewId: string): LiveRelay;
  createChildSession(record: WorkflowRecord, exec: ToolRunContext, label: string): Promise<CodexChildSessionHandle | undefined>;
  disposeChildSession(workflowId: string, child: CodexChildSessionHandle | undefined): Promise<void>;
}

/** Owns the durable DSH-led review state machine. The manager remains a
 * compatibility facade and supplies narrow lifecycle/cancellation callbacks. */
export class ReviewExecution {
  constructor(private readonly ctx: ReviewExecutionContext) {}
  async run(
    workflowId: string,
    input: ReviewInput,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const pre = await this.ctx.store.load(workflowId);
    const priorPhase: WorkflowPhase = pre?.phase === "fixing" ? "fixing" : "executing";
    const child = pre ? await this.ctx.createChildSession(pre, exec, `Codex Reviewer · ${workflowId}`) : undefined;
    let entering;
    try { entering = await this.ctx.reviewObservation.begin(workflowId, {
      enterReviewing: true,
      step: "reviewing",
      message: "Review started; collecting workspace evidence",
      childSessionId: child?.id,
    }); } catch (error) { await this.ctx.disposeChildSession(workflowId, child); throw error; }
    if (entering.suppressed) { await this.ctx.disposeChildSession(workflowId, child); return entering.record; }
    let current = entering.record;
    const live = this.ctx.createLiveRelay(current, "reviewing", `${workflowId}:${current.reviewAttempt ?? 1}`);
    let reviewerClaimed = false;
    let reviewerThreadId: string | undefined;
    let visibleReviewText: string | undefined;
    let reviewEndDetail: Pick<CodexReviewEndEvent, "verdict" | "result" | "visibleText" | "summary" | "error"> | undefined;
    // 1.1.6: pin the App Server child for the whole round. Without the pin the
    // idle window can fall between creating the Reviewer and its first turn,
    // and the respawned process answers `thread not found` for that new thread.
    this.ctx.turnGateway.beginRound();
    try {
      const evidence = await collectEvidence({
        cwd: current.cwd,
        maxDiffBytes: this.ctx.config.reviewDiffMaxBytes,
        changedFiles: input.changedFiles,
      });
      const git = await isGitRepository(current.cwd);

      const evidenceCommit = await this.ctx.store.update(workflowId, (r) => {
        r.latestReviewEvidence = evidence;
        this.ctx.trackNoChange(r, evidence);
      }, { ignoreCancelled: false });
      if (evidenceCommit.suppressed) return evidenceCommit.record;
      current = evidenceCommit.record;

      // The visible review always runs on a fresh App Server ephemeral thread,
      // even when a CLI audit is configured. The CLI keeps only the internal
      // conversions (normalize/align), which also run in private ephemeral
      // sessions. No new Planner/Reviewer id is persisted or made visible to
      // Codex Desktop; legacy ids are diagnostic only.
      const reviewerModel = current.reviewerModel
        || this.ctx.config.reviewerModel
        || await this.ctx.turnGateway.resolveDefaultModel?.(exec.signal)
        || undefined;
      const contract = reviewContractInstructions(current, input, evidence);
      // Every new round gets a fresh App Server ephemeral Reviewer. Durable
      // Reviewer ids from older records are diagnostic only and are never
      // resumed, renamed or handed to Desktop.
      reviewerThreadId = undefined;
      {
        // Creation runs under the shared transient retry. A retry after a
        // failed configuration reuses the same in-process ephemeral id; a
        // later review always creates a fresh one.
        reviewerThreadId = await this.ctx.createReviewerThread({
          cwd: current.cwd,
          name: `DSH Reviewer: ${workflowId}`,
          workflowId,
          ephemeral: true,
          ...(reviewerModel ? { model: reviewerModel } : {}),
          developerInstructions: contract,
        }, exec.signal);
        let threadCommit;
        try {
          threadCommit = await this.ctx.store.update(workflowId, (r) => {
            r.reviewStep = "review_native_turn";
            r.lastProgressAt = new Date().toISOString();
            r.lastProgressMessage = "Running Reviewer turn";
            // The new Reviewer is an App Server ephemeral thread. Keep only
            // the origin marker for diagnostics; its id is process-local and
            // must never become a Desktop-visible durable binding.
            r.reviewerThreadOrigin = "app-server-ephemeral";
          }, { ignoreCancelled: false });
        } catch (error) {
          // The created task could not be bound: release its hold before the
          // failure propagates, so a failed round cannot leave it loaded.
          this.ctx.reportCleanupNote(workflowId, await this.ctx.releaseUnboundReviewer(reviewerThreadId));
          throw error;
        }
        if (threadCommit.suppressed) {
          // A concurrent cancel won the CAS: the task is never bound, so it is
          // released here instead of being left subscribed under a cancelled
          // workflow (the task remains in the Codex store, unbound).
          this.ctx.reportCleanupNote(workflowId, await this.ctx.releaseUnboundReviewer(reviewerThreadId));
          return threadCommit.record;
        }
        current = threadCommit.record;
        reviewerClaimed = true;
      }

      // Git AND non-Git reviews use the SAME `review/start` custom target. Its
      // instructions carry the FULL per-round context (original task, approved
      // plan, implementation summary, changed files, test results, workspace
      // evidence), the review scope (for Git: the current staged/unstaged/
      // untracked changes to be confirmed with an independent read-only `git
      // status`/`git diff`) and the item-by-item coverage gate — a native
      // review turn sees these directly, so the verdict never depends on
      // hidden thread settings.
      // Capture the PERSISTED-turn baseline BEFORE the native review turn
      // starts: the appended (newly-persisted) turn will be detected against
      // these ids, because the `review/start` RPC turn id is NOT guaranteed
      // to equal the persisted `thread.turns[].id` (real App Server
      // evidence). The baseline read is metadata-only and never touches the
      // thread's writer.
      const reviewBaseline = undefined;
      // 1.1.2: the visible review turn runs through the SAME transient-retry
      // wrapper as every other visible turn (1.1.1 parity on the App Server
      // path). A retried attempt re-registers its own turn, so the active-turn
      // mapping always points at the newest turn.
      const review = await this.ctx.startReviewWithTransientRetry({
        threadId: reviewerThreadId!,
        cwd: current.cwd,
        detached: false,
        target: { type: "custom", instructions: reviewInstructions(current, input, evidence, git) },
        // The App Server reports the ACTUAL review task id through onStarted
        // (an inline review may return a different thread). Enforce the 1.0.8
        // invariant AT THE START — before registerActiveTurn or any store
        // write — so a mismatched id can NEVER be persisted as
        // reviewerThreadId or enter the active-turn map: interrupt the rogue
        // turn and fail the round retryably. registerActiveTurn is only
        // reached for the exact workflow task.
        onStarted: async (started: { threadId: string; turnId: string }) => {
          if (started.threadId !== reviewerThreadId) {
            await this.ctx.turnGateway.interrupt?.(started.threadId, started.turnId).catch(() => undefined);
            throw new Error(`review/start returned task ${started.threadId}, expected the workflow task ${reviewerThreadId}; refusing to persist a second visible task`);
          }
          await this.ctx.registerActiveTurn(workflowId, started.threadId, started.turnId, "reviewer", true);
        },
        onProgress: (entry: any) => { live.onProgress(entry); child?.progress(entry); },
      }, exec.signal);
      // Second net for the same invariant: a mismatched return value is
      // rejected fail-closed — the round becomes retryable and the persisted
      // reviewerThreadId is untouched (registerActiveTurn never saw it).
      if (review.threadId !== reviewerThreadId) {
        throw new Error(`review/start returned task ${review.threadId}, expected the workflow task ${reviewerThreadId}; refusing to persist a second visible task`);
      }
      const afterReview = await this.ctx.store.load(workflowId);
      if (!afterReview || afterReview.phase === "cancelled") {
        // The review turn is no longer the active target; a later cancel must
        // never interrupt it (or the completed Planner task).
        this.ctx.runtime.activeTurns.delete(workflowId);
        return afterReview!;
      }
      current = afterReview;
      await this.ctx.reviewObservation.mark(workflowId, "review_readback", "Reading Reviewer result", null);
      // BOTH the visible review turn AND the ephemeral normalization turn must
      // have genuinely completed (`status === "completed"`, not just the
      // `completed` kind): interrupted/failed/timed-out turns carry no usable
      // text and their residual text must never be parsed or applied. The
      // failure falls back to the retryable phase without consuming a cycle.
      if (review.result.kind !== "completed" || review.result.status !== "completed") {
        if (review.result.kind !== "completed") throw new Error("review unexpectedly requested user input");
        // Keep the UPSTREAM diagnostic in the message: `reason` alone is just
        // "turn failed", which hides why the round failed (the 1.1.1 lesson).
        const detail = review.result.error ? `: ${review.result.error}` : "";
        throw new Error(`${review.result.reason ?? `review turn ${review.result.status}`}${detail}`);
      }

      // Validate the readable Markdown before structured normalization. It must
      // contain the four required sections and follow the task language. A
      // display violation gets one corrective turn on the SAME ephemeral
      // Reviewer; the corrected text becomes the input to conversion.
      if (review.result.kind !== "completed" || review.result.status !== "completed") {
        if (review.result.kind !== "completed") throw new Error("review unexpectedly requested user input");
        throw new Error(`${review.result.reason ?? `review turn ${review.result.status}`}${review.result.error ? `: ${review.result.error}` : ""}`);
      }
      let authoritativeText = review.result.text ?? "";
      visibleReviewText = authoritativeText;
      const displayError = reviewDisplayError(authoritativeText, current);
      if (displayError) {
        // An EMPTY review has nothing to re-present: a rewrite turn would have
        // to invent one (a hidden re-review), which the contract forbids — so
        // fail retryably without a rewrite turn.
        if (authoritativeText.trim().length === 0) {
          throw new Error(`review is empty`);
        }
        // Baseline BEFORE the rewrite turn, exactly like the native turn: the
        // rewrite's persisted output is detected as an APPENDED turn, never by
        // assuming the `turn/start` RPC id equals the persisted rollout id.
        const rewriteBaseline = undefined;
        await this.ctx.reviewObservation.mark(workflowId, "review_display_rewrite", "Rewriting Reviewer display output", null);
        const rewrite = await this.ctx.startTurnWithTransientRetry(reviewerThreadId, {
          prompt: reviewRewritePrompt(authoritativeText, current),
          ...(reviewerModel ? { model: reviewerModel } : {}),
          effort: "low",
          silentReview: true,
          // The rewrite turn is a VISIBLE turn on the same durable thread:
          // persist thread/turn so codex_workflow_cancel and teardown can
          // interrupt exactly this turn while it runs.
          onStarted: (started: { threadId: string; turnId: string }) => this.ctx.registerActiveTurn(workflowId, started.threadId, started.turnId, "reviewer", true),
          onProgress: live.onProgress,
        }, exec.signal);
        const afterRewrite = await this.ctx.store.load(workflowId);
        if (!afterRewrite || afterRewrite.phase === "cancelled") {
          // Never leave the completed rewrite turn as the active cancel target.
          this.ctx.runtime.activeTurns.delete(workflowId);
          return afterRewrite!;
        }
        current = afterRewrite;
        if (rewrite.kind !== "completed" || rewrite.status !== "completed") {
          if (rewrite.kind !== "completed") throw new Error("review rewrite unexpectedly requested user input");
          throw new Error(rewrite.status === "interrupted"
            ? "review rewrite turn interrupted"
            : (rewrite.reason ?? `review rewrite turn ${rewrite.status}`));
        }
        // The rewrite's AUTHORITY is its persisted history, read back exactly
        // like the native turn's — never the in-memory aggregation. A
        // missing/ambiguous read-back of the rewrite is also retryable.
        const rewrittenText = rewrite.text ?? "";
        const rewrittenError = reviewDisplayError(rewrittenText, current);
        if (rewrittenError) {
          throw new Error(`corrected review still violates the display contract: ${rewrittenError}`);
        }
        authoritativeText = rewrittenText;
        visibleReviewText = authoritativeText;
      }

      // Since 1.0.7 the visible review turn (startReview) produces a readable
      // review; the structured verdict is derived by a private conversion turn
      // (in-place for this ephemeral Reviewer), never written into Desktop
      // history. Durable compatibility callers may still use a fork; the fork
      // passes the SAME effective reviewer model (persisted override, bundle
      // config, or the resolved server default) so it never drifts to a
      // different default. The authoritative text is the rewrite turn's final
      // message when a display-rewrite ran, otherwise the native review text.
      // 1.1.2: with a CLI audit configured, the STRUCTURED CONVERSION stays on
      // the CLI. `--ephemeral` means it neither creates nor resumes a durable
      // thread, so it cannot pollute the Codex task list the way the visible
      // review turn used to. Only the visible turn moved to the App Server.
      let result: ReviewResult;
      if (this.ctx.audit) {
        result = applyReviewConsistency(await this.ctx.audit.normalize({
          visibleText: authoritativeText,
          cwd: current.cwd,
          workflowId,
          ...(reviewerModel ? { model: reviewerModel } : {}),
        }, exec.signal));
      } else {
        await this.ctx.reviewObservation.mark(workflowId, "review_conversion", "Converting Reviewer result", null);
        let normalized: TurnWaitResult;
        try {
          normalized = await this.ctx.turnGateway.normalizeInFork({
            threadId: review.threadId,
            cwd: current.cwd,
            prompt: reviewConversionPrompt(authoritativeText, workflowId),
            ...(reviewerModel ? { model: reviewerModel } : {}),
            outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
            sourceEphemeral: true,
            // The private conversion turn becomes the active reviewer turn for
            // cancellation (in-process only — its id is never persisted).
            onStarted: (started: { threadId: string; turnId: string }) => this.ctx.registerEphemeralTurn(workflowId, started.threadId, started.turnId, "reviewer"),
          }, exec.signal);
        } finally {
          this.ctx.runtime.activeTurns.delete(workflowId);
        }
        const afterNormalize = await this.ctx.store.load(workflowId);
        if (!afterNormalize || afterNormalize.phase === "cancelled") return afterNormalize!;
        current = afterNormalize;
        if (normalized.kind !== "completed") throw new Error("review normalization unexpectedly requested user input");
        if (normalized.status !== "completed") {
          throw new Error(normalized.reason ?? `review normalization turn ${normalized.status}`);
        }

        result = applyReviewConsistency(parseReview(normalized.text));
      }
      // 1.0.10 REVIEW AUTHORITY ALIGNMENT: after the visible review is
      // normalized into the public ReviewResult, an INVISIBLE ephemeral fork
      // checks every finding/test gap against the authority hierarchy
      // (reproducible critical/high defect > original task > approved plan >
      // previous applied findings > generic suggestions). A conflict does NOT
      // overwrite latestReview, does NOT consume a cycle and does NOT ask DSH
      // to fix: ONE visible reconciliation turn on the SAME durable task asks
      // the Reviewer to rewrite the verdict per the hierarchy, then the
      // corrected review is re-normalized and re-aligned. Only an aligned
      // verdict is applied (one business cycle). Two consecutive unresolved
      // conflicts block the workflow with a reportable contract failure.
      let applied: ReviewResult | undefined;
      let conflictInfo: ReviewConflictInfo | undefined;
      await this.ctx.reviewObservation.mark(workflowId, "review_alignment", "Checking Review authority alignment", null);
      const alignment = await this.ctx.alignReview(current, result, exec.signal, input);
      if (alignment.aligned) {
        applied = result;
      } else {
        await this.ctx.reviewObservation.mark(workflowId, "review_reconciliation", "Reconciling Review findings");
        const reconciled = await this.ctx.reconcileReview(current, result, alignment.conflicts, exec.signal, input);
        conflictInfo = {
          conflicts: alignment.conflicts,
          reconciled: true,
          resolved: reconciled.aligned,
          at: new Date().toISOString(),
        };
        if (reconciled.aligned) applied = reconciled.result;
      }
      if (!applied) {
        // Unresolved conflict: restore the pre-review phase (blocked after
        // two CONSECUTIVE unresolved conflicts). NO latestReview, NO cycle,
        // NO fixing prompt — the reviewer contract failed, not the code.
        this.ctx.runtime.activeTurns.delete(workflowId);
        const conflictCommit = await this.ctx.store.update(workflowId, (r) => {
          if (r.phase !== "reviewing") return;
          r.latestReviewConflict = conflictInfo;
          r.reviewContractFailures = (r.reviewContractFailures ?? 0) + 1;
          const blocked = (r.reviewContractFailures ?? 0) >= 2;
          r.phase = blocked ? "blocked" : priorPhase;
          r.error = blocked
            ? "reviewer contract failure: the review conflicts with the authority hierarchy and was not reconciled after "
              + `${r.reviewContractFailures} consecutive review calls; no code changes are required`
            : "review contract conflict: the review conflicts with the authority hierarchy and was not reconciled "
              + "after one correction attempt; no code changes are required — the next review call may retry";
          r.processState = blocked ? "completed" : "failed";
          r.activeTurnId = undefined;
          r.lastProgressAt = new Date().toISOString();
          r.lastProgressMessage = blocked ? "Review completed with a contract block" : "Review failed; retry is available";
        }, { ignoreCancelled: false });
        if (conflictCommit.suppressed) return conflictCommit.record;
        if (conflictCommit.record.phase === "blocked") {
          // A contract failure MUST be reported to the user as such — but it
          // is never a fix instruction and never re-enters the repair loop.
          exec.deferContext(pluginMessage(
            `Workflow ${workflowId} is blocked by a REVIEWER CONTRACT FAILURE: two consecutive reviews conflicted with the authority hierarchy (original task / approved plan) and the reconciliation turned could not align them. No code changes are required. Report the remaining findings and the conflict details to the user:\n${formatFindings(result)}`,
          ));
        }
        return conflictCommit.record;
      }
      // Compute the outcome inside the atomic commit so the cycle count seen by
      // the outcome policy includes this round; the message is only injected
      // after the commit confirmed we were not cancelled in the meantime.
      let outcomeMessage: string | undefined;
      await this.ctx.reviewObservation.mark(workflowId, "review_finalizing", "Finalizing Review status");
      const commit = await this.ctx.store.update(workflowId, (r) => {
        r.latestReview = applied!;
        // A cycle is consumed only now that a structured verdict is applied:
        // infrastructure failures never eat a cycle, so retries stay possible.
        r.reviewCycles += 1;
        // An aligned review ends the unresolved-conflict streak; the last
        // conflict stays visible in status (audit of the auto-correction).
        r.reviewContractFailures = 0;
        if (conflictInfo) r.latestReviewConflict = { ...conflictInfo, resolved: true };
        const outcome = this.ctx.computeReviewOutcome(r, applied!);
        outcomeMessage = outcome.message;
        r.noChangeReviewRounds = outcome.noChangeReviewRounds ?? r.noChangeReviewRounds;
        r.phase = outcome.phase;
        r.error = outcome.error;
        r.processState = "completed";
        r.activeTurnId = undefined;
        r.lastProgressAt = new Date().toISOString();
        r.lastProgressMessage = "Review completed";
        if (r.reviewStartedAt) {
          const started = Date.parse(r.reviewStartedAt);
          if (Number.isFinite(started)) r.reviewElapsedMs = Math.max(0, Date.now() - started);
        }
      }, { ignoreCancelled: false });
      if (commit.suppressed) return commit.record;
      reviewEndDetail = { verdict: applied!.verdict, result: applied!, visibleText: visibleReviewText, summary: applied!.summary };
      if (outcomeMessage) exec.deferContext(pluginMessage(outcomeMessage));
      return commit.record;
    } catch (error) {
      // A concurrent cancel wins over failure handling: never overwrite a
      // cancelled record. Otherwise an infrastructure failure (evidence/review/
      // normalize throw) returns the workflow to its RETRYABLE phase and
      // records the error — it must not burn a cycle or become failed, so the
      // same workflow can later receive its first real verdict.
      // The visible turn (review/rewrite) is no longer running or was never
      // registered: clear the in-process active-turn mapping so a later cancel
      // can never interrupt a completed turn through a stale map entry.
      this.ctx.runtime.activeTurns.delete(workflowId);
      const failed = await this.ctx.store.update(workflowId, (r) => {
        if (r.phase !== "reviewing") return;
        r.phase = priorPhase;
        r.error = this.ctx.errorMessage(error);
        r.processState = "failed";
        r.activeTurnId = undefined;
        r.lastProgressAt = new Date().toISOString();
        r.lastProgressMessage = "Review failed; retry is available";
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      reviewEndDetail = { error: this.ctx.errorMessage(error) };
      throw error;
    } finally {
      child?.finish(visibleReviewText ?? "", reviewEndDetail?.error ? "failed" : current.phase === "cancelled" ? "aborted" : "completed");
      await this.ctx.disposeChildSession(workflowId, child);
      live.close();
      const releaseNote = reviewerClaimed && reviewerThreadId
        ? await this.ctx.releaseReviewerSubscription(reviewerThreadId)
        : undefined;
      this.ctx.reportCleanupNote(workflowId, releaseNote);
      await this.ctx.reviewObservation.finish(workflowId, undefined, reviewEndDetail);
      await this.ctx.flushCleanupNotes(workflowId);
      // The pin is released LAST: the cleanup above still runs on this child.
      this.ctx.turnGateway.endRound();
    }
  }

  /**
   * 1.1.2 visibility repair, best-effort: give a LEGACY, DEDICATED Reviewer task
   * a readable title.
   *
   * A thread created by `codex exec` is stored by the App Server with
   * `source='exec'`, is never returned by `thread/list` (measured: 0 of 15 exec
   * threads listed, versus 62 of 72 App Server threads) and therefore cannot be
   * rendered in Codex Desktop — renaming cannot change that, only a newly
   * created App Server Reviewer can. This call exists purely so a human reading
   * the task store can tell what the orphan was; it must NEVER block or fail the
   * migration that replaces it. `thread/name/set` works on a thread that is not
   * loaded, so it takes no writer lock.
   *
   * The record — not a bare id — decides whether a rename is allowed at all:
   *   - an id that still ALIASES the Planner/origin task is that task's own
   *     title and must never be overwritten (the 1.1.0 alias migration never
   *     renamed it either);
   *   - an App Server Reviewer is already visible and keeps its real name.
   */

}
