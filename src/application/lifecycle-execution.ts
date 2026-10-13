import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowStore } from "../store.js";
import { assertPlannerRun, assertPlannerRunIdentity } from "./planner-run-identity.js";
import { assertPlannerRunCheckpoint } from "./planner-run-checkpoint.js";
import { assertReviewerRecovery } from "./reviewer-run-identity.js";
import type { CodexCallback } from "../workflow.js";
import type { ReviewEvidence, WorkflowContinuationStatus, WorkflowRecord, WorkflowStatus, WorkflowTerminalCleanupMarker } from "../types.js";
import { submissionTerminal } from "../workflow.js";
import type { RecoverableWorkflowRun, WorkflowRuntimeState } from "./workflow-runtime-state.js";
import type { CodexChildSessionHandle } from "../codex-child-session.js";
import { ReviewObservation } from "./review-observation.js";
import { TurnGateway } from "./app-server/turn-gateway.js";
import { bridgeReviewUnavailableReason } from "./submission-recovery-policy.js";
import { assertForegroundReviewCheckpoint } from "./foreground-review-checkpoint.js";
import { terminalCleanupTarget } from "./terminal-cleanup-guard.js";

type Agent = any;

export interface LifecycleExecutionContext {
  store: WorkflowStore;
  runtime: WorkflowRuntimeState;
  reviewObservation: ReviewObservation;
  turnGateway: TurnGateway;
  callback?: CodexCallback;
  confirmTerminalCleanup?(workflowId: string, run: RecoverableWorkflowRun): Promise<boolean>;
  releaseTerminalCleanupGuard?(workflowId: string, marker?: WorkflowTerminalCleanupMarker): void | Promise<void>;
  retainCallbackCleanup?(workflowId: string, record: WorkflowRecord): Promise<void>;
  /** Release the retained subscription without closing the shared App Server. */
  captureThreadOwner?(threadId: string): object | undefined;
  releaseRetainedThread?(threadId: string, expectedOwner?: object): Promise<unknown>;
  interruptRetainedTurn?(threadId: string, turnId: string, expectedOwner?: object): Promise<unknown>;
  cleanupAuxiliaryTurns?(workflowId?: string): Promise<void>;
  flushUsage?(workflowId?: string): Promise<void>;
  stopUsage?(): Promise<void>;
  usagePersistenceError?(workflowId: string): string | undefined;
  /** Actual manager-owned Planner execution, including its creation receipt. */
  isPlannerStarting?(workflowId: string): boolean;
  readReviewEvidence?(record: WorkflowRecord, recovery: RecoverableWorkflowRun): Promise<ReviewEvidence>;
  requireAgent(exec: ToolRunContext): Agent;
  submissionTaskKey(workflowId: string, submissionId: string): string;
}

/** Owns status, cancellation and teardown. */
export class LifecycleExecution {
  private originalThreadAvailable(threadId: string, owner?: object): boolean {
    if (this.ctx.captureThreadOwner && !owner) return false;
    return this.ctx.turnGateway.isThreadAvailable(threadId, owner);
  }

  private readonly cleanups = new Set<Promise<void>>();
  private stoppedCleanup?: Promise<void>;
  constructor(private readonly ctx: LifecycleExecutionContext) {}

