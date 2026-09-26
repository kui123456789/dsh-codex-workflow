import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowStore } from "../store.js";
import type { CodexCallback, ManagerLease } from "../workflow.js";
import { CodexCallbackProcessError, CodexInvalidThreadError, CodexNoVerdictError } from "../codex-callback.js";
import { newRequestId, type SubmissionNoticeCommand, type SubmitVerdictCommand } from "../bridge-protocol.js";
import { ReviewerGateway } from "./app-server/reviewer-gateway.js";
import { ReviewObservation } from "./review-observation.js";
import type { WorkflowRuntimeState } from "./workflow-runtime-state.js";
import { transientReason } from "../transient-retry.js";
import type { ReviewConflictInfo, ReviewInput, ReviewResult, SubmissionState, WorkflowConfig, WorkflowPhase, WorkflowRecord } from "../types.js";
import { applyReviewConsistency, abortError, callbackRecoveryDelay, delay, errorMessage, submissionTerminal } from "../workflow.js";
import type { CodexReviewEndEvent } from "../review-events.js";
import type { LiveRelay } from "./live-relay.js";

type AnyFn = (...args: any[]) => any;

export interface SubmissionExecutionContext {
  store: WorkflowStore;
  config: WorkflowConfig;
  runtime: WorkflowRuntimeState;
  callback?: CodexCallback;
  bridgeQueue?: { enqueue(command: any): Promise<string> };
  reviewerGateway: ReviewerGateway;
  reviewObservation: ReviewObservation;
  leaseTtlMs: number;
  boundedCleanup: AnyFn;
  enqueueStagedVerdict: AnyFn;
  enqueueSubmissionNotice: AnyFn;
  stageSubmissionFailure: AnyFn;
  reportCleanupNote: AnyFn;
  flushCleanupNotes: AnyFn;
  alignReview: AnyFn;
  reconcileReview: AnyFn;
  errorMessage: (error: unknown) => string;
  createLiveRelay(record: WorkflowRecord, stage: "reviewing", reviewId: string): LiveRelay;
  disposeChildSession(workflowId: string, child: import("../codex-child-session.js").CodexChildSessionHandle | undefined): Promise<void>;
}

/** Owns one durable bridge callback state machine, including lease fencing,
 * authority alignment and exact staged-verdict delivery. */
