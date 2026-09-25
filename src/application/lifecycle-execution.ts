import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { WorkflowStore } from "../store.js";
import type { CodexCallback } from "../workflow.js";
import type { WorkflowRecord } from "../types.js";
import { submissionTerminal } from "../workflow.js";
import type { WorkflowRuntimeState } from "./workflow-runtime-state.js";
import { ReviewObservation } from "./review-observation.js";
import { TurnGateway } from "./app-server/turn-gateway.js";

type Agent = any;

export interface LifecycleExecutionContext {
  store: WorkflowStore;
  runtime: WorkflowRuntimeState;
  reviewObservation: ReviewObservation;
  turnGateway: TurnGateway;
  callback?: CodexCallback;
  requireAgent(exec: ToolRunContext): Agent;
  submissionTaskKey(workflowId: string, submissionId: string): string;
}

/** Owns status, cancellation and teardown. */
export class LifecycleExecution {
  constructor(private readonly ctx: LifecycleExecutionContext) {}

  stop(): Promise<void> {
    if (this.ctx.runtime.stopPromise) return this.ctx.runtime.stopPromise;
    const task = this.doStop();
    this.ctx.runtime.stopPromise = task;
    return task;
  }
  private async doStop(): Promise<void> {
    if (this.ctx.runtime.stopped) return;
    this.ctx.runtime.stopped = true;
    this.ctx.runtime.lifecycleController.abort();
    for (const controller of this.ctx.runtime.submissionControllers.values()) controller.abort();
    // Interrupt every ACTIVE foreground turn (visible Planner/Reviewer or
    // ephemeral normalization fork) so the foreground tool flows settle via
    // their own abort/interrupt paths instead of timing out into a closed
    // store. Background Reviewer turns are interrupted by callback.stop().
    for (const active of this.ctx.runtime.activeTurns.values()) {
      void this.ctx.turnGateway.interrupt(active.threadId, active.turnId).catch(() => undefined);
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
  }


  async status(workflowId: string | undefined, exec: ToolRunContext): Promise<WorkflowRecord & { reviewerActive: boolean }> {
    const agent = this.ctx.requireAgent(exec);
    let record = workflowId ? await this.ctx.store.load(workflowId) : await this.ctx.store.activeForSession(agent.id);
    if (!record) throw new Error(workflowId ? `unknown workflow ${workflowId}` : "no active Codex workflow for this session");
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
      || (record.processState === "running" && record.phase === "reviewing" && Boolean(record.reviewerTurnId));
    return { ...record, reviewerActive };
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
    let target: { threadId: string; turnId: string } | undefined;
    const outcome = await this.ctx.store.update(workflowId, (r) => {
      if (r.dshSessionId !== agent.id) throw new Error("workflow belongs to another DSH session");
      if (!active) {
        // New Planner/Reviewer ids are ephemeral and never persisted. Legacy
        // ids remain diagnostic only, so cancellation never resumes or
        // interrupts a historical Desktop task. A genuinely running turn is
        // always represented by the in-process active-turn map.
      }
      r.phase = "cancelled";
      r.processState = "cancelled";
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
    this.ctx.reviewObservation.stopHeartbeat(workflowId);
    if (active) target = { threadId: active.threadId, turnId: active.turnId };
    if (target) {
      await this.ctx.turnGateway.interrupt(target.threadId, target.turnId, exec.signal).catch(() => undefined);
    }
    // Cancel the active Reviewer operation, if any; cancelled is terminal for it too.
    if (outcome.record.submissionId) {
      this.ctx.runtime.submissionControllers
        .get(this.ctx.submissionTaskKey(workflowId, outcome.record.submissionId))
        ?.abort();
    }
    this.ctx.callback?.cancel(workflowId);
    return outcome.record;
  }


}