  stop(): Promise<void> {
    if (this.ctx.runtime.stopPromise) {
      // The owning SDK may be shut down after the first manager stop. A
      // subsequent stop reconciles only retained terminal resources; it does
      // not restart model work or repeat already completed disposals.
      const callbackPending = [...this.ctx.runtime.codexChildSessions.keys()]
        .some((id) => this.ctx.callback?.hasPendingInterruption?.(id) || this.ctx.callback?.hasPendingTerminalCleanup?.(id));
      if (!this.stoppedCleanup && (callbackPending || this.ctx.runtime.codexChildSessions.size > 0
        || [...this.ctx.runtime.recoverableRuns.values()].some((run) => run.terminalFailure || this.hasPendingStart(run)))) {
        const task = this.ctx.runtime.stopPromise.then(async () => {
          await this.ctx.callback?.stop();
          await Promise.all([...this.ctx.runtime.recoverableRuns].filter(([, run]) => run.terminalFailure || this.hasPendingStart(run))
            .map(([id, run]) => this.cleanupTerminalRun(id, run, "Terminal cleanup after plugin stop")));
          for (const id of this.ctx.runtime.codexChildSessions.keys()) this.takeChild(id, "Reviewer cleanup after plugin stop");
          await Promise.allSettled([...this.cleanups]);
        });
        this.stoppedCleanup = task;
        void task.finally(() => { if (this.stoppedCleanup === task) this.stoppedCleanup = undefined; }).catch(() => undefined);
      }
      return this.stoppedCleanup ?? this.ctx.runtime.stopPromise;
    }
    const task = this.doStop();
    this.ctx.runtime.stopPromise = task;
    return task;
  }
  private async doStop(): Promise<void> {
    if (this.ctx.runtime.stopped) return;
    this.ctx.runtime.stopped = true;
    this.ctx.reviewObservation.stopAllHeartbeats();
    this.ctx.runtime.submissionReviewResults.clear();
    this.ctx.runtime.lifecycleController.abort();
    for (const controller of this.ctx.runtime.resumeControllers.values()) controller.abort(new Error("plugin teardown"));
    for (const controller of this.ctx.runtime.inputControllers.values()) controller.abort(new Error("plugin teardown"));
    for (const controller of this.ctx.runtime.reviewControllers?.values() ?? []) controller.abort(new Error("plugin teardown"));
    for (const controller of this.ctx.runtime.submissionControllers.values()) controller.abort();
    // Claim parked resources synchronously before the first await. Cancel and
    // stop may overlap, but only the caller removing the handle owns cleanup.
    for (const workflowId of this.ctx.runtime.recoverableRuns.keys()) {
      this.takeRetainedRun(workflowId, "Codex continuation stopped with the plugin");
    }
    for (const workflowId of this.ctx.runtime.plannerInputs.keys()) {
      this.takeRetainedRun(workflowId, "Planner clarification stopped with the plugin");
    }
    // Interrupt every ACTIVE foreground turn (visible Planner/Reviewer or
    // ephemeral normalization fork) so the foreground tool flows settle via
    // their own abort/interrupt paths instead of timing out into a closed
    // store. Background Reviewer turns are interrupted by callback.stop().
    for (const active of this.ctx.runtime.activeTurns.values()) {
      if (this.ctx.captureThreadOwner && !active.threadOwner) continue;
      void this.ctx.turnGateway.interrupt(active.threadId, active.turnId, undefined, active.threadOwner).catch(() => undefined);
    }
    const foreground = [...this.ctx.runtime.foreground];
    const callbackStop = this.ctx.callback?.stop();
    const chain = this.ctx.runtime.recoveryChain;
    this.ctx.runtime.recoveryChain = undefined;
    if (chain) await chain.catch(() => undefined);
    // Wait for EVERY manager-owned task to settle (foreground tool flows AND
    // background recovery-derived tasks; they observe the abort and the
    // interrupts and stop writing/enqueueing/spawning).
    const tasks = [...this.ctx.runtime.backgroundTasks];
    await Promise.allSettled([...tasks, ...foreground]);
    await callbackStop;
    await this.ctx.cleanupAuxiliaryTurns?.();
    // A foreground operation may have parked just as teardown began.
    for (const workflowId of this.ctx.runtime.recoverableRuns.keys()) {
      this.takeRetainedRun(workflowId, "Codex continuation stopped with the plugin");
    }
    for (const workflowId of this.ctx.runtime.plannerInputs.keys()) {
      this.takeRetainedRun(workflowId, "Planner clarification stopped with the plugin");
    }
    for (const workflowId of this.ctx.runtime.codexChildSessions.keys()) {
      this.takeChild(workflowId, "Codex conversation stopped with the plugin");
    }
    await Promise.allSettled([...this.cleanups]);
    this.ctx.reviewObservation.stopAllHeartbeats();
    this.ctx.runtime.pending.clear();
    this.ctx.runtime.activeTurns.clear();
    await this.ctx.stopUsage?.();
  }


