import { collectEvidence, isGitRepository, type EvidenceOptions } from "../evidence.js";
import { reviewDisplayError, reviewRewritePrompt } from "../review-contract.js";
import { REVIEW_OUTPUT_SCHEMA } from "../schemas.js";
import type { WorkflowStore } from "../store.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexCliAuditGateway } from "../codex-cli-audit.js";
import { ReviewObservation } from "./review-observation.js";
import { TurnGateway } from "./app-server/turn-gateway.js";
import { applyReviewConsistency, formatFindings, parseReview, pluginMessage, reviewConversionPrompt, reviewContractInstructions, reviewInstructions } from "../workflow.js";
import type { AlignmentOutcome, ProcessInstanceIdentity, ReviewConflictInfo, ReviewEvidence, ReviewInput, ReviewResult, TurnWaitResult, WorkflowConfig, WorkflowPhase, WorkflowRecord, WorkflowRetryState } from "../types.js";
import { originalProcessTreeExited } from "../infrastructure/process-transport.js";
import type { WorkflowRuntimeState } from "./workflow-runtime-state.js";
import type { CodexReviewEndEvent } from "../review-events.js";
import type { LiveRelay } from "./live-relay.js";
import type { CodexChildSessionHandle } from "../codex-child-session.js";
import { isRecoverableModelFailure } from "../transient-retry.js";
import { CodexTurnInterruptionError } from "../turn-interruption.js";
import { CodexTurnReceiptPendingError } from "../pending-turn-receipt.js";
import type { RecoverableWorkflowRun, RetainedAuxiliaryTurn, ReviewerRunSettings } from "./workflow-runtime-state.js";
import { assertReviewerRecovery, assertReviewerRunIdentity, reviewerRunIdentity, type ReviewerRunIdentity } from "./reviewer-run-identity.js";
import { assertForegroundReviewCheckpoint, captureForegroundReviewCheckpoint, foregroundReviewCheckpointScope, ForegroundReviewStageError,
  ForegroundReviewEvidenceUnavailableError, TypedForegroundReviewEvidenceChangedError,
  type ForegroundReconciliationCheckpoint, type ForegroundReviewCheckpoint } from "./foreground-review-checkpoint.js";

type AnyFn = (...args: any[]) => any;

export interface ReviewExecutionContext {
  store: WorkflowStore;
  config: WorkflowConfig;
  runtime: WorkflowRuntimeState;
  reviewObservation: ReviewObservation;
  turnGateway: TurnGateway;
  audit?: CodexCliAuditGateway;
  trackNoChange: AnyFn;
  readFinalEvidence(options: EvidenceOptions): Promise<ReviewEvidence>;
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
  createChildSession(record: WorkflowRecord, exec: ToolRunContext, label: string,
    assertAdoption?: () => Promise<void>): Promise<CodexChildSessionHandle | undefined>;
  disposeChildSession(workflowId: string, child: CodexChildSessionHandle | undefined): Promise<void>;
  captureThreadOwner?(threadId: string): object | undefined;
  getRecoverableRun(workflowId: string): RecoverableWorkflowRun | undefined;
  setRecoverableRun(workflowId: string, run: RecoverableWorkflowRun): void;
  clearRecoverableRun(workflowId: string): void;
  interruptReviewerTurn(threadId: string, turnId: string, expectedOwner?: object): Promise<boolean>;
  confirmReviewerTerminalCleanup?(workflowId: string, run: RecoverableWorkflowRun): Promise<boolean>;
  isTerminalCleanupConfirmed?(record: WorkflowRecord): boolean;
  confirmAuxiliaryTurns(workflowId: string, expectedPair?: { threadId: string; turnId: string }, expectedOwner?: RetainedAuxiliaryTurn): Promise<boolean>;
  isStopping(): boolean;
  owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord>;
}

/** Owns the durable DSH-led review state machine. The manager remains a
 * compatibility facade and supplies narrow lifecycle/cancellation callbacks. */
export class ReviewExecution {
  constructor(private readonly ctx: ReviewExecutionContext) {}

  private originalThreadAvailable(threadId: string, owner?: object): boolean {
    if (this.ctx.captureThreadOwner && !owner) return false;
    return this.ctx.turnGateway.isThreadAvailable(threadId, owner);
  }