export class SubmissionExecution {
  constructor(private readonly ctx: SubmissionExecutionContext) {}
  async run(
    workflowId: string,
    submissionId: string,
    prompt: string,
    seed: WorkflowRecord,
    signal?: AbortSignal,
    lease?: ManagerLease,
  ): Promise<WorkflowRecord> {
    let current = seed;
    const child = this.ctx.runtime.codexChildSessions.get(workflowId);
    const liveRecord = await this.ctx.store.load(workflowId) ?? seed;
    const live = this.ctx.createLiveRelay(liveRecord, "reviewing", `${workflowId}:${liveRecord.reviewAttempt ?? 1}`);
    const roundStartAttempt = current.submissionAttempts ?? 0;
    let leaseLost = false;
    let reviewEndDetail: Pick<CodexReviewEndEvent, "verdict" | "result" | "visibleText" | "summary" | "error"> | undefined;
    // Every state write must stay fenced to THIS lease (submissionId + token +
    // epoch): a stale owner can never rewrite a submission the lease moved on.
    const isCurrent = (record: WorkflowRecord) =>
      record.submissionId === submissionId
      && !submissionTerminal(record.submissionState)
      && (!lease || (record.submissionLeaseToken === lease.owner && record.submissionLeaseEpoch === lease.epoch));
    const updateCurrent = async (fn: (record: WorkflowRecord) => void): Promise<WorkflowRecord> => {
      const outcome = await this.ctx.store.update(workflowId, (r) => {
        if (!isCurrent(r)) return;
        fn(r);
      }, { ignoreCancelled: false });
      current = outcome.record;
      return current;
    };
    lease?.heartbeat(this.ctx.leaseTtlMs / 3, () => {
      // We lost the lease (renew changed 0 rows): another process owns the
      // callback now. Kill our child and stop writing state — the stale
      // callback must never enqueue a verdict or regress the new owner's
      // received/applied/delivered back to sending/retrying/failed.
      leaseLost = true;
      this.ctx.callback?.cancelSubmission(workflowId, submissionId);
    });
    try {
      for (let attempt = (current.submissionAttempts ?? 0) + 1; ; attempt += 1) {
        if (this.ctx.runtime.stopped || signal?.aborted || leaseLost) return current;
        const sending = await updateCurrent((r) => {
          r.submissionState = "sending";
          r.submissionAttempts = attempt;
          r.submissionRetryAt = undefined;
        });
        if (sending.submissionId !== submissionId || submissionTerminal(sending.submissionState)) {
          return sending; // cancelled or re-claimed by another restarter
        }
        await this.ctx.reviewObservation.mark(workflowId, "review_native_turn", "Running Reviewer turn");
        let outcome:
          | { kind: "verdict"; verdict: ReviewResult }
          | { kind: "retryable_busy"; reason?: string };
        try {
          // 1.1.0: only the workflow's OWN dedicated Reviewer task is ever
          // released. The Planner/origin task is not a review target any more
          // (an external writer holding it must never block a review), and a
          // legacy shared alias is not resumed at all — the dispatcher binds a
          // dedicated Reviewer instead.
          // 1.1.2: only an App Server-created Reviewer can be rendered in Codex
          // Desktop. A legacy CLI-created task (`source='exec'`) is handed over
          // as UNBOUND so the dispatcher creates a visible replacement; the old
          // task is left intact and merely renamed for humans.
          // New callback rounds always create an ephemeral Reviewer. Legacy
          // durable bindings remain diagnostic state and are never resumed or
          // handed off to an external Desktop writer.
          const boundReviewer: undefined = undefined;
          if (boundReviewer) {
            // 1.1.4: signal-free but BOUNDED — a handoff that never settles must
            // not wedge the round (or cancel/teardown) either.
           const handoffNote = await this.ctx.boundedCleanup("external handoff", () => (
              this.ctx.reviewerGateway.externalRelease(boundReviewer)
                ?? this.ctx.reviewerGateway.unsubscribe(boundReviewer)
            ));
            this.ctx.reportCleanupNote(workflowId, handoffNote);
          }
          outcome = await this.ctx.callback!.send({
            workflowId,
            submissionId,
            codexThreadId: current.codexThreadId!,
            cwd: current.cwd,
            prompt,
            // The original task/plan context lets the background dispatcher
            // enforce the SAME visible-review display contract as the
            // DSH-led path (task language + four readable sections).
            task: current.task,
            ...(current.planMarkdown ? { planMarkdown: current.planMarkdown } : {}),
            // A legacy shared alias is handed over as UNBOUND so the
            // dispatcher creates the dedicated Reviewer instead of resuming
            // the Planner/origin task.
            reviewerThreadId: boundReviewer,
            reviewerName: `DSH Reviewer: ${workflowId}`,
            ephemeral: true,
            ...(current.reviewerModel || this.ctx.config.reviewerModel
              ? { model: current.reviewerModel || this.ctx.config.reviewerModel }
              : {}),
            effort: current.reviewerEffort ?? this.ctx.config.reviewerEffort,
            onThread: async (threadId) => {
              const registered = await updateCurrent((r) => {
                // Ephemeral Reviewer ids are process-local and must never be
                // persisted as Desktop-visible durable bindings.
                r.reviewerThreadOrigin = "app-server-ephemeral";
              });
              void threadId;
              if (registered.submissionId !== submissionId) throw new Error("submission no longer owns the reviewer thread");
            },
            onStarted: async ({ threadId, turnId }) => {
              const registered = await updateCurrent((r) => {
                r.reviewerTurnId = turnId;
                r.activeTurnId = turnId;
                r.lastProgressAt = new Date().toISOString();
                r.lastProgressMessage = "Reviewer turn is running";
              });
              if (registered.submissionId !== submissionId || registered.reviewerTurnId !== turnId) {
                throw new Error("submission no longer owns the active reviewer turn");
              }
            },
            onProgress: (entry: any) => { live.onProgress(entry); child?.progress(entry); },
          }, signal);
        } catch (error) {
          if (leaseLost) return current; // we were taken over mid-flight: write nothing
          if (
            error instanceof CodexInvalidThreadError
            || error instanceof CodexNoVerdictError
            || error instanceof CodexCallbackProcessError
          ) {
            const failed = await this.ctx.stageSubmissionFailure(updateCurrent, workflowId, submissionId, error.message);
            await this.ctx.enqueueSubmissionNotice(workflowId, submissionId, failed, signal);
            return current;
          }
          if (signal?.aborted || this.ctx.runtime.stopped) {
            // A cancelled/teardown abort must never leave the submission stuck
            // at `sending` with no backoff: persist a recoverable `retrying`
            // state (skip only during teardown, when the store is closing — a
            // restart reclaims the recoverable `sending` record anyway).
            if (!this.ctx.runtime.stopped && !leaseLost) {
              await updateCurrent((r) => {
                r.submissionState = "retrying";
                r.submissionError = "interrupted: callback aborted before a verdict";
                r.submissionCallbackReason = "callback aborted (cancel/restart)";
                r.submissionRetryAt = Date.now() + this.ctx.config.callbackRetryBaseMs;
                r.callbackState = "retrying";
              }).catch(() => undefined);
            }
            throw error;
          }
          const message = this.ctx.errorMessage(error);
          // 1.1.1: the SHARED transient classification (server_overloaded /
          // at capacity / 429 / 5xx / dropped streams / writer held elsewhere)
          // so a temporary capacity problem can never be filed as an unknown,
          // terminal-looking callback failure.
          const busyReason = /Codex turn timed out|timed out/i.test(message)
            ? "turn timeout"
            : transientReason(message) ?? "unknown callback failure";
          outcome = { kind: "retryable_busy", reason: busyReason };
        }
        if (leaseLost) return current; // never write or enqueue after losing the lease
        // 1.0.10 authority outcome of this review call, shared by the conflict
        // refusal and the staging pipeline below. An unresolved conflict
        // restores the PRE-REVIEW phase (executing/fixing as the workflow was
        // when this submission started).
        const priorPhase: WorkflowPhase = current.phase === "fixing" ? "fixing" : "executing";
        let contractConflict: ReviewConflictInfo | undefined;
        if (outcome.kind === "verdict") {
          reviewEndDetail = { verdict: outcome.verdict.verdict, result: outcome.verdict, summary: outcome.verdict.summary };
          // 1.0.10 REVIEW AUTHORITY ALIGNMENT on the bridge path: the verdict
          // must align with the authority hierarchy before it may be staged.
          // One invisible alignment fork checks the result; on conflict the
          // SAME visible task gets ONE reconciliation turn and the corrected
          // verdict is re-normalized and re-aligned. An unresolved conflict
          // NEVER stages/applies (no latestReview, no cycle, no fix prompt);
          // two CONSECUTIVE unresolved conflicts block the workflow. An
          // authority-machinery failure (fork/turn/timeout) keeps the
          // submission RETRYABLE like any normalization failure.
          let verdict = applyReviewConsistency(outcome.verdict);
          let contractFailed = false;
          try {
        await this.ctx.reviewObservation.mark(workflowId, "review_alignment", "Checking Review authority alignment", null);
            // The alignment prompt receives the PREVIOUSLY APPLIED review and
            // THIS submission's fix summary (both persisted on the record), so
            // a legitimately carried-forward finding is never misjudged as a
            // generic conflict.
            const alignment = await this.ctx.alignReview(current, verdict, signal, current.pendingReviewRequest);
            if (!alignment.aligned) {
              await this.ctx.reviewObservation.mark(workflowId, "review_reconciliation", "Reconciling Review findings", null);
              const reconciled = await this.ctx.reconcileReview(current, verdict, alignment.conflicts, signal, current.pendingReviewRequest);
              contractConflict = {
                conflicts: alignment.conflicts,
                reconciled: true,
                resolved: reconciled.aligned,
                at: new Date().toISOString(),
              };
              if (reconciled.aligned) {
                verdict = reconciled.result;
              } else {
                contractFailed = true;
              }
            }
          } catch (error) {
            if (leaseLost) return current;
            if (signal?.aborted || this.ctx.runtime.stopped) throw error;
            // The authority machinery itself failed (fork/turn/parse/invalid
            // semantics/preservation): retryable infrastructure, never a
            // verdict, never a consumed cycle. The concrete reason is kept so
            // a stuck submission is diagnosable.
            outcome = { kind: "retryable_busy", reason: `review authority alignment failed: ${this.ctx.errorMessage(error)}` };
          }
          if (outcome.kind === "retryable_busy") {
            // fall through to the shared busy handling below (marks retrying).
          } else if (contractFailed) {
            const failures = (current.reviewContractFailures ?? 0) + 1;
            const blocked = failures >= 2;
            const conflicted = await updateCurrent((r) => {
              if (r.submissionId !== submissionId || submissionTerminal(r.submissionState)) return;
              r.latestReviewConflict = contractConflict;
              r.reviewContractFailures = failures;
              r.submissionState = "failed";
              r.submissionError = "reviewer contract conflict: the review conflicts with the authority hierarchy and was not reconciled after one correction attempt; no code changes are required";
              r.callbackState = "failed";
              if (blocked) {
                r.phase = "blocked";
                r.error = `reviewer contract failure: the review conflicts with the authority hierarchy and was not reconciled after ${failures} consecutive review calls; no code changes are required`;
              } else {
                r.phase = priorPhase;
                r.error = "review contract conflict: the review conflicts with the authority hierarchy and was not reconciled; no code changes are required — the next submission may retry";
              }
              if (!r.submissionNotice || r.submissionNotice.command.submissionId !== submissionId) {
                const command: SubmissionNoticeCommand = {
                  version: 1,
                  kind: "submission_notice",
                  requestId: newRequestId(),
                  createdAt: new Date().toISOString(),
                  workflowId,
                  submissionId,
                  codexThreadId: r.codexThreadId!,
                  dshSessionId: r.dshSessionId,
                  level: "error",
                  message: blocked
                    ? `Codex Reviewer 契约故障：审查意见与权威层级（原始任务/批准计划）冲突且连续 ${failures} 次审查未能在一次纠正中对齐；无需修改代码。`
                    : `Codex Reviewer 审查意见与权威层级（原始任务/批准计划）冲突且一次纠正未对齐；无需修改代码，可以再次提交审查。`,
                };
                r.submissionNotice = { command, state: "prepared" };
              }
            });
            if (conflicted.submissionId !== submissionId) return conflicted;
            // Delivery of the contract-failure diagnostic (never a fix prompt).
            await this.ctx.enqueueSubmissionNotice(workflowId, submissionId, conflicted, signal)
              .catch(() => undefined);
            return conflicted;
          } else {
            // The authority validated the verdict (or the reconciliation
            // corrected it): hand the aligned verdict to the staging pipeline.
            outcome = { kind: "verdict", verdict };
          }
        }
        if (outcome.kind === "verdict") {
          await this.ctx.reviewObservation.mark(workflowId, "review_finalizing", "Finalizing Review status", null);
          if (!this.ctx.bridgeQueue) {
            const committed = await updateCurrent((r) => {
              r.submissionState = "waiting_verdict";
              r.submissionError = undefined;
              r.callbackState = "waiting_verdict";
            });
            return committed;
          }
          // Phase A: persist the FULL verdict command BEFORE touching the queue.
          // requestId and createdAt are minted exactly once, here; recovery
          // re-enqueues this exact command so requestId+createdAt+commandHash
          // are identical every time.
          let stagedRequestId: string | undefined;
          const staged = await updateCurrent((r) => {
            stagedRequestId = newRequestId();
            const command: SubmitVerdictCommand = {
              version: 1,
              kind: "submit_verdict",
              requestId: stagedRequestId,
              createdAt: new Date().toISOString(),
              workflowId,
              codexThreadId: r.codexThreadId ?? current.codexThreadId!,
              submissionId,
              // Route the verdict to the runtime owning the workflow session.
              dshSessionId: r.dshSessionId,
              verdict: outcome.verdict,
            };
            r.submissionState = "verdict_ready";
            r.stagedVerdict = { command, createdAt: command.createdAt };
            r.submissionError = undefined;
            r.submissionRetryAt = undefined;
            // 1.0.10: a reconciliation-corrected verdict records the
            // auto-correction on the durable record (status surface), and an
            // ALIGNED verdict (with or without reconciliation) ends the
            // unresolved-conflict streak — a later NON-consecutive conflict
            // must never accumulate towards the two-strike block.
            if (contractConflict) r.latestReviewConflict = contractConflict;
            r.reviewContractFailures = 0;
          });
          if (staged.submissionId !== submissionId || submissionTerminal(staged.submissionState)) return staged;
          // Phase B: idempotent enqueue of the exact staged command.
          const enqueued = await this.ctx.enqueueStagedVerdict(workflowId, submissionId, staged, signal);
          if (enqueued !== "committed") return enqueued;
          // Phase C: mark received; the staged identity is KEPT until applied
          // so a conflicting manual verdict can never jump ahead of it. A
          // verdict already applied by the queue pump in the meantime is
          // terminal and wins.
          const received = await updateCurrent((r) => {
            if (r.stagedVerdict?.command.requestId !== stagedRequestId) return;
            r.submissionState = "received";
            r.callbackState = "idle";
          });
          return received;
        }
        const busy = await updateCurrent((r) => {
          r.submissionState = "retrying";
          r.submissionError = `codex thread busy or rate limited${outcome.reason ? ` (${outcome.reason})` : ""}`;
          r.submissionCallbackReason = outcome.reason ?? "busy";
          r.callbackState = "retrying";
        });
        if (busy.submissionId !== submissionId || submissionTerminal(busy.submissionState)) return busy;
        const attemptsThisRound = attempt - roundStartAttempt;
        if (attemptsThisRound >= this.ctx.config.callbackMaxAttempts) {
          const retryDelayMs = callbackRecoveryDelay(this.ctx.config.callbackRetryBaseMs, attemptsThisRound);
          await updateCurrent((r) => {
            r.submissionState = "retrying";
            r.submissionError = `codex thread busy after ${attemptsThisRound} attempts in this round (${outcome.reason ?? "busy"}); recovery will retry`;
            r.submissionCallbackReason = outcome.reason ?? "busy";
            r.submissionRetryAt = Date.now() + retryDelayMs;
            r.callbackState = "retrying";
          });
          return current;
        }
        // The bridge submission cadence stays governed by `callbackRetryBaseMs`
        // (the recovery loop's own knob); the 1.1.1 transient policy governs the
        // MODEL calls (CLI audit + visible turns), not this queue cadence.
        await delay(this.ctx.config.callbackRetryBaseMs * 2 ** (attemptsThisRound - 1), signal);
        if (signal?.aborted) throw abortError(signal);
      }
    } catch (error) {
      if (signal?.aborted || this.ctx.runtime.stopped) throw error;
      const failed = await this.ctx.stageSubmissionFailure(updateCurrent, workflowId, submissionId, this.ctx.errorMessage(error));
      await this.ctx.enqueueSubmissionNotice(workflowId, submissionId, failed, signal);
      return current;
    } finally {
      child?.finish(reviewEndDetail?.visibleText ?? "", reviewEndDetail?.error ? "failed" : "completed");
      await this.ctx.disposeChildSession(workflowId, child);
      live.close();
      lease?.stopHeartbeat();
      await this.ctx.reviewObservation.finish(workflowId, undefined, reviewEndDetail);
      await this.ctx.flushCleanupNotes(workflowId);
    }
  }


}