  async status(workflowId: string | undefined, exec: ToolRunContext): Promise<WorkflowStatus> {
    const agent = this.ctx.requireAgent(exec);
    let record = workflowId ? await this.ctx.store.load(workflowId) : await this.ctx.store.activeForSession(agent.id);
    if (!record && !workflowId) {
      const retained = [...this.ctx.runtime.recoverableRuns].find(([, run]) => (run.terminalFailure || this.hasPendingStart(run))
        && (run.plannerIdentity?.dshSessionId ?? run.reviewerIdentity?.dshSessionId) === agent.id);
      if (retained) record = await this.ctx.store.load(retained[0]);
    }
    if (!record && !workflowId) record = await this.ctx.store.failedPlannerStartupForSession(agent.id);
    if (!record) throw new Error(workflowId ? `unknown workflow ${workflowId}` : "no active Codex workflow for this session");
    if (record.dshSessionId !== agent.id) throw new Error("workflow belongs to another DSH session");
    // Drain observations only after ownership is established. Persisted
    // history remains available when the original process is already gone.
    await this.ctx.flushUsage?.(record.id);
    record = await this.ctx.store.load(record.id) ?? record;
    if (record.dshSessionId !== agent.id) throw new Error("workflow belongs to another DSH session");
    // Old records have no observability fields. Hydrate a safe baseline from
    // their durable updatedAt and immediately classify an abandoned review as
    // stale; status remains read-safe and never exposes model output.
    if (!record.processState && record.phase === "reviewing") {
      const baseline = record.updatedAt || new Date().toISOString();
      const hydrated = await this.ctx.store.update(record.id, (current) => {
        if (current.processState) return;
        current.processState = "running";
        current.reviewStep = "reviewing";
        current.reviewStartedAt = current.reviewStartedAt ?? baseline;
        current.lastProgressAt = current.lastProgressAt ?? baseline;
        current.reviewAttempt = current.reviewAttempt ?? 1;
        current.reviewElapsedMs = current.reviewElapsedMs ?? 0;
        current.lastProgressMessage = current.lastProgressMessage ?? "Review status recovered after restart";
      }, { ignoreCancelled: true });
      record = hydrated.record;
    }
    record = await this.ctx.reviewObservation.refreshStale(record);
    if (!record.processState && ["passed", "blocked", "waiting_review_decision"].includes(record.phase)) {
      record = { ...record, processState: "completed" };
    } else if (!record.processState && record.phase === "cancelled") {
      record = { ...record, processState: "cancelled" };
    } else if (!record.processState && record.phase === "failed") {
      record = { ...record, processState: "failed" };
    }
    const capability = await this.verifyReviewerEvidence(record, agent.id);
    record = capability.record;
    // Whether a Reviewer turn is currently executing. Provsional per-message
    // JSON is never surfaced; `latestReview` only ever holds an applied verdict.
    // A live Reviewer turn is reported by the callback dispatcher (accurate even
    // during retry backoff / verdict delivery / terminal states), by the
    // in-process active-turn mapping (visible Reviewer turns AND ephemeral
    // conversion forks), or by the DSH-led reviewing phase as the fallback when
    // no dispatcher is injected.
    const reviewerActive =
      this.ctx.callback?.activeReview?.(record.id) === true
      || this.ctx.runtime.activeTurns.get(record.id)?.kind === "reviewer"
      || [...this.ctx.runtime.auxiliaryTurns.values()].some((turn) => turn.workflowId === record.id)
      || (record.processState === "running" && record.phase === "reviewing" && Boolean(record.reviewerTurnId));
    const tokenUsage = this.originalThreadUsage(record);
    const usagePersistenceError = this.ctx.usagePersistenceError?.(record.id);
    return { ...record, reviewerActive, continuation: capability.continuation, ...(tokenUsage ? { tokenUsage } : {}),
      ...(usagePersistenceError ? { usagePersistenceError } : {}) };
  }