  /** Explicit review may start a new business round after the original waiting
   * scope changed, or when a separate round is requested. Resume keeps its scope. */
  async prepareNewReviewAfterWorkspaceChange(workflowId: string, exec: ToolRunContext, newReviewRound = false): Promise<WorkflowRecord | undefined> {
    const record = await this.ctx.owned(workflowId, exec);
    if (record.phase === "cancelled") return record;
    const recovery = this.ctx.getRecoverableRun(workflowId);
    if (record.retryState?.awaitingStartReceipt || recovery?.pendingStart) {
      throw new Error("Original Reviewer start receipt is pending; no new review round will be started");
    }
    const terminalCleanupConfirmed = Boolean(record.retryState?.awaitingCleanup && this.ctx.isTerminalCleanupConfirmed?.(record));
    if (recovery?.terminalFailure || (record.retryState?.awaitingCleanup && !terminalCleanupConfirmed)) {
      throw new Error("Original Reviewer terminal cleanup is pending; resume must confirm its original turn before any new review round");
    }
    const waiting = record.processState === "waiting" && record.retryState?.stage === "reviewing"
      && record.retryState.awaitingContinuation;
    const terminal = record.processState === "failed"
      && ["original_reviewer_unavailable", "review_contract_conflict"].includes(record.reviewFailureReason ?? "");
    if ((!waiting && !terminal) || !["executing", "fixing"].includes(record.phase)) return;
    // A current stored scope authorizes a new business review; it never stands
    // in for the original process-local identity or continuation handle.
    const snapshot = (value: WorkflowRecord) => JSON.stringify({ id: value.id, dshSessionId: value.dshSessionId,
      cwd: value.cwd, task: value.task, createdAt: value.createdAt, mode: value.mode, planMarkdown: value.planMarkdown,
      reviewerModel: value.reviewerModel, reviewerEffort: value.reviewerEffort, reviewAttempt: value.reviewAttempt,
      reviewCycles: value.reviewCycles, phase: value.phase, processState: value.processState, retryState: value.retryState,
      reviewFailureReason: value.reviewFailureReason, latestReview: value.latestReview,
      reviewContractFailures: value.reviewContractFailures, latestReviewConflict: value.latestReviewConflict,
      evidence: value.latestReviewEvidence && { kind: value.latestReviewEvidence.kind,
        fingerprint: value.latestReviewEvidence.fingerprint, changedFiles: value.latestReviewEvidence.changedFiles,
        insufficient: value.latestReviewEvidence.insufficient } });
    const originalScope = snapshot(record);
    const assertPreparation = (current: WorkflowRecord) => {
      exec.signal.throwIfAborted();
      if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
      if (this.ctx.runtime.resumeFlights.has(workflowId)) throw new Error(`workflow ${workflowId} is already continuing its original Reviewer; recovery owner is running`);
      if (this.ctx.getRecoverableRun(workflowId) !== recovery) {
        throw new Error(`workflow ${workflowId} changed its recovery owner while preparing a new review`);
      }
      if (snapshot(current) !== originalScope) throw new Error(`workflow ${workflowId} changed its approved review scope or waiting evidence`);
      if (recovery) assertReviewerRecovery(recovery.reviewerIdentity!, current);
      else if (this.ctx.runtime.activeTurns.has(workflowId) || this.ctx.runtime.codexChildSessions.has(workflowId)
        || [...this.ctx.runtime.auxiliaryTurns.values()].some((turn) => turn.workflowId === workflowId)) {
        throw new Error(`workflow ${workflowId} has residual original review resources; no replacement will be started`);
      }
    };
    if (recovery) {
      if (!recovery.reviewerIdentity) throw new Error("original Reviewer identity is unavailable; no replacement will be started");
      if (!recovery.reviewerSettings) throw new Error("original Reviewer settings are unavailable; no replacement will be started");
      if (recovery.state.stage !== "reviewing" || !recovery.input || !recovery.evidence?.fingerprint || recovery.evidence.insufficient) {
        throw new Error(`workflow ${workflowId} has a waiting Reviewer with different input or incomplete original evidence; no replacement will be started`);
      }
      assertReviewerRecovery(recovery.reviewerIdentity, record);
    }
    assertPreparation(record);
    let latest = record;
    if (!recovery?.interruptionTurnId && !recovery?.auxiliaryInterruption && record.retryState?.interruption
      && !terminalCleanupConfirmed) {
      const exited = await originalProcessTreeExited(record.retryState.interruption);
      latest = await this.ctx.owned(workflowId, exec);
      if (latest.phase === "cancelled") return latest;
      assertPreparation(latest);
      if (!exited) throw new Error("Original Reviewer interruption is unconfirmed or its process is unknown; no new review round was started");
    }
    const baseline = recovery?.evidence ?? record.latestReviewEvidence;
    if (!newReviewRound) {
      if (!baseline?.fingerprint || baseline.insufficient || !Array.isArray(baseline.changedFiles)) return;
      const currentEvidence = await collectEvidence({ cwd: record.cwd, maxDiffBytes: this.ctx.config.reviewDiffMaxBytes,
        changedFiles: recovery ? recovery.input!.changedFiles : baseline.changedFiles });
      latest = await this.ctx.owned(workflowId, exec);
      if (latest.phase === "cancelled") return latest;
      assertPreparation(latest);
      if (currentEvidence.insufficient || !currentEvidence.fingerprint || currentEvidence.kind !== baseline.kind) {
        throw new Error("review evidence is unavailable; the original waiting review was retained");
      }
      if (currentEvidence.fingerprint === baseline.fingerprint) return;
    }
    if (recovery?.interruptionTurnId) {
      const interruptionTurnId = recovery.interruptionTurnId;
      if (!this.originalThreadAvailable(recovery.threadId, recovery.threadOwner)) {
        const exited = await originalProcessTreeExited(record.retryState?.interruption ?? {});
        latest = await this.ctx.owned(workflowId, exec);
        if (latest.phase === "cancelled") return latest;
        assertPreparation(latest);
        if (recovery.interruptionTurnId !== interruptionTurnId) throw new Error("original Reviewer interruption owner changed during cleanup");
        if (!exited) {
          throw new Error("Original Reviewer interruption is unconfirmed; its process exit has not been confirmed");
        }
      } else {
        const confirmed = await this.ctx.interruptReviewerTurn(recovery.threadId, interruptionTurnId, recovery.threadOwner);
        latest = await this.ctx.owned(workflowId, exec);
        if (latest.phase === "cancelled") return latest;
        assertPreparation(latest);
        if (recovery.interruptionTurnId !== interruptionTurnId) throw new Error("original Reviewer interruption owner changed during cleanup");
        if (!confirmed) throw new Error("Original Reviewer interruption is unconfirmed; no new review round was started");
      }
    }
    if (recovery && !await this.ctx.confirmAuxiliaryTurns(workflowId, recovery.auxiliaryInterruption, recovery.auxiliaryInterruptionOwner)) {
      throw new Error("Original private Reviewer interruption is unconfirmed; no new review round was started");
    }
    latest = await this.ctx.owned(workflowId, exec);
    assertPreparation(latest);
    // Claim before any further await. Lifecycle owns waiting map entries;
    // this admitted execution now owns the old subscription and its pin.
    if (recovery) this.ctx.clearRecoverableRun(workflowId);
    let preparedRecord: WorkflowRecord;
    try {
      const prepared = await this.ctx.store.update(workflowId, (current) => {
        exec.signal.throwIfAborted();
        if (snapshot(current) !== originalScope) throw new Error(`workflow ${workflowId} changed its approved review scope before new round preparation`);
        if (recovery) assertReviewerRecovery(recovery.reviewerIdentity!, current);
        if (current.dshSessionId !== latest.dshSessionId) throw new Error("workflow belongs to another DSH session");
        exec.signal.throwIfAborted();
        if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
        const stillWaiting = current.processState === "waiting" && current.retryState?.stage === "reviewing"
          && current.retryState.awaitingContinuation;
        const stillTerminal = current.processState === "failed"
          && ["original_reviewer_unavailable", "review_contract_conflict"].includes(current.reviewFailureReason ?? "");
        if ((!stillWaiting && !stillTerminal) || (current.phase !== "executing" && current.phase !== "fixing")) {
          throw new Error(`workflow ${workflowId} is no longer waiting for its original Reviewer`);
        }
        current.retryState = undefined;
        current.reviewFailureReason = undefined;
        current.error = undefined;
        current.processState = undefined;
        current.activeTurnId = undefined;
        current.lastProgressAt = new Date().toISOString();
        current.lastProgressMessage = newReviewRound ? "Explicit independent review round requested"
          : "Workspace changed; a new explicit review round can start";
      }, { ignoreCancelled: false });
      if (prepared.record.dshSessionId !== latest.dshSessionId) throw new Error("workflow belongs to another DSH session");
      preparedRecord = prepared.record;
    } finally {
      if (recovery) {
        try {
          if (recovery.child && !this.ctx.runtime.disposingChildren.has(recovery.child)) {
            try { recovery.child.finish(newReviewRound
              ? "Explicit independent review requested; the previous round ended before a new business review."
              : "Workspace changed; the previous review ended before a new business review.", "aborted"); }
            catch { /* The child display cannot strand backend ownership. */ }
          }
          await this.ctx.disposeChildSession(workflowId, recovery.child);
        } catch { this.ctx.reportCleanupNote(workflowId, "Previous Reviewer child cleanup failed (best-effort)"); }
        finally {
          try { this.ctx.reportCleanupNote(workflowId, await this.ctx.releaseReviewerSubscription(recovery.threadId, recovery.threadOwner)); }
          catch { this.ctx.reportCleanupNote(workflowId, "Previous Reviewer subscription cleanup failed (best-effort)"); }
          finally { this.ctx.turnGateway.endRound(); }
        }
      }
    }
    const afterCleanup = await this.ctx.owned(workflowId, exec);
    if (afterCleanup.phase === "cancelled") return afterCleanup;
    exec.signal.throwIfAborted();
    if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
    if (snapshot(afterCleanup) !== snapshot(preparedRecord)) throw new Error(`workflow ${workflowId} changed its approved review scope during old review cleanup`);
    return afterCleanup;
  }

