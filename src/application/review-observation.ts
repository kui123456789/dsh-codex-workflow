import type { WorkflowStore } from "../store.js";
import type { ReviewStep, WorkflowProcessState, WorkflowRecord } from "../types.js";
import { WorkflowRuntimeState } from "./workflow-runtime-state.js";
import type { CodexReviewEndEvent, CodexWorkflowSessionEvent } from "../review-events.js";

export interface ReviewObservationOptions {
  store: WorkflowStore;
  runtime: WorkflowRuntimeState;
  heartbeatMs: number;
  staleMs: number;
  isSubmissionActive: (state: WorkflowRecord["submissionState"]) => boolean;
  emit?: (record: WorkflowRecord, event: CodexWorkflowSessionEvent) => void;
}

function ensureReviewPhase(record: WorkflowRecord, step: ReviewStep, startedAt: string): void {
  record.reviewPhaseTimings ??= {};
  const current = record.reviewPhaseTimings[step];
  if (!current || current.endedAt) record.reviewPhaseTimings[step] = { startedAt };
}

function closeReviewPhase(record: WorkflowRecord, now: Date): void {
  const step = record.reviewStep;
  if (!step) return;
  const phase = record.reviewPhaseTimings?.[step];
  if (!phase || phase.endedAt) return;
  const endedAt = now.toISOString();
  const started = Date.parse(phase.startedAt);
  record.reviewPhaseTimings![step] = {
    ...phase,
    endedAt,
    ...(Number.isFinite(started) ? { elapsedMs: Math.max(0, now.getTime() - started) } : {}),
  };
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}

function reviewStepLabel(step: ReviewStep): string {
  const labels: Record<ReviewStep, string> = {
    reviewing: "审查",
    review_native_turn: "Reviewer 回合",
    review_readback: "读取审查结果",
    review_display_rewrite: "改写审查展示",
    review_conversion: "结构化归一",
    review_alignment: "权威对齐",
    review_reconciliation: "审查和解",
    review_finalizing: "完成审查",
  };
  return labels[step];
}

/**
 * Owns durable review progress and the in-process heartbeat. Keeping this
 * state machine outside WorkflowManager makes cancellation, stale detection
 * and teardown share one implementation across DSH-led and bridge reviews.
 */
export class ReviewObservation {
  private readonly store: WorkflowStore;
  private readonly runtime: WorkflowRuntimeState;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly isSubmissionActive: ReviewObservationOptions["isSubmissionActive"];
  private readonly emit?: ReviewObservationOptions["emit"];

  constructor(options: ReviewObservationOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.heartbeatMs = Math.max(250, options.heartbeatMs);
    this.staleMs = Math.max(1_000, options.staleMs);
    this.isSubmissionActive = options.isSubmissionActive;
    this.emit = options.emit;
  }

  async begin(
    workflowId: string,
    options: { enterReviewing?: boolean; step?: ReviewStep; message?: string; childSessionId?: string } = {},
  ) {
    this.runtime.cleanupNotes.delete(workflowId);
    const now = new Date().toISOString();
    const outcome = await this.store.update(workflowId, (record) => {
      if (options.enterReviewing !== false) record.phase = "reviewing";
      record.processState = "running";
      record.reviewStep = options.step ?? "reviewing";
      record.reviewStartedAt = now;
      record.lastProgressAt = now;
      record.reviewAttempt = (record.reviewAttempt ?? 0) + 1;
      record.reviewElapsedMs = 0;
      record.reviewPhaseTimings = { [record.reviewStep]: { startedAt: now } };
      record.activeTurnId = undefined;
      record.lastProgressMessage = options.message ?? "Review started";
    }, { ignoreCancelled: false });
    if (!outcome.suppressed) {
      this.startHeartbeat(workflowId);
      const reviewId = `${workflowId}:${outcome.record.reviewAttempt ?? 1}`;
      this.emit?.(outcome.record, {
        type: "dsh-codex-workflow/review-start",
        data: {
          workflowId, reviewId, attempt: outcome.record.reviewAttempt ?? 1,
          ...(options.childSessionId ? { childSessionId: options.childSessionId } : {}),
          startedAt: now, mode: outcome.record.mode === "review_only" ? "review_only" : outcome.record.origin === "codex_bridge" ? "bridge" : "planned",
        },
      });
    }
    return outcome;
  }

  startHeartbeat(workflowId: string): void {
    this.stopHeartbeat(workflowId);
    const timer = setInterval(() => {
      void this.mark(workflowId).catch(() => undefined);
    }, this.heartbeatMs);
    timer.unref();
    this.runtime.reviewHeartbeats.set(workflowId, timer);
  }