  private async verifyReviewerEvidence(record: WorkflowRecord, owner: string): Promise<{ record: WorkflowRecord; continuation: WorkflowContinuationStatus }> {
    const continuation = this.continuationStatus(record);
    const recovery = this.ctx.runtime.recoverableRuns.get(record.id);
    if (!continuation.available || recovery?.state.stage !== "reviewing") return { record, continuation };
    const fingerprint = recovery.evidence?.fingerprint;
    if (!fingerprint || recovery.evidence?.insufficient || !this.ctx.readReviewEvidence) {
      return { record, continuation: { available: false, reason: "evidence_unavailable" } };
    }
    let evidence: ReviewEvidence | undefined;
    try { evidence = await this.ctx.readReviewEvidence(record, recovery); }
    catch { /* Report inability to inspect; keep the original waiting resources. */ }
    const latest = await this.ctx.store.load(record.id);
    if (!latest) throw new Error(`unknown workflow ${record.id}`);
    if (latest.dshSessionId !== owner) throw new Error("workflow belongs to another DSH session");
    const current = this.continuationStatus(latest);
    if (!current.available) return { record: latest, continuation: current };
    // A completed resume may have parked a different handle while this scan
    // was waiting. Evidence captured for the old handle cannot authorize it.
    if (this.ctx.runtime.recoverableRuns.get(record.id) !== recovery || !evidence?.fingerprint
      || evidence.insufficient || evidence.kind !== recovery.evidence?.kind) {
      return { record: latest, continuation: { available: false, reason: "evidence_unavailable" } };
    }
    return { record: latest, continuation: evidence.fingerprint === fingerprint
      ? current : { available: false, reason: "workspace_changed" } };
  }

  private originalThreadUsage(record: WorkflowRecord): WorkflowStatus["tokenUsage"] {
    if (this.ctx.runtime.stopped || ["passed", "blocked", "failed", "cancelled"].includes(record.phase)
      || ["failed", "cancelled", "completed"].includes(record.processState ?? "")) return;
    const active = this.ctx.runtime.activeTurns.get(record.id);
    if (active?.internal) return;
    const recovery = this.ctx.runtime.recoverableRuns.get(record.id);
    const waitingReviewer = ["executing", "fixing"].includes(record.phase) && record.processState === "waiting"
      && record.retryState?.stage === "reviewing" && record.retryState.awaitingContinuation === true
      && recovery?.state.stage === "reviewing" && recovery.state.awaitingContinuation === true;
    const callbackUsage = record.origin === "codex_bridge" && submissionActive(record.submissionState)
      ? this.ctx.callback?.getOriginalThreadUsage?.(record.id) : undefined;
    if (callbackUsage) return {
      source: "app_server", scope: "current_original_thread", stage: "reviewing",
      total: { ...callbackUsage.total }, last: { ...callbackUsage.last },
      ...(callbackUsage.modelContextWindow === undefined ? {} : { modelContextWindow: callbackUsage.modelContextWindow }),
    };
    if (!["planning", "reviewing"].includes(record.phase) && !waitingReviewer) return;
    const threadId = active?.threadId ?? recovery?.threadId;
    if (!threadId) return;
    if (this.ctx.captureThreadOwner && !this.originalThreadAvailable(threadId, active?.threadOwner ?? recovery?.threadOwner)) return;
    const usage = this.ctx.turnGateway.getThreadTokenUsage(threadId);
    if (!usage || usage.threadId !== threadId
      || (!this.ctx.captureThreadOwner && !this.originalThreadAvailable(threadId, active?.threadOwner ?? recovery?.threadOwner))) return;
    return {
      source: "app_server", scope: "current_original_thread",
      stage: active ? (active.kind === "planner" ? "planning" : "reviewing") : recovery!.state.stage,
      total: { ...usage.total }, last: { ...usage.last },
      ...(usage.modelContextWindow === undefined ? {} : { modelContextWindow: usage.modelContextWindow }),
    };
  }