  async run(
    workflowId: string,
    input: ReviewInput,
    exec: ToolRunContext,
    existing?: RecoverableWorkflowRun,
    instruction?: string,
    expectedScope?: WorkflowRecord | ReviewerRunIdentity,
  ): Promise<WorkflowRecord> {
    const releaseBeforeRun = async () => {
      if (!existing) return;
      if (existing.pendingStart && (this.ctx.getRecoverableRun(workflowId) === existing || existing.receiptCleanupClaimed)) return;
      try {
        await this.ctx.disposeChildSession(workflowId, existing.child);
      } finally {
        try { await this.ctx.releaseReviewerSubscription(existing.threadId, existing.threadOwner); }
        finally { this.ctx.turnGateway.endRound(); }
      }
    };
    const restoreBeforeRun = (record?: WorkflowRecord) => {
      if (!existing || this.ctx.isStopping() || record?.phase === "cancelled"
        || (existing.child && this.ctx.runtime.disposingChildren.has(existing.child))
        || !this.originalThreadAvailable(existing.threadId, existing.threadOwner) || this.ctx.getRecoverableRun(workflowId)) return false;
      this.ctx.setRecoverableRun(workflowId, existing);
      return true;
    };
    const pre = await this.ctx.owned(workflowId, exec).catch(async (error) => {
      const latest = await this.ctx.store.load(workflowId).catch(() => undefined);
      if (!restoreBeforeRun(latest)) await releaseBeforeRun();
      throw error;
    });
    const priorPhase: WorkflowPhase = pre.phase === "fixing" ? "fixing" : "executing";
    let checkpoint: ForegroundReviewCheckpoint | undefined = existing?.reviewCheckpoint;
    let pendingStart = existing?.pendingStart;
    let automaticContinuations: 0 | 1 = existing?.automaticContinuations ?? checkpoint?.automaticContinuations ?? 0;
    const scope = expectedScope ?? pre;
    const recordScope = "schemaVersion" in scope ? scope as WorkflowRecord : undefined;
    const ownsScope = (record: WorkflowRecord) => record.id === scope.id && record.dshSessionId === scope.dshSessionId
      && record.cwd === scope.cwd && record.task === scope.task && record.createdAt === scope.createdAt && record.mode === scope.mode
      && record.reviewerModel === scope.reviewerModel && record.reviewerEffort === scope.reviewerEffort
      && (!recordScope || record.planMarkdown === recordScope.planMarkdown)
      && (!checkpoint || foregroundReviewCheckpointScope(record) === checkpoint.scope);
    try {
      if (!ownsScope(pre) || (expectedScope && (pre.reviewAttempt ?? 0) !== (expectedScope.reviewAttempt ?? 0))) {
        throw new Error(`workflow ${workflowId} changed its original review scope or attempt`);
      }
      if (existing && pre.phase !== "cancelled") {
        if (!existing.reviewerIdentity) throw new Error("original Reviewer identity is unavailable; no replacement will be started");
        if (!existing.reviewerSettings) throw new Error("original Reviewer settings are unavailable; no replacement will be started");
        assertReviewerRecovery(existing.reviewerIdentity, pre);
        if (existing.reviewCheckpoint) assertForegroundReviewCheckpoint(existing.reviewCheckpoint, pre, existing);
      }
    } catch (error) {
      if (!restoreBeforeRun(pre)) await releaseBeforeRun();
      throw error;
    }
    let expectedPhase = pre.phase;
    let expectedAttempt = pre.reviewAttempt;
    const startupGuard = (record: WorkflowRecord) => {
      exec.signal.throwIfAborted();
      if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
      if (existing && !observationStarted) assertReviewerRecovery(existing.reviewerIdentity!, record);
      return ownsScope(record) && record.phase === expectedPhase && record.reviewAttempt === expectedAttempt;
    };
    const assertAdoption = async () => {
      const latest = await this.ctx.store.load(workflowId);
      if (!latest || !startupGuard(latest)) throw new Error(`workflow ${workflowId} changed its review startup owner or attempt`);
    };
    let child = existing?.child;
    let entering;
    let reviewHeartbeat: NodeJS.Timeout | undefined;
    let observationStarted = false;
    let retainStartupForContinuation = false;
    let startupLatest: WorkflowRecord | undefined;
    try {
      await assertAdoption();
      child ??= await this.ctx.createChildSession(pre, exec, `Codex Reviewer · ${workflowId}`, assertAdoption);
      await assertAdoption();
      entering = await this.ctx.reviewObservation.begin(workflowId, {
        enterReviewing: true,
        step: "reviewing",
        message: "Review started; collecting workspace evidence",
        childSessionId: child?.id,
        guard: (record) => {
          if (!startupGuard(record)) return false;
          observationStarted = true;
          return true;
        },
      });
      expectedPhase = "reviewing";
      expectedAttempt = entering.record.reviewAttempt;
      if (!entering.suppressed) reviewHeartbeat = this.ctx.reviewObservation.startHeartbeat(workflowId, startupGuard);
    } catch (error) {
      // No model has started. Keep the owned durable workflow addressable,
      // without advertising a thread that does not exist or spending a cycle.
      try {
        const latest = await this.ctx.store.load(workflowId);
        startupLatest = latest;
        if (!latest || !ownsScope(latest)) throw error;
        if (latest.phase === "cancelled") return latest;
        const ownsStartup = (record: WorkflowRecord) => ownsScope(record)
          && ((record.phase === pre.phase && record.reviewAttempt === pre.reviewAttempt)
            || (observationStarted && record.phase === "reviewing" && record.reviewAttempt === (pre.reviewAttempt ?? 0) + 1));
        if (!ownsStartup(latest)) throw error;
        if (existing && !this.ctx.isStopping() && this.originalThreadAvailable(existing.threadId, existing.threadOwner)
          && latest.phase === pre.phase && latest.reviewAttempt === pre.reviewAttempt
          && latest.processState === "waiting" && latest.retryState?.stage === "reviewing"
          && latest.retryState.awaitingContinuation && JSON.stringify(latest.retryState) === JSON.stringify(pre.retryState)) {
          // An unstarted continuation still owns the previous waiting round.
          // Restore its claimed handle without changing history or releasing it.
          this.ctx.setRecoverableRun(workflowId, existing);
          retainStartupForContinuation = true;
          throw error;
        }
        const failed = await this.ctx.store.update(workflowId, (record) => {
          if (!ownsStartup(record)) throw new Error("review startup ownership changed before failure finalization");
          record.phase = priorPhase;
          record.error = this.ctx.errorMessage(error);
          record.processState = "failed";
          record.retryState = undefined;
          record.activeTurnId = undefined;
          record.reviewAttempt = pre.reviewAttempt;
          record.reviewStartedAt = pre.reviewStartedAt;
          record.reviewStep = pre.reviewStep;
          record.reviewElapsedMs = pre.reviewElapsedMs;
          record.reviewPhaseTimings = pre.reviewPhaseTimings;
          record.lastProgressAt = new Date().toISOString();
          record.lastProgressMessage = "Review startup failed; retry this workflow explicitly";
        }, { ignoreCancelled: false });
        if (failed.suppressed) return failed.record;
        throw error;
      } finally {
        this.ctx.reviewObservation.stopHeartbeat(workflowId, reviewHeartbeat);
        if (existing && !observationStarted && startupLatest?.processState === "waiting" && restoreBeforeRun(startupLatest)) {
          retainStartupForContinuation = true;
        }
        if (existing && !retainStartupForContinuation) await releaseBeforeRun();
        else if (!existing) {
          try { child?.finish(this.ctx.errorMessage(error), "failed"); }
          finally { await this.ctx.disposeChildSession(workflowId, child); }
        }
      }
    }
    if (entering.suppressed) {
      if (existing) await releaseBeforeRun();
      else await this.ctx.disposeChildSession(workflowId, child);
      return entering.record;
    }
    let current = entering.record;
    const identity = { dshSessionId: current.dshSessionId, reviewAttempt: current.reviewAttempt, cwd: current.cwd };
    let evidenceFingerprint: string | undefined;
    const ownsAttempt = (record: WorkflowRecord) => ownsScope(record) && record.dshSessionId === identity.dshSessionId
      && record.reviewAttempt === identity.reviewAttempt && record.cwd === identity.cwd
      && (evidenceFingerprint === undefined || record.latestReviewEvidence?.fingerprint === evidenceFingerprint);
    const assertCurrentAttempt = (record: WorkflowRecord) => {
      exec.signal.throwIfAborted();
      if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
      if (!ownsAttempt(record) || record.phase !== "reviewing") {
        throw new Error(`workflow ${workflowId} changed its review owner, attempt or evidence before result acceptance`);
      }
      if (checkpoint) assertForegroundReviewCheckpoint(checkpoint, record, { input, evidence: record.latestReviewEvidence, reviewerSettings });
    };
    const live = this.ctx.createLiveRelay(current, "reviewing", `${workflowId}:${current.reviewAttempt ?? 1}`);
    let reviewerClaimed = Boolean(existing);
    let reviewerThreadId: string | undefined = existing?.threadId;
    let reviewerThreadOwner = existing?.threadOwner;
    let reviewerSettings = existing?.reviewerSettings;
    let reviewerModel = reviewerSettings?.model;
    let retainForContinuation = false;
    let visibleReviewText: string | undefined;
    let reviewEndDetail: Pick<CodexReviewEndEvent, "verdict" | "result" | "visibleText" | "summary" | "error"> | undefined;
    // 1.1.6: pin the App Server child for the whole round. Without the pin the
    // idle window can fall between creating the Reviewer and its first turn,
    // and the respawned process answers `thread not found` for that new thread.
    if (!existing) this.ctx.turnGateway.beginRound();
    try {
      exec.signal.throwIfAborted();
      const evidence = await collectEvidence({
        cwd: current.cwd,
        maxDiffBytes: this.ctx.config.reviewDiffMaxBytes,
        changedFiles: input.changedFiles,
      });
      const git = await isGitRepository(current.cwd);
      if (evidence.insufficient || !evidence.fingerprint) {
        throw new Error("review evidence is unavailable; provide readable, cwd-contained changedFiles in a non-Git workspace");
      }
      if (existing?.evidence?.fingerprint !== undefined && existing.evidence.fingerprint !== evidence.fingerprint) {
        throw new Error("workspace changed since the interrupted review; start a new review round");
      }

      const evidenceCommit = await this.ctx.store.update(workflowId, (r) => {
        assertCurrentAttempt(r);
        r.latestReviewEvidence = evidence;
      }, { ignoreCancelled: false });
      if (evidenceCommit.suppressed) return evidenceCommit.record;
      current = evidenceCommit.record;
      evidenceFingerprint = evidence.fingerprint;

      // The visible review always runs on a fresh App Server ephemeral thread.
      // Structured conversion is App Server by default; an explicit CLI mode
      // or configured fallback still uses private `--ephemeral` audit calls.
      // No new Planner/Reviewer id is persisted or made visible to Codex
      // Desktop; legacy ids are diagnostic only.
      if (!reviewerSettings) {
        const effort = current.reviewerEffort ?? this.ctx.config.reviewerEffort;
        const model = current.reviewerModel || this.ctx.config.reviewerModel
          || await this.ctx.turnGateway.resolveDefaultModel?.(exec.signal) || undefined;
        reviewerSettings = Object.freeze({ model, effort });
      }
      reviewerModel = reviewerSettings.model;
      const contract = reviewContractInstructions(current, input, evidence);
      // Every new round gets a fresh App Server ephemeral Reviewer. Durable
      // Reviewer ids from older records are diagnostic only and are never
      // resumed, renamed or handed to Desktop.
      if (!reviewerThreadId) {
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
        reviewerThreadOwner = this.ctx.captureThreadOwner?.(reviewerThreadId!);
        let threadCommit;
        try {
          threadCommit = await this.ctx.store.update(workflowId, (r) => {
            assertCurrentAttempt(r);
            r.reviewStep = "review_native_turn";
            r.lastProgressAt = new Date().toISOString();
            r.lastProgressMessage = "Running Reviewer turn";
            r.reviewPhaseTimings = {
              ...(r.reviewPhaseTimings ?? {}),
              review_native_turn: { startedAt: new Date().toISOString() },
            };
            // The new Reviewer is an App Server ephemeral thread. Keep only
            // the origin marker for diagnostics; its id is process-local and
            // must never become a Desktop-visible durable binding.
            r.reviewerThreadOrigin = "app-server-ephemeral";
          }, { ignoreCancelled: false });
        } catch (error) {
          // The created task could not be bound: release its hold before the
          // failure propagates, so a failed round cannot leave it loaded.
          this.ctx.reportCleanupNote(workflowId, await this.ctx.releaseUnboundReviewer(reviewerThreadId, undefined, reviewerThreadOwner));
          throw error;
        }
        if (threadCommit.suppressed) {
          // A concurrent cancel won the CAS: the task is never bound, so it is
          // released here instead of being left subscribed under a cancelled
          // workflow (the task remains in the Codex store, unbound).
          this.ctx.reportCleanupNote(workflowId, await this.ctx.releaseUnboundReviewer(reviewerThreadId, undefined, reviewerThreadOwner));
          return threadCommit.record;
        }
        current = threadCommit.record;
        reviewerClaimed = true;
      } else {
        // A recoverable model failure keeps the ephemeral Reviewer subscribed;
        // this round resumes the exact same thread without a new child.
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
      if (!checkpoint) {
        // 1.1.2: the visible review turn runs through the SAME transient-retry
        // wrapper as every other visible turn (1.1.1 parity on the App Server
        // path). A retried attempt re-registers its own turn, so the active-turn
        // mapping always points at the newest turn.
        let review: Awaited<ReturnType<ReviewExecutionContext["startReviewWithTransientRetry"]>>;
        const baseReviewTarget = reviewInstructions(current, input, evidence, git);
        let reviewTarget = baseReviewTarget;
        if (existing) {
          reviewTarget = instruction ?? "继续当前 Reviewer 会话中的本轮审查。";
          child?.beginContinuation(pendingStart ? "接回原审查回合并继续观察其输出，不重新启动模型。"
            : instruction ?? "继续当前 Reviewer 会话中的本轮审查。");
        }
        for (let continuation = 0; ; continuation += 1) {
          if (!this.originalThreadAvailable(reviewerThreadId!, reviewerThreadOwner)) {
            throw new Error("original Reviewer thread is unavailable; no replacement will be started");
          }
          try {
            const startOptions = {
            threadId: reviewerThreadId!,
            ...(reviewerThreadOwner ? { expectedOwner: reviewerThreadOwner } : {}),
            cwd: current.cwd,
            detached: false,
            model: reviewerModel,
            effort: reviewerSettings.effort,
            target: { type: "custom", instructions: reviewTarget },
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
              await this.ctx.registerActiveTurn(workflowId, started.threadId, started.turnId, "reviewer", true, undefined, reviewerThreadOwner);
            },
            onProgress: (entry: any) => { live.onProgress(entry); child?.progress(entry); },
            };
            review = pendingStart
              ? await pendingStart.operation.resume({ onStarted: startOptions.onStarted, onProgress: startOptions.onProgress }, exec.signal)
              : continuation > 0 || existing
              ? { threadId: reviewerThreadId!, result: await this.ctx.startTurnWithTransientRetry(reviewerThreadId!, {
                ...(reviewerThreadOwner ? { expectedOwner: reviewerThreadOwner } : {}),
                  prompt: reviewTarget,
                  ...(reviewerModel ? { model: reviewerModel } : {}),
                  effort: reviewerSettings.effort,
                  silentReview: true,
                  onProgress: startOptions.onProgress,
                  onStarted: startOptions.onStarted,
                }, exec.signal) }
              : await this.ctx.startReviewWithTransientRetry(startOptions, exec.signal);
            if (pendingStart) {
              const held = this.ctx.getRecoverableRun(workflowId);
              if (held?.pendingStart?.operation === pendingStart.operation && pendingStart.operation.finished()) {
                await this.ctx.confirmReviewerTerminalCleanup?.(workflowId, held);
                this.ctx.clearRecoverableRun(workflowId);
              }
              pendingStart = undefined;
            }
          } catch (error) {
            if (error instanceof CodexTurnReceiptPendingError) throw error;
            if (error instanceof CodexTurnInterruptionError && error.cleanupOnly) throw error;
            if (exec.signal.aborted || this.ctx.isStopping()) throw error;
            const detail = this.ctx.errorMessage(error);
            if (error instanceof CodexTurnInterruptionError && error.threadId === reviewerThreadId) {
              assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
              const waiting = await this.waitForContinuation(reviewerThreadOwner, workflowId, priorPhase, reviewerThreadId!, child,
                input, evidence, detail, ownsAttempt, reviewerSettings, error.turnId, error.originalProcessId, error.originalProcessIds,
                checkpoint, automaticContinuations, undefined, undefined, undefined, undefined, error.originalProcessIdentities);
              retainForContinuation = waiting.phase !== "cancelled";
              return waiting;
            }
            if (!isRecoverableModelFailure(error)) throw error;
            assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
            if (automaticContinuations >= 1) {
              const waiting = await this.waitForContinuation(reviewerThreadOwner, workflowId, priorPhase, reviewerThreadId!, child, input, evidence, detail, ownsAttempt, reviewerSettings,
                undefined, undefined, undefined, checkpoint, automaticContinuations);
              retainForContinuation = waiting.phase !== "cancelled";
              return waiting;
            }
            automaticContinuations = 1;
            reviewTarget = "上一轮 Reviewer 回合因可恢复的运行错误中断。请在当前 Reviewer 会话中继续本轮只读审查，沿用原审查要求和范围，不要重新开始或重复已经完成的内容。";
            child?.beginContinuation(reviewTarget);
            continue;
          }
          const failedText = review.result.kind === "completed" && review.result.status !== "completed"
            ? `${review.result.reason ?? "turn failed"}${review.result.error ? `: ${review.result.error}` : ""}`
            : "";
          if (!failedText || !isRecoverableModelFailure(failedText)) break;
          assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
          if (automaticContinuations >= 1) {
            const waiting = await this.waitForContinuation(reviewerThreadOwner, workflowId, priorPhase, reviewerThreadId!, child, input, evidence, failedText, ownsAttempt, reviewerSettings,
              undefined, undefined, undefined, checkpoint, automaticContinuations);
            retainForContinuation = waiting.phase !== "cancelled";
            return waiting;
          }
          automaticContinuations = 1;
          reviewTarget = "上一轮 Reviewer 回合因可恢复的运行错误中断。请在当前 Reviewer 会话中继续本轮只读审查，沿用原审查要求和范围，不要重新开始或重复已经完成的内容。";
          child?.beginContinuation(reviewTarget);
        }
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
          await this.ctx.reviewObservation.mark(workflowId, "review_display_rewrite", "Rewriting Reviewer display output", null);
          const rewrite = await this.ctx.startTurnWithTransientRetry(reviewerThreadId, {
            ...(reviewerThreadOwner ? { expectedOwner: reviewerThreadOwner } : {}),
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
        assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
        checkpoint = captureForegroundReviewCheckpoint(current, input, evidence, reviewerSettings, authoritativeText, automaticContinuations);
      } else {
        assertForegroundReviewCheckpoint(checkpoint, current, { input, evidence, reviewerSettings });
        child?.beginContinuation(instruction ?? "继续原 Reviewer 已完成审查的剩余校验阶段，复用已完成结果，不重新审查或改写已完成内容。");
      }
      visibleReviewText = checkpoint.readableText;

      // Since 1.0.7 the visible review turn (startReview) produces a readable
      // review; the structured verdict is derived by a private conversion turn
      // (in-place for this ephemeral Reviewer), never written into Desktop
      // history. App Server conversion is the default because it reuses the
      // warm ephemeral process/thread. Foreground CLI conversion is an
      // explicit option; a failed App Server stage never switches transport.
      let applied: ReviewResult | undefined = checkpoint.applied;
      let conflictInfo: ReviewConflictInfo | undefined = checkpoint.conflictInfo;
      const normalizeWithCli = async (): Promise<ReviewResult> => {
        if (!this.ctx.audit) throw new Error("CLI conversion requested but the CLI audit gateway is unavailable");
        await this.ctx.reviewObservation.mark(workflowId, "review_conversion", "Converting Reviewer result (CLI)", null);
        let normalized: ReviewResult;
        try {
          normalized = await this.ctx.audit.normalize({
            visibleText: checkpoint!.readableText,
            cwd: current.cwd,
            workflowId,
            ...(reviewerModel ? { model: reviewerModel } : {}),
          }, exec.signal);
        } catch (error) { throw new ForegroundReviewStageError("conversion", error, { modelCall: true }); }
        return applyReviewConsistency(normalized);
      };
      const normalizeWithAppServer = async (): Promise<ReviewResult> => {
        await this.ctx.reviewObservation.mark(workflowId, "review_conversion", "Converting Reviewer result (App Server)", null);
        let normalized: TurnWaitResult;
        try {
          const onStarted = (started: { threadId: string; turnId: string }) => this.ctx.registerEphemeralTurn(
            workflowId, started.threadId, started.turnId, "reviewer");
          normalized = pendingStart
            ? (await pendingStart.operation.resume({ onStarted }, exec.signal)).result
            : await this.ctx.turnGateway.normalizeInFork({
            threadId: reviewerThreadId!,
            ...(reviewerThreadOwner ? { expectedOwner: reviewerThreadOwner } : {}),
            cwd: current.cwd,
            prompt: reviewConversionPrompt(checkpoint!.readableText, workflowId),
            ...(reviewerModel ? { model: reviewerModel } : {}),
            outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
            sourceEphemeral: true,
            // The private conversion turn becomes the active reviewer turn for
            // cancellation (in-process only — its id is never persisted).
            onStarted,
          }, exec.signal);
          if (pendingStart) {
            const held = this.ctx.getRecoverableRun(workflowId);
            if (held?.pendingStart?.operation === pendingStart.operation && pendingStart.operation.finished()) {
              await this.ctx.confirmReviewerTerminalCleanup?.(workflowId, held); this.ctx.clearRecoverableRun(workflowId);
            }
            pendingStart = undefined;
          }
        } catch (error) { throw new ForegroundReviewStageError("conversion", error, { modelCall: true }); }
        finally {
          this.ctx.runtime.activeTurns.delete(workflowId);
        }
        const afterNormalize = await this.ctx.store.load(workflowId);
        if (!afterNormalize || afterNormalize.phase === "cancelled") throw new Error("workflow cancelled during review normalization");
        current = afterNormalize;
        if (normalized.kind !== "completed") throw new Error("review normalization unexpectedly requested user input");
        if (normalized.status !== "completed") {
          throw new ForegroundReviewStageError("conversion", new Error(
            `${normalized.reason ?? `review normalization turn ${normalized.status}`}${normalized.error ? `: ${normalized.error}` : ""}`),
            { modelCall: true });
        }
        return applyReviewConsistency(parseReview(normalized.text));
      };
      // One automatic continuation belongs to the whole business round. The
      // checkpoint advances only after a stage actually returns usable output.
      for (;;) {
        try {
          if (!checkpoint.verdict) {
            let result: ReviewResult;
            if (this.ctx.config.conversionTransport === "cli") result = await normalizeWithCli();
            else result = await normalizeWithAppServer();
            assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
            checkpoint = Object.freeze({ ...checkpoint, verdict: structuredClone(result), nextStep: "alignment" });
          }
          if (!checkpoint.alignment) {
            await this.ctx.reviewObservation.mark(workflowId, "review_alignment", "Checking Review authority alignment", null);
            const alignment = await this.ctx.alignReview(current, checkpoint.verdict, exec.signal, input, reviewerSettings,
              (record: WorkflowRecord) => { assertCurrentAttempt(record); return true; });
            if (pendingStart?.operation.finished()) {
              const held = this.ctx.getRecoverableRun(workflowId);
              if (held?.pendingStart?.operation === pendingStart.operation) {
                await this.ctx.confirmReviewerTerminalCleanup?.(workflowId, held); this.ctx.clearRecoverableRun(workflowId);
              }
              pendingStart = undefined;
            }
            assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
            checkpoint = Object.freeze({ ...checkpoint, alignment: structuredClone(alignment),
              nextStep: alignment.aligned ? "finalizing" : "reconciliation", ...(alignment.aligned ? { applied: checkpoint.verdict } : {}) });
          }
          if (checkpoint.nextStep === "reconciliation") {
            await this.ctx.reviewObservation.mark(workflowId, "review_reconciliation", "Reconciling Review findings");
            const alignment: AlignmentOutcome = checkpoint.alignment!;
            const reconciled = await this.ctx.reconcileReview(current, checkpoint.verdict, alignment.conflicts, exec.signal, input, reviewerSettings,
              (record: WorkflowRecord) => { assertCurrentAttempt(record); return true; }, {
                checkpoint: checkpoint.reconciliation,
                capture: (next: ForegroundReconciliationCheckpoint) => {
                  checkpoint = Object.freeze({ ...checkpoint!, reconciliation: structuredClone(next) });
                },
              });
            if (pendingStart?.operation.finished()) {
              const held = this.ctx.getRecoverableRun(workflowId);
              if (held?.pendingStart?.operation === pendingStart.operation) {
                await this.ctx.confirmReviewerTerminalCleanup?.(workflowId, held); this.ctx.clearRecoverableRun(workflowId);
              }
              pendingStart = undefined;
            }
            assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
            conflictInfo = { conflicts: alignment.conflicts, reconciled: true, resolved: reconciled.aligned, at: new Date().toISOString() };
            if (reconciled.aligned) {
              await this.ctx.reviewObservation.mark(workflowId, "review_reconciliation",
                `已按权威层级改写（${alignment.conflicts.length} 条冲突已解决）`, null);
            }
            checkpoint = Object.freeze({ ...checkpoint, nextStep: "finalizing", conflictInfo,
              ...(reconciled.aligned ? { applied: structuredClone(reconciled.result) } : {}) });
          }
          applied = checkpoint.applied;
          conflictInfo = checkpoint.conflictInfo;
          break;
        } catch (error) {
          if (!(error instanceof ForegroundReviewStageError) || !error.recoverable || error.interruption?.cleanupOnly
            || exec.signal.aborted || this.ctx.isStopping()) throw error;
          let confirmedError = error;
          if (error.interruption) {
            const interrupted = error.interruption;
            const pair = { threadId: interrupted.threadId, turnId: interrupted.turnId };
            const auxiliaryOwner = this.ctx.runtime.auxiliaryInterruptionOwners.get(interrupted);
            const confirmed = interrupted.threadId === reviewerThreadId
              ? await this.ctx.interruptReviewerTurn(interrupted.threadId, interrupted.turnId, reviewerThreadOwner)
              : await this.ctx.confirmAuxiliaryTurns(workflowId, pair, auxiliaryOwner);
            assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
            if (!confirmed) throw error;
            confirmedError = new ForegroundReviewStageError(error.stage, error.original,
              { interruptionConfirmed: true, modelCall: error.modelCall });
          }
          assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
          if (!this.originalThreadAvailable(reviewerThreadId!, reviewerThreadOwner)) {
            const waiting = await this.waitForContinuation(reviewerThreadOwner, workflowId, priorPhase, reviewerThreadId!, child,
              input, evidence, "original Reviewer thread is unavailable; completed review output was retained without starting a replacement",
              ownsAttempt, reviewerSettings, undefined, undefined, undefined, checkpoint, automaticContinuations);
            retainForContinuation = waiting.phase !== "cancelled";
            return waiting;
          }
          if (automaticContinuations >= 1) throw confirmedError;
          const retryEvidence = await collectEvidence({ cwd: current.cwd, maxDiffBytes: this.ctx.config.reviewDiffMaxBytes,
            changedFiles: checkpoint.input.changedFiles });
          assertCurrentAttempt(await this.ctx.owned(workflowId, exec));
          if (retryEvidence.insufficient || !retryEvidence.fingerprint) {
            throw new ForegroundReviewEvidenceUnavailableError("workspace changed or evidence is unavailable before private review continuation; completed output was not reused");
          }
          if (retryEvidence.kind !== checkpoint.evidence.kind || retryEvidence.fingerprint !== checkpoint.evidence.fingerprint) {
            throw new TypedForegroundReviewEvidenceChangedError("workspace changed or evidence is unavailable before private review continuation; completed output was not reused");
          }
          if (!this.originalThreadAvailable(reviewerThreadId!, reviewerThreadOwner)) throw confirmedError;
          automaticContinuations = 1;
          checkpoint = Object.freeze({ ...checkpoint, automaticContinuations });
          const continuation = "上一轮审查的后处理模型回合失败。请在原 Reviewer 会话中继续剩余校验，复用已完成的审查结果，不重新审查或重复已完成内容。";
          child?.beginContinuation(continuation);
        }
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
      const result = checkpoint.verdict!;
      // Re-read the original scope after every asynchronous model step. This
      // snapshot protects result acceptance, not subsequent live filesystem edits.
      await this.ctx.reviewObservation.mark(workflowId, "review_finalizing", "Checking current workspace evidence before accepting Review");
      let finalEvidence: ReviewEvidence;
      try {
        finalEvidence = await this.ctx.readFinalEvidence({ cwd: identity.cwd,
          maxDiffBytes: this.ctx.config.reviewDiffMaxBytes, changedFiles: input.changedFiles });
      } catch (error) {
        if (error instanceof TypedForegroundReviewEvidenceChangedError) throw error;
        throw new ForegroundReviewEvidenceUnavailableError(error);
      }
      exec.signal.throwIfAborted();
      if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
      current = await this.ctx.owned(workflowId, exec);
      if (current.phase === "cancelled") return current;
      assertCurrentAttempt(current);
      if (finalEvidence.insufficient || !finalEvidence.fingerprint) {
        throw new ForegroundReviewEvidenceUnavailableError("review evidence is unavailable at final verification; the previous result was not applied");
      }
      if (finalEvidence.kind !== evidence.kind) {
        throw new TypedForegroundReviewEvidenceChangedError("review evidence is unavailable at final verification; the previous result was not applied");
      }
      if (finalEvidence.fingerprint !== evidence.fingerprint) {
        throw new TypedForegroundReviewEvidenceChangedError("workspace changed during review; stale evidence result was not applied; request a new explicit review of the current workspace");
      }
      if (!applied) {
        // Unresolved conflict: restore the pre-review phase (blocked after
        // two CONSECUTIVE unresolved conflicts). NO latestReview, NO cycle,
        // NO fixing prompt — the reviewer contract failed, not the code.
        this.ctx.runtime.activeTurns.delete(workflowId);
        const conflictCommit = await this.ctx.store.update(workflowId, (r) => {
          assertCurrentAttempt(r);
          r.latestReviewConflict = conflictInfo;
          r.reviewContractFailures = (r.reviewContractFailures ?? 0) + 1;
          const blocked = (r.reviewContractFailures ?? 0) >= 2;
          r.phase = blocked ? "blocked" : priorPhase;
          r.error = blocked
            ? "reviewer contract failure: the review conflicts with the authority hierarchy and was not reconciled after "
              + `${r.reviewContractFailures} consecutive review calls; no code changes are required`
            : "review contract conflict: the review conflicts with the authority hierarchy and was not reconciled "
              + "after one correction attempt; no code changes are required — request an explicit independent review round to check the contract again";
          r.processState = blocked ? "completed" : "failed";
          r.reviewFailureReason = "review_contract_conflict";
          r.activeTurnId = undefined;
          r.lastProgressAt = new Date().toISOString();
          r.lastProgressMessage = blocked ? "Review completed with a contract block" : "Review contract conflict; an independent review round is required";
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
      const commit = await this.ctx.store.update(workflowId, (r) => {
        assertCurrentAttempt(r);
        this.ctx.trackNoChange(r, evidence);
        r.latestReview = applied!;
        r.retryState = undefined;
        r.reviewFailureReason = undefined;
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
      const stageError = error instanceof ForegroundReviewStageError ? error : undefined;
      const pending = error instanceof CodexTurnReceiptPendingError ? error
        : stageError?.original instanceof CodexTurnReceiptPendingError ? stageError.original : undefined;
      const interruption = stageError?.interruption ?? (error instanceof CodexTurnInterruptionError ? error : undefined);
      const cancelled = await this.ctx.store.load(workflowId);
      if (pending && reviewerThreadId && reviewerSettings && current.latestReviewEvidence) {
        retainForContinuation = true;
        const evidence = await pending.operation.evidence();
        const state: WorkflowRetryState = { stage: "reviewing", reason: pending.message, attempts: 1,
          awaitingContinuation: true, awaitingStartReceipt: true,
          ...(checkpoint ? { reviewCheckpoint: { nextStep: checkpoint.nextStep } } : {}) };
        const run: RecoverableWorkflowRun = { state, threadId: reviewerThreadId, threadOwner: reviewerThreadOwner, child, input,
          evidence: current.latestReviewEvidence, reviewerIdentity: reviewerRunIdentity({ ...current, phase: priorPhase }),
          reviewerSettings, pendingStart: pending, originalProcessId: evidence.processId, originalProcessIds: evidence.processIds,
          originalProcessIdentities: evidence.processIdentities, reviewCheckpoint: checkpoint, automaticContinuations };
        if (cancelled?.phase === "cancelled" || this.ctx.isStopping()) {
          run.pendingStartIntent = "cancel";
          run.terminalFailure = "Original Reviewer cancelled while its start receipt was pending";
          state.awaitingCleanup = true; state.terminalFailure = run.terminalFailure;
        }
        this.ctx.setRecoverableRun(workflowId, run);
        child?.failAttempt(pending.message);
        const held = this.ctx.getRecoverableRun(workflowId)!;
        const waiting = await this.ctx.store.update(workflowId, (r) => {
          assertReviewerRunIdentity(run.reviewerIdentity!, r);
          if (r.phase !== "cancelled") {
            if (!ownsAttempt(r)) throw new Error("Original Reviewer pending receipt scope changed");
            r.phase = priorPhase;
          }
          r.processState = "waiting"; r.retryState = held.state; r.error = pending.message; r.activeTurnId = undefined;
          r.lastProgressAt = new Date().toISOString();
          r.lastProgressMessage = "Original Reviewer start receipt is pending; no replacement model request was sent";
        }, { ignoreCancelled: true });
        return waiting.record;
      }
      if (interruption?.cleanupOnly && reviewerThreadId && reviewerSettings && current.latestReviewEvidence) {
        const terminalFailure = interruption.cause instanceof Error ? interruption.cause.message : this.ctx.errorMessage(error);
        const auxiliary = interruption.threadId !== reviewerThreadId
          ? { threadId: interruption.threadId, turnId: interruption.turnId } : undefined;
        const auxiliaryOwner = this.ctx.runtime.auxiliaryInterruptionOwners.get(interruption);
        // Keep the exact resource owner even when cancellation or scope drift
        // forbids writing the row. Lifecycle still owns its pending cleanup.
        retainForContinuation = true;
        const state: WorkflowRetryState = { stage: "reviewing", reason: terminalFailure, attempts: 1,
          awaitingContinuation: true, awaitingCleanup: true, terminalFailure,
          interruption: { target: auxiliary ? "auxiliary" : "reviewer",
            ...(interruption.originalProcessId === undefined ? {} : { processId: interruption.originalProcessId }),
            ...(interruption.originalProcessIds === undefined ? {} : { processIds: [...interruption.originalProcessIds] }),
            ...(interruption.originalProcessIdentities === undefined ? {}
              : { processIdentities: interruption.originalProcessIdentities.map((identity) => ({ ...identity })) }) } };
        const terminalRun: RecoverableWorkflowRun = { state, threadId: reviewerThreadId, threadOwner: reviewerThreadOwner, child, input,
          evidence: current.latestReviewEvidence, reviewerIdentity: reviewerRunIdentity(current), reviewerSettings,
          terminalFailure, cleanupThreadOwner: interruption.originalThreadOwner, originalProcessId: interruption.originalProcessId, originalProcessIds: interruption.originalProcessIds,
          originalProcessIdentities: interruption.originalProcessIdentities,
          ...(checkpoint ? { reviewCheckpoint: checkpoint } : {}), automaticContinuations,
          ...(auxiliary ? { auxiliaryInterruption: auxiliary, auxiliaryInterruptionOwner: auxiliaryOwner }
            : { interruptionTurnId: interruption.turnId }) };
        this.ctx.setRecoverableRun(workflowId, terminalRun);
        if (!cancelled || !ownsAttempt(cancelled) || cancelled.phase !== "reviewing" || this.ctx.isStopping()) {
          throw error;
        }
        return await this.waitForContinuation(reviewerThreadOwner, workflowId, priorPhase, reviewerThreadId, child, input,
          cancelled.latestReviewEvidence!, terminalFailure, ownsAttempt, reviewerSettings,
          auxiliary ? undefined : interruption.turnId, interruption.originalProcessId, interruption.originalProcessIds,
          checkpoint, automaticContinuations, auxiliary, terminalFailure, auxiliaryOwner, terminalRun, interruption.originalProcessIdentities);
      }
      if (cancelled?.phase === "cancelled") { current = cancelled; return cancelled; }
      reviewEndDetail = { error: this.ctx.errorMessage(error), ...(visibleReviewText ? { visibleText: visibleReviewText } : {}) };
      // A late failure must not rewrite the state of another owner/attempt.
      if (!cancelled || !ownsAttempt(cancelled) || cancelled.phase !== "reviewing") throw error;
      if (interruption && interruption.threadId === reviewerThreadId && !this.ctx.isStopping()) {
        const waiting = await this.waitForContinuation(reviewerThreadOwner, workflowId, priorPhase, reviewerThreadId!, child,
          input, cancelled.latestReviewEvidence!, this.ctx.errorMessage(error), ownsAttempt, reviewerSettings!, interruption.turnId,
          interruption.originalProcessId, interruption.originalProcessIds, checkpoint, automaticContinuations,
          undefined, undefined, undefined, undefined, interruption.originalProcessIdentities);
        retainForContinuation = waiting.phase !== "cancelled";
        return waiting;
      }
      if (checkpoint && reviewerThreadId && !this.ctx.isStopping()
        && (stageError?.recoverable || error instanceof ForegroundReviewEvidenceUnavailableError)) {
        const auxiliary = interruption && interruption.threadId !== reviewerThreadId
          ? { threadId: interruption.threadId, turnId: interruption.turnId } : undefined;
        const waiting = await this.waitForContinuation(reviewerThreadOwner, workflowId, priorPhase, reviewerThreadId, child,
          input, cancelled.latestReviewEvidence!, this.ctx.errorMessage(error), ownsAttempt, reviewerSettings!, undefined,
          interruption?.originalProcessId, interruption?.originalProcessIds, checkpoint, automaticContinuations, auxiliary, undefined,
          interruption && this.ctx.runtime.auxiliaryInterruptionOwners.get(interruption), undefined, interruption?.originalProcessIdentities);
        retainForContinuation = waiting.phase !== "cancelled";
        return waiting;
      }
      if (reviewerThreadId && !this.ctx.isStopping() && cancelled?.latestReviewEvidence
        && !interruption
        && (exec.signal.aborted || this.ctx.errorMessage(error) === "operation aborted")) {
        const waiting = await this.waitForContinuation(reviewerThreadOwner, workflowId, priorPhase, reviewerThreadId, child, input,
          cancelled.latestReviewEvidence, this.ctx.errorMessage(error), ownsAttempt, reviewerSettings!, undefined, undefined, undefined,
          checkpoint, automaticContinuations);
        retainForContinuation = waiting.phase !== "cancelled";
        return waiting;
      }
      const failed = await this.ctx.store.update(workflowId, (r) => {
        if (!ownsAttempt(r) || r.phase !== "reviewing") return;
        r.phase = priorPhase;
        r.error = this.ctx.errorMessage(error);
        r.processState = "failed";
        r.retryState = undefined;
        if (reviewerClaimed && reviewerThreadId) r.reviewFailureReason = "original_reviewer_unavailable";
        r.activeTurnId = undefined;
        r.lastProgressAt = new Date().toISOString();
        r.lastProgressMessage = "Review failed; retry is available";
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      reviewEndDetail = { error: this.ctx.errorMessage(error), ...(visibleReviewText ? { visibleText: visibleReviewText } : {}) };
      throw error;
    } finally {
      try {
        try {
          if (existing?.pendingStart && (this.ctx.getRecoverableRun(workflowId) === existing || existing.receiptCleanupClaimed)) retainForContinuation = true;
          if (!retainForContinuation) {
            this.ctx.clearRecoverableRun(workflowId);
            child?.finish(reviewEndDetail?.error ?? visibleReviewText ?? "", reviewEndDetail?.error ? "failed" : current.phase === "cancelled" ? "aborted" : "completed");
            await this.ctx.disposeChildSession(workflowId, child);
          }
        } finally {
          live.close();
          const releaseNote = !retainForContinuation && reviewerClaimed && reviewerThreadId
            ? await this.ctx.releaseReviewerSubscription(reviewerThreadId, reviewerThreadOwner)
            : undefined;
          this.ctx.reportCleanupNote(workflowId, releaseNote);
          await this.ctx.reviewObservation.finish(workflowId, undefined, reviewEndDetail,
            { ...identity, evidenceFingerprint }, undefined, reviewHeartbeat);
          await this.ctx.flushCleanupNotes(workflowId, { ...identity, evidenceFingerprint });
        }
      } finally {
        if (!retainForContinuation) this.ctx.turnGateway.endRound();
      }
    }
  }

  async resume(workflowId: string, instruction: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const recovery = this.ctx.getRecoverableRun(workflowId);
    if (!recovery || recovery.state.stage !== "reviewing" || !recovery.input) {
      throw new Error(`workflow ${workflowId} has no in-process Reviewer session to resume; restart cannot recover an ephemeral thread`);
    }
    if (!recovery.reviewerIdentity) throw new Error("original Reviewer identity is unavailable; no replacement will be started");
    if (!recovery.reviewerSettings) throw new Error("original Reviewer settings are unavailable; no replacement will be started");
    if (recovery.terminalFailure || recovery.pendingStartIntent) return this.finishTerminalCleanup(workflowId, recovery, exec);
    if (recovery.pendingStart && recovery.pendingStart.operation.status() !== "ready") throw recovery.pendingStart;
    const original = await this.ctx.owned(workflowId, exec);
    assertReviewerRunIdentity(recovery.reviewerIdentity, original);
    if (original.phase === "cancelled" || this.ctx.isStopping()) return original;
    assertReviewerRecovery(recovery.reviewerIdentity, original);
    if (original.retryState?.reviewCheckpoint && !recovery.reviewCheckpoint) {
      throw new Error("original completed Reviewer checkpoint is unavailable; no replacement will be started");
    }
    if (recovery.reviewCheckpoint) assertForegroundReviewCheckpoint(recovery.reviewCheckpoint, original, recovery);
    exec.signal.throwIfAborted();
    if (this.ctx.getRecoverableRun(workflowId) !== recovery) throw new Error("original Reviewer recovery owner changed before continuation");
    if (recovery.reviewCheckpoint) {
      const evidence = await collectEvidence({ cwd: original.cwd, maxDiffBytes: this.ctx.config.reviewDiffMaxBytes,
        changedFiles: recovery.input.changedFiles });
      const latest = await this.ctx.owned(workflowId, exec);
      exec.signal.throwIfAborted();
      if (latest.phase === "cancelled" || this.ctx.isStopping()) return latest;
      assertReviewerRecovery(recovery.reviewerIdentity, latest);
      assertForegroundReviewCheckpoint(recovery.reviewCheckpoint, latest, recovery);
      if (this.ctx.getRecoverableRun(workflowId) !== recovery || JSON.stringify(latest.retryState) !== JSON.stringify(original.retryState)) {
        throw new Error("original completed Reviewer owner changed during evidence verification");
      }
      if (evidence.insufficient || !evidence.fingerprint || evidence.kind !== recovery.reviewCheckpoint.evidence.kind
        || evidence.fingerprint !== recovery.reviewCheckpoint.evidence.fingerprint) {
        throw new Error("workspace changed or evidence is unavailable since the completed review; no completed output was reused");
      }
    }
    if (original.retryState?.interruption?.target === "auxiliary" && !recovery.auxiliaryInterruption) {
      throw new Error("original private Reviewer interruption pair is unavailable; no model continuation was sent");
    }
    if (recovery.auxiliaryInterruption) {
      const pair = recovery.auxiliaryInterruption;
      const waitingState = JSON.stringify(original.retryState);
      if (!recovery.auxiliaryInterruptionOwner) {
        throw new Error("original private Reviewer execution owner is unavailable; no model continuation was sent");
      }
      const confirmed = await this.ctx.confirmAuxiliaryTurns(workflowId, pair, recovery.auxiliaryInterruptionOwner);
      const latest = await this.ctx.owned(workflowId, exec);
      assertReviewerRunIdentity(recovery.reviewerIdentity, latest);
      if (latest.phase === "cancelled" || this.ctx.isStopping()) return latest;
      assertReviewerRecovery(recovery.reviewerIdentity, latest);
      if (recovery.reviewCheckpoint) assertForegroundReviewCheckpoint(recovery.reviewCheckpoint, latest, recovery);
      if (this.ctx.getRecoverableRun(workflowId) !== recovery || recovery.auxiliaryInterruption !== pair
        || JSON.stringify(latest.retryState) !== waitingState) {
        throw new Error("original private Reviewer recovery owner changed during interruption cleanup");
      }
      if (!confirmed) throw new Error("Original private Reviewer turn interruption is unconfirmed; no model continuation was sent");
      if (latest.retryState?.interruption) {
        const saved = await this.ctx.store.update(workflowId, (current) => {
          assertReviewerRecovery(recovery.reviewerIdentity!, current);
          if (recovery.reviewCheckpoint) assertForegroundReviewCheckpoint(recovery.reviewCheckpoint, current, recovery);
          if (this.ctx.isStopping() || this.ctx.getRecoverableRun(workflowId) !== recovery
            || JSON.stringify(current.retryState) !== waitingState) throw new Error("original private Reviewer recovery owner changed before confirmation was saved");
          delete current.retryState!.interruption;
        }, { ignoreCancelled: false });
        recovery.state = saved.record.retryState!;
      }
      recovery.auxiliaryInterruption = undefined;
      recovery.auxiliaryInterruptionOwner = undefined;
    }
    if (recovery.interruptionTurnId) {
      const record = await this.ctx.owned(workflowId, exec);
      exec.signal.throwIfAborted();
      if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
      const interrupted = await this.ctx.interruptReviewerTurn(recovery.threadId, recovery.interruptionTurnId, recovery.threadOwner);
      const latest = await this.ctx.owned(workflowId, exec);
      assertReviewerRunIdentity(recovery.reviewerIdentity, latest);
      if (latest.cwd !== record.cwd || latest.task !== record.task || latest.createdAt !== record.createdAt
        || latest.reviewAttempt !== record.reviewAttempt) throw new Error("original Reviewer scope changed during interruption cleanup");
      if (latest.phase === "cancelled" || this.ctx.isStopping()) return latest;
      assertReviewerRecovery(recovery.reviewerIdentity, latest);
      if (recovery.reviewCheckpoint) assertForegroundReviewCheckpoint(recovery.reviewCheckpoint, latest, recovery);
      if (this.ctx.getRecoverableRun(workflowId) !== recovery || latest.cwd !== record.cwd
        || latest.reviewAttempt !== record.reviewAttempt || latest.processState !== "waiting"
        || latest.retryState?.stage !== "reviewing") throw new Error("original Reviewer recovery owner changed during interruption cleanup");
      if (!interrupted) throw new Error("Original Reviewer turn interruption is unconfirmed; no model continuation was sent");
      if (latest.retryState?.interruption) {
        const waitingState = JSON.stringify(latest.retryState);
        const confirmed = await this.ctx.store.update(workflowId, (current) => {
          assertReviewerRecovery(recovery.reviewerIdentity!, current);
          if (this.ctx.isStopping() || this.ctx.getRecoverableRun(workflowId) !== recovery
            || JSON.stringify(current.retryState) !== waitingState) {
            throw new Error("original Reviewer recovery owner changed before interruption confirmation was saved");
          }
          // A caller abort after the real ACK does not undo physical cleanup.
          // Save that fact before restoring an unstarted continuation handle.
          delete current.retryState!.interruption;
        }, { ignoreCancelled: false });
        recovery.state = confirmed.record.retryState!;
      }
      recovery.interruptionTurnId = undefined;
      if (recovery.pendingStart?.operation.finished()) {
        await this.ctx.confirmReviewerTerminalCleanup?.(workflowId, recovery);
        this.ctx.clearRecoverableRun(workflowId);
        recovery.pendingStart = undefined;
        recovery.state.awaitingStartReceipt = undefined;
      }
    }
    if (!recovery.pendingStart) this.ctx.clearRecoverableRun(workflowId);
    return this.run(workflowId, recovery.input, exec, recovery, instruction, recovery.reviewerIdentity);
  }

  private async finishTerminalCleanup(workflowId: string, recovery: RecoverableWorkflowRun,
    exec: ToolRunContext): Promise<WorkflowRecord> {
    const confirmed = await this.ctx.confirmReviewerTerminalCleanup?.(workflowId, recovery) ?? false;
    if (!confirmed) return this.ctx.owned(workflowId, exec);
    if (this.ctx.getRecoverableRun(workflowId) !== recovery) {
      throw new Error("original Reviewer terminal cleanup owner changed; no model continuation was sent");
    }
    const terminalFailure = recovery.terminalFailure ?? recovery.pendingStart?.message ?? "Original Reviewer cancelled";
    // Claim synchronously after the actual ACK. Even if the business scope
    // drifted, this owner must release its now-ended original resources.
    this.ctx.clearRecoverableRun(workflowId);
    let committed = false;
    try {
      try {
        const latest = await this.ctx.owned(workflowId, exec);
        if (latest.phase === "cancelled") {
          if (recovery.pendingStart) return (await this.ctx.store.update(workflowId, (r) => {
            assertReviewerRunIdentity(recovery.reviewerIdentity!, r);
            if (r.phase !== "cancelled") throw new Error("Original cancelled Reviewer phase changed");
            r.processState = "cancelled"; r.retryState = undefined;
          }, { ignoreCancelled: true })).record;
          return latest;
        }
        assertReviewerRecovery(recovery.reviewerIdentity!, latest);
        if (JSON.stringify(latest.retryState) !== JSON.stringify(recovery.state)) throw new Error("original Reviewer terminal record changed during cleanup");
        const failed = await this.ctx.store.update(workflowId, (record) => {
          exec.signal.throwIfAborted();
          assertReviewerRecovery(recovery.reviewerIdentity!, record);
          if (JSON.stringify(record.retryState) !== JSON.stringify(recovery.state)) throw new Error("original Reviewer terminal record changed before finalization");
          record.processState = "failed";
          record.retryState = undefined;
          record.reviewFailureReason = "original_reviewer_unavailable";
          record.activeTurnId = undefined;
          record.error = terminalFailure;
          record.lastProgressAt = new Date().toISOString();
          record.lastProgressMessage = "Review terminated; its original turn cleanup was confirmed";
        }, { ignoreCancelled: false });
        committed = !failed.suppressed;
      } catch (error) {
        this.ctx.reportCleanupNote(workflowId, `Original Reviewer terminal finalization was not committed: ${this.ctx.errorMessage(error)}`);
      }
    } finally {
      try {
        try { recovery.child?.finish(terminalFailure, "failed"); }
        catch (error) { this.ctx.reportCleanupNote(workflowId, `Terminal Reviewer display cleanup failed: ${this.ctx.errorMessage(error)}`); }
        try { await this.ctx.disposeChildSession(workflowId, recovery.child); }
        catch (error) { this.ctx.reportCleanupNote(workflowId, `Terminal Reviewer child cleanup failed: ${this.ctx.errorMessage(error)}`); }
      } finally {
        try { this.ctx.reportCleanupNote(workflowId, await this.ctx.releaseReviewerSubscription(recovery.threadId, recovery.threadOwner)); }
        catch (error) { this.ctx.reportCleanupNote(workflowId, `Terminal Reviewer subscription cleanup failed: ${this.ctx.errorMessage(error)}`); }
        finally { this.ctx.turnGateway.endRound(); }
      }
    }
    if (committed) {
      try { await this.ctx.flushCleanupNotes(workflowId, { dshSessionId: recovery.reviewerIdentity!.dshSessionId,
        reviewAttempt: recovery.reviewerIdentity!.reviewAttempt, cwd: recovery.reviewerIdentity!.cwd,
        evidenceFingerprint: recovery.evidence?.fingerprint }); }
      catch (error) { this.ctx.reportCleanupNote(workflowId, `Terminal Reviewer cleanup diagnostic was not committed: ${this.ctx.errorMessage(error)}`); }
    }
    throw new Error(terminalFailure);
  }

  private async waitForContinuation(
    threadOwner: object | undefined,
    workflowId: string,
    priorPhase: WorkflowPhase,
    threadId: string,
    child: CodexChildSessionHandle | undefined,
    input: ReviewInput,
    evidence: import("../types.js").ReviewEvidence,
    reason: string,
    ownsAttempt: (record: WorkflowRecord) => boolean,
    settings: ReviewerRunSettings,
    interruptionTurnId?: string,
    originalProcessId?: number,
    originalProcessIds?: readonly number[],
    checkpoint?: ForegroundReviewCheckpoint,
    automaticContinuations: 0 | 1 = 0,
    auxiliaryInterruption?: { threadId: string; turnId: string },
    terminalFailure?: string,
    auxiliaryInterruptionOwner?: RetainedAuxiliaryTurn,
    terminalRun?: RecoverableWorkflowRun,
    originalProcessIdentities?: readonly ProcessInstanceIdentity[],
  ): Promise<WorkflowRecord> {
    child?.failAttempt(reason);
    const state: WorkflowRetryState = { stage: "reviewing", reason, attempts: 1, awaitingContinuation: true,
      ...(terminalFailure ? { awaitingCleanup: true, terminalFailure } : {}),
      ...(checkpoint ? { reviewCheckpoint: { nextStep: checkpoint.nextStep } } : {}),
      ...(interruptionTurnId || auxiliaryInterruption ? { interruption: {
        target: auxiliaryInterruption ? "auxiliary" : "reviewer",
        ...(originalProcessId === undefined ? {} : { processId: originalProcessId }),
        ...(originalProcessIds === undefined ? {} : { processIds: [...originalProcessIds] }),
        ...(originalProcessIdentities === undefined ? {} : { processIdentities: originalProcessIdentities.map((identity) => ({ ...identity })) }),
      } } : {}) };
    if (terminalFailure) {
      // The cleanup capability and its durable generation exist before the
      // waiting marker becomes visible to another Manager.
      if (!terminalRun || this.ctx.getRecoverableRun(workflowId) !== terminalRun) {
        throw new Error("original terminal Reviewer cleanup owner is unavailable");
      }
      state.terminalCleanup = terminalRun.state.terminalCleanup;
      terminalRun.state = state;
      terminalRun.reviewerIdentity = reviewerRunIdentity({ ...terminalRun.reviewerIdentity!, phase: priorPhase });
    }
    const outcome = await this.ctx.store.update(workflowId, (record) => {
      if (record.phase === "cancelled") return;
      if (!ownsAttempt(record) || record.phase !== "reviewing" || this.ctx.isStopping()) {
        throw new Error(`workflow ${workflowId} changed its review owner, attempt or evidence before continuation waiting`);
      }
      if (!this.originalThreadAvailable(threadId, threadOwner) && !interruptionTurnId && !checkpoint) {
        throw new Error("original Reviewer thread is unavailable; no replacement will be started");
      }
      record.phase = priorPhase;
      record.processState = "waiting";
      record.retryState = state;
      record.reviewFailureReason = undefined;
      record.activeTurnId = undefined;
      record.error = reason;
      record.lastProgressAt = new Date().toISOString();
      record.lastProgressMessage = terminalFailure
        ? "Review terminated; waiting for the original turn cleanup confirmation without another model call"
        : "Review failed; the same Reviewer session is waiting for continuation";
    }, { ignoreCancelled: false });
    if (!outcome.suppressed && !terminalRun) this.ctx.setRecoverableRun(workflowId, { state, threadId, threadOwner, child, input, evidence,
      reviewerIdentity: reviewerRunIdentity(outcome.record),
      reviewerSettings: settings,
      ...(terminalFailure ? { terminalFailure } : {}),
      ...(interruptionTurnId || auxiliaryInterruption ? { originalProcessId, originalProcessIds, originalProcessIdentities } : {}),
      ...(checkpoint ? { reviewCheckpoint: checkpoint } : {}), automaticContinuations,
      ...(interruptionTurnId ? { interruptionTurnId } : {}),
      ...(auxiliaryInterruption ? { auxiliaryInterruption, auxiliaryInterruptionOwner } : {}) });
    return outcome.record;
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