  stopHeartbeat(workflowId: string): void {
    const timer = this.runtime.reviewHeartbeats.get(workflowId);
    if (timer) clearInterval(timer);
    this.runtime.reviewHeartbeats.delete(workflowId);
  }

  async mark(
    workflowId: string,
    step?: ReviewStep,
    message?: string,
    activeTurnId?: string | null,
  ): Promise<WorkflowRecord | undefined> {
    const now = new Date();
    const iso = now.toISOString();
    const outcome = await this.store.update(workflowId, (record) => {
      if (record.processState !== "running") return;
      const nextStep = step ?? record.reviewStep;
      if (step && record.reviewStep !== step) {
        closeReviewPhase(record, now);
        record.reviewStep = step;
      }
      if (nextStep) ensureReviewPhase(record, nextStep, iso);
      record.lastProgressAt = iso;
      if (record.reviewStartedAt) {
        const started = Date.parse(record.reviewStartedAt);
        if (Number.isFinite(started)) record.reviewElapsedMs = Math.max(0, now.getTime() - started);
      }
      if (activeTurnId !== undefined) record.activeTurnId = activeTurnId ?? undefined;
      if (message) record.lastProgressMessage = message;
      else if (record.reviewStep && record.reviewElapsedMs !== undefined) {
        record.lastProgressMessage = `${reviewStepLabel(record.reviewStep)} · 已用时 ${formatElapsed(record.reviewElapsedMs)}`;
      }
    }, { ignoreCancelled: false });
    if (!outcome.suppressed) {
      const reviewId = `${workflowId}:${outcome.record.reviewAttempt ?? 1}`;
      this.emit?.(outcome.record, {
        type: "dsh-codex-workflow/review-progress",
        data: { workflowId, reviewId, step: outcome.record.reviewStep, processState: outcome.record.processState ?? "running", message: outcome.record.lastProgressMessage, elapsedMs: outcome.record.reviewElapsedMs, at: iso },
      });
    }
    return outcome.record;
  }

  async finish(workflowId: string, fallbackState?: WorkflowProcessState, detail?: Pick<CodexReviewEndEvent, "verdict" | "result" | "visibleText" | "summary" | "error">): Promise<void> {
    this.stopHeartbeat(workflowId);
    const now = new Date();
    const iso = now.toISOString();
    const outcome = await this.store.update(workflowId, (record) => {
      if (record.processState !== "running") return;
      const terminalState: WorkflowProcessState = record.phase === "cancelled"
        ? "cancelled"
        : fallbackState
          ?? (this.isSubmissionActive(record.submissionState)
            ? "waiting"
            : record.phase === "reviewing" || record.phase === "executing" || record.phase === "fixing"
              ? "failed"
              : "completed");
      record.processState = terminalState;
      record.activeTurnId = undefined;
      record.lastProgressAt = iso;
      if (record.reviewStartedAt) {
        const started = Date.parse(record.reviewStartedAt);
        if (Number.isFinite(started)) record.reviewElapsedMs = Math.max(0, now.getTime() - started);
      }
      closeReviewPhase(record, now);
      record.lastProgressMessage = terminalState === "completed"
        ? "Review completed"
        : terminalState === "waiting"
          ? "Review waiting for retry or verdict delivery"
          : terminalState === "cancelled"
            ? "Review cancelled"
            : terminalState === "stale"
              ? "Review heartbeat became stale"
              : "Review failed; retry is available";
    }, { ignoreCancelled: true }).catch(() => undefined);
    if (outcome && !outcome.suppressed) {
      const reviewId = `${workflowId}:${outcome.record.reviewAttempt ?? 1}`;
      this.emit?.(outcome.record, {
        type: "dsh-codex-workflow/review-end",
        data: { workflowId, reviewId, processState: outcome.record.processState ?? "failed", finishedAt: iso, ...detail },
      });
    }
  }

  async refreshStale(record: WorkflowRecord): Promise<WorkflowRecord> {
    if (record.processState !== "running" || !record.lastProgressAt) return record;
    const age = Date.now() - Date.parse(record.lastProgressAt);
    if (!Number.isFinite(age) || age <= this.staleMs) return record;
    const outcome = await this.store.update(record.id, (current) => {
      if (current.processState !== "running" || current.lastProgressAt !== record.lastProgressAt) return;
      current.processState = "stale";
      current.activeTurnId = undefined;
      current.lastProgressMessage = `No Review heartbeat for ${Math.floor(age / 1000)} seconds`;
    }, { ignoreCancelled: true });
    this.stopHeartbeat(record.id);
    return outcome.record;
  }
}