  private continuationStatus(record: WorkflowRecord): WorkflowContinuationStatus {
    let recovery = this.ctx.runtime.recoverableRuns.get(record.id);
    if (recovery?.metadataOnly && recovery.pendingStart?.operation.finished()
      && !recovery.pendingStartIntent && !recovery.terminalFailure) {
      this.ctx.runtime.recoverableRuns.delete(record.id);
      this.ctx.releaseTerminalCleanupGuard?.(record.id, recovery.state.terminalCleanup);
      recovery = undefined;
    }
    const callbackStart = this.ctx.callback?.getPendingStartReceipt?.(record.id);
    const pendingStart = recovery?.pendingStart ?? callbackStart?.pendingStart;
    if (!recovery?.metadataOnly && (record.retryState?.awaitingStartReceipt || pendingStart)) {
      if (!pendingStart) return { available: false, reason: "handle_unavailable" };
      const status = pendingStart.operation.status();
      if (status === "pending") return { available: false, reason: "start_receipt_pending" };
      if (status === "invalid") return { available: false, reason: "start_receipt_invalid" };
      if (status === "unavailable") return { available: false, reason: "thread_unavailable" };
    }
    if (record.retryState?.awaitingCleanup || recovery?.terminalFailure || recovery?.pendingStartIntent
      || this.ctx.callback?.hasPendingTerminalCleanup?.(record.id)) {
      return { available: false, reason: "interruption_unconfirmed" };
    }
    if (record.phase === "cancelled" || record.processState === "cancelled") {
      return { available: false, reason: "cancelled" };
    }
    if (this.ctx.runtime.stopped) return { available: false, reason: "stopped" };
    const originalUnavailable = bridgeReviewUnavailableReason(record);
    if (["passed", "blocked", "failed"].includes(record.phase) && !originalUnavailable) {
      return { available: false, reason: "not_waiting" };
    }
    if (this.ctx.isPlannerStarting?.(record.id)) return { available: false, reason: "running" };
    if (this.ctx.runtime.resumeFlights.has(record.id)
      || this.ctx.runtime.inputFlights.has(record.id)
      || this.ctx.runtime.reviewFlights?.has(record.id) === true
      || (record.phase !== "waiting_input" && this.ctx.runtime.activeTurns.has(record.id))
      || this.ctx.callback?.activeReview?.(record.id) === true) {
      return { available: false, reason: "running" };
    }
    if (originalUnavailable) return { available: false, reason: originalUnavailable };
    if (callbackStart && record.origin === "codex_bridge") {
      return this.ctx.callback?.availableContinuation?.(record.id) === true
        ? { available: true } : { available: false, reason: "handle_unavailable" };
    }
    if (record.reviewFailureReason === "original_reviewer_unavailable") return { available: false, reason: "thread_unavailable" };
    if (record.reviewFailureReason === "review_contract_conflict") return { available: false, reason: "review_contract_conflict" };
    if (["passed", "blocked", "failed"].includes(record.phase)) return { available: false, reason: "not_waiting" };
    if (record.processState !== "waiting" || !record.retryState?.awaitingContinuation) {
      return { available: false, reason: "not_waiting" };
    }
    if (!recovery) return { available: false, reason: "handle_unavailable" };
    if (recovery.state.stage === "planning") {
      if (!recovery.plannerIdentity) return { available: false, reason: "handle_unavailable" };
      if (record.retryState.plannerCheckpoint && !recovery.plannerCheckpoint) return { available: false, reason: "handle_unavailable" };
      try { assertPlannerRun(recovery.plannerIdentity, record); }
      catch { return { available: false, reason: "identity_changed" }; }
      if (recovery.plannerCheckpoint) {
        try { assertPlannerRunCheckpoint(recovery.plannerCheckpoint, record); }
        catch { return { available: false, reason: "identity_changed" }; }
      }
    } else {
      if (!recovery.reviewerIdentity || !recovery.reviewerSettings) return { available: false, reason: "handle_unavailable" };
      if (record.retryState.reviewCheckpoint && !recovery.reviewCheckpoint) return { available: false, reason: "handle_unavailable" };
      try { assertReviewerRecovery(recovery.reviewerIdentity, record); }
      catch { return { available: false, reason: "identity_changed" }; }
      if (recovery.reviewCheckpoint) {
        try { assertForegroundReviewCheckpoint(recovery.reviewCheckpoint, record, recovery); }
        catch { return { available: false, reason: "identity_changed" }; }
      }
    }
    if (!this.originalThreadAvailable(pendingStart?.operation.sourceThreadId ?? recovery.threadId,
      pendingStart ? pendingStart.operation.sourceThreadOwner : recovery.threadOwner)) {
      return { available: false, reason: "thread_unavailable" };
    }
    if (recovery.interruptionTurnId || recovery.auxiliaryInterruption) return { available: false, reason: "interruption_unconfirmed" };
    return { available: true };
  }

  /**
   * Cancel is the only writer allowed to flip any state to cancelled. The
   * phase flip and the read of the currently known active turn happen in one
   * atomic update; the interrupt afterwards is best-effort and a failure keeps
   * the workflow cancelled. All other writers suppress themselves once the
   * record is cancelled, so cancelled is terminal.
   *
   * The interrupt targets the in-process ACTIVE turn (visible or ephemeral)
   * whenever one is registered: an active ephemeral conversion-fork turn is
   * interrupted on the FORK thread/turn pair, so an ephemeral turnId can never
   * be mispaired with a persistent threadId. Only when nothing is active does
   * cancel fall back to the persisted planner/reviewer pair.
   */

  async cancel(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const agent = this.ctx.requireAgent(exec);
    const active = this.ctx.runtime.activeTurns.get(workflowId);
    let target: { threadId: string; turnId: string; threadOwner?: object } | undefined;
    const outcome = await this.ctx.store.update(workflowId, (r) => {
      if (r.dshSessionId !== agent.id) throw new Error("workflow belongs to another DSH session");
      const waiting = this.ctx.runtime.recoverableRuns.get(workflowId);
      if (this.hasPendingStart(waiting)) {
        waiting!.pendingStartIntent = "cancel";
        r.retryState ??= { ...waiting!.state };
      } else if (!active && !waiting && !this.ctx.runtime.plannerInputs.has(workflowId)
        && r.phase === "planning" && this.ctx.isPlannerStarting?.(workflowId)) {
        // The producer still owns the unknown start/creation boundary. This
        // marker claims no remote turn and survives cancelled-row filtering.
        r.retryState = { stage: "planning", reason: "Cancelled while the original start receipt is pending", attempts: 1,
          awaitingContinuation: false, awaitingStartReceipt: true };
      }
      if (!active) {
        // New Planner/Reviewer ids are ephemeral and never persisted. Legacy
        // ids remain diagnostic only, so cancellation never resumes or
        // interrupts a historical Desktop task. A genuinely running turn is
        // always represented by the in-process active-turn map.
      }
      r.phase = "cancelled";
      r.submissionReviewPending = undefined;
      if (!this.ctx.runtime.recoverableRuns.get(workflowId)?.terminalFailure
        && !this.hasPendingStart(this.ctx.runtime.recoverableRuns.get(workflowId))
        && !r.retryState?.awaitingStartReceipt && !this.ctx.callback?.hasPendingTerminalCleanup?.(workflowId)) r.retryState = undefined;
      r.processState = r.retryState?.awaitingStartReceipt ? "waiting" : "cancelled";
      r.activeTurnId = undefined;
      r.lastProgressAt = new Date().toISOString();
      r.lastProgressMessage = "Review cancelled";
      if (r.reviewStartedAt) {
        const started = Date.parse(r.reviewStartedAt);
        if (Number.isFinite(started)) r.reviewElapsedMs = Math.max(0, Date.now() - started);
      }
      if (r.submissionId && !submissionTerminal(r.submissionState)) {
        // Terminate the in-flight submission so no callback state may regress.
        r.submissionState = "failed";
        r.submissionError = "workflow cancelled";
        r.callbackState = "failed";
      }
    }, { ignoreCancelled: true });
    this.ctx.reviewObservation.stopCurrentHeartbeat(workflowId);
    this.ctx.runtime.submissionReviewResults.delete(workflowId);
    this.ctx.runtime.resumeControllers.get(workflowId)?.abort(new Error("workflow cancelled"));
    this.ctx.runtime.inputControllers.get(workflowId)?.abort(new Error("workflow cancelled"));
    this.ctx.runtime.reviewControllers?.get(workflowId)?.abort(new Error("workflow cancelled"));
    const inputInterrupted = this.takeRetainedRun(workflowId, "Codex continuation cancelled", "cancel");
    this.takeChild(workflowId, "Codex conversation cancelled");
    if (active && !inputInterrupted) target = { threadId: active.threadId, turnId: active.turnId, threadOwner: active.threadOwner };
    if (target && (!this.ctx.captureThreadOwner || target.threadOwner)) {
      await this.ctx.turnGateway.interrupt(target.threadId, target.turnId, exec.signal, target.threadOwner).catch(() => undefined);
    }
    // Cancel the active Reviewer operation, if any; cancelled is terminal for it too.
    if (outcome.record.submissionId) {
      this.ctx.runtime.submissionControllers
        .get(this.ctx.submissionTaskKey(workflowId, outcome.record.submissionId))
        ?.abort();
    }
    this.ctx.callback?.cancel(workflowId);
    if (this.ctx.callback?.hasPendingTerminalCleanup?.(workflowId)) {
      await this.ctx.retainCallbackCleanup?.(workflowId, outcome.record);
    } else this.takeChild(workflowId, "Codex conversation cancelled");
    await this.ctx.cleanupAuxiliaryTurns?.(workflowId);
    await Promise.allSettled([...this.cleanups]);
    await this.ctx.flushUsage?.(workflowId);
    return outcome.record;
  }

  private hasPendingStart(run: RecoverableWorkflowRun | undefined): boolean {
    return Boolean(run?.pendingStart || run?.state.awaitingStartReceipt);
  }

  private ownsPendingInput(workflowId: string, run: RecoverableWorkflowRun): boolean {
    const input = this.ctx.runtime.plannerInputs.get(workflowId);
    return Boolean(input && input.child === run.child && input.plannerCheckpoint === run.plannerCheckpoint
      && input.threadId === run.threadId && input.threadOwner === run.threadOwner);
  }

  private takeRetainedRun(workflowId: string, message: string, pendingIntent: "cancel" | "terminal" = "terminal"): boolean {
    const input = this.ctx.runtime.plannerInputs.get(workflowId);
    const waiting = this.ctx.runtime.recoverableRuns.get(workflowId);
    const recovery = waiting ?? input;
    if (!recovery) return false;
    if (waiting && (waiting.terminalFailure || this.hasPendingStart(waiting))) {
      if (this.hasPendingStart(waiting)) waiting.pendingStartIntent ??= pendingIntent;
      this.trackCleanup(() => this.cleanupTerminalRun(workflowId, waiting, message));
      return !waiting.metadataOnly || this.ownsPendingInput(workflowId, waiting);
    }
    const interruptTurnId = input?.pending?.turnId ?? waiting?.interruptionTurnId;
    this.ctx.runtime.recoverableRuns.delete(workflowId);
    this.ctx.runtime.plannerInputs.delete(workflowId);
    this.ctx.runtime.pending.delete(workflowId);
    if (interruptTurnId) this.ctx.runtime.activeTurns.delete(workflowId);
    if (this.ctx.runtime.codexChildSessions.get(workflowId) === recovery.child) {
      this.ctx.runtime.codexChildSessions.delete(workflowId);
    }
    this.trackCleanup(async () => {
      try {
        if (interruptTurnId) {
          try {
            if (this.originalThreadAvailable(recovery.threadId, recovery.threadOwner)) {
              await (this.ctx.interruptRetainedTurn?.(recovery.threadId, interruptTurnId, recovery.threadOwner)
                ?? this.ctx.turnGateway.interrupt(recovery.threadId, interruptTurnId, undefined, recovery.threadOwner));
            }
          } catch { /* The original process may have exited during cancellation. */ }
        }
        await this.finishChild(recovery.child, message);
      }
      finally {
        try { await this.ctx.releaseRetainedThread?.(recovery.threadId, recovery.threadOwner); }
        catch { /* Releasing a subscription is best-effort; the pin still ends. */ }
        finally { this.ctx.turnGateway.endRound(); }
      }
    });
    return Boolean(interruptTurnId);
  }

  private takeChild(workflowId: string, message: string): void {
    if (this.ctx.runtime.recoverableRuns.get(workflowId)?.terminalFailure
      || this.hasPendingStart(this.ctx.runtime.recoverableRuns.get(workflowId))
      || (!this.ctx.runtime.activeTurns.has(workflowId) && this.ctx.isPlannerStarting?.(workflowId))
      || [...this.ctx.runtime.submissionControllers.keys()].some((key) => key.startsWith(`${workflowId}:`))
      || this.ctx.callback?.hasPendingInterruption?.(workflowId) || this.ctx.callback?.hasPendingTerminalCleanup?.(workflowId)) return;
    const child = this.ctx.runtime.codexChildSessions.get(workflowId);
    if (!child) return;
    this.ctx.runtime.codexChildSessions.delete(workflowId);
    this.trackCleanup(async () => {
      try { await this.ctx.releaseTerminalCleanupGuard?.(workflowId); }
      finally { await this.finishChild(child, message); }
    });
  }

  private async finishChild(child: CodexChildSessionHandle | undefined, message: string): Promise<void> {
    if (!child || this.ctx.runtime.disposingChildren.has(child)) return;
    this.ctx.runtime.disposingChildren.add(child);
    try { child?.finish(message, "aborted"); } catch { /* Display failure cannot strand backend ownership. */ }
    try { await child?.dispose(); } catch { /* Thread and process cleanup must still run. */ }
  }

  private async cleanupTerminalRun(workflowId: string, run: RecoverableWorkflowRun, message: string): Promise<void> {
    if (this.ctx.runtime.recoverableRuns.get(workflowId) !== run
      || !await this.ctx.confirmTerminalCleanup?.(workflowId, run)) return;
    if (this.ctx.runtime.recoverableRuns.get(workflowId) !== run) return;
    const pendingStart = this.hasPendingStart(run);
    const ownsResources = !run.metadataOnly || this.ownsPendingInput(workflowId, run);
    if (pendingStart && ownsResources) run.receiptCleanupClaimed = true;
    this.ctx.runtime.recoverableRuns.delete(workflowId);
    if (ownsResources) {
      this.ctx.runtime.plannerInputs.delete(workflowId);
      this.ctx.runtime.pending.delete(workflowId);
      this.ctx.runtime.activeTurns.delete(workflowId);
      if (this.ctx.runtime.codexChildSessions.get(workflowId) === run.child) {
        this.ctx.runtime.codexChildSessions.delete(workflowId);
      }
    }
    this.ctx.releaseTerminalCleanupGuard?.(workflowId, run.state.terminalCleanup);
    // Cleanup authority is independent of a newer business scope. Only an
    // unchanged owned row may receive terminal diagnostics or marker removal.
    const identity = run.plannerIdentity ?? run.reviewerIdentity;
    if (identity) await this.ctx.store.update(workflowId, (record) => {
      assertPlannerRunIdentity(identity, record);
      if (run.plannerCheckpoint) assertPlannerRunCheckpoint(run.plannerCheckpoint, record);
      if (run.reviewerIdentity && record.phase !== "cancelled") assertReviewerRecovery(run.reviewerIdentity, record);
      if (pendingStart ? !record.retryState?.awaitingStartReceipt
        : !record.retryState?.awaitingCleanup || record.retryState.terminalFailure !== run.terminalFailure) {
        throw new Error("terminal cleanup no longer owns the workflow marker");
      }
      const marker = record.retryState?.terminalCleanup;
      const original = run.state.terminalCleanup;
      if (marker?.token !== original?.token || marker?.epoch !== original?.epoch || marker?.sessionId !== original?.sessionId) {
        throw new Error("terminal cleanup no longer owns the original generation");
      }
      record.retryState = undefined;
      record.error = run.terminalFailure ?? (pendingStart ? run.state.reason : undefined);
      if (record.phase !== "cancelled") {
        record.processState = "failed";
        if (run.state.stage === "planning") record.phase = "failed";
        else record.reviewFailureReason = "original_reviewer_unavailable";
      } else if (pendingStart) record.processState = "cancelled";
      record.lastProgressMessage = pendingStart ? "Original start receipt operation cleanup is confirmed" : "Original terminal turn cleanup is confirmed";
    }, { ignoreCancelled: true }).catch(() => undefined);
    if (!ownsResources) return;
    try { await this.finishChild(run.child, message); }
    finally {
      const target = terminalCleanupTarget(run);
      if (target && target.threadId !== run.threadId) await this.ctx.releaseRetainedThread?.(target.threadId, run.cleanupThreadOwner ?? run.threadOwner).catch(() => undefined);
      try { await this.ctx.releaseRetainedThread?.(run.threadId, run.threadOwner); }
      catch { /* A stopped original process has no live subscription. */ }
      finally { this.ctx.turnGateway.endRound(); }
    }
  }

  private trackCleanup(operation: () => Promise<void>): void {
    const task = Promise.resolve().then(operation);
    this.cleanups.add(task);
    void task.finally(() => this.cleanups.delete(task)).catch(() => undefined);
  }

}

function submissionActive(state: WorkflowRecord["submissionState"]): boolean {
  return state !== undefined && ["queued", "sending", "waiting_verdict", "retrying", "verdict_ready", "received"].includes(state);
}
