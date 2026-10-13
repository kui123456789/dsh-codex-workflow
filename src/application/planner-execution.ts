import type { Agent } from "@deepseek-ai/dsh-agent";
import { randomUUID } from "node:crypto";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexGateway } from "../workflow.js";
import type { WorkflowStore } from "../store.js";
import type { TurnNeedsInputResult, TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../types.js";
import type { AppServerLiveEvent } from "../app-server.js";
import type { LiveRelay } from "./live-relay.js";
import type { CodexChildSessionHandle } from "../codex-child-session.js";
import { isRecoverableModelFailure } from "../transient-retry.js";
import { CodexTurnInterruptionError } from "../turn-interruption.js";
import { CodexTurnReceiptPendingError } from "../pending-turn-receipt.js";
import type { PlannerInputRun, RecoverableWorkflowRun } from "./workflow-runtime-state.js";
import { assertPlannerRun, assertPlannerRunIdentity, plannerRunIdentity, type PlannerRunIdentity } from "./planner-run-identity.js";
import { assertPlannerRunCheckpoint, capturePlannerRunCheckpoint, PlannerStageModelError,
  resetPlannerCheckpointForAnswers, type PlannerRunCheckpoint } from "./planner-run-checkpoint.js";

export interface PlannerExecutionContext {
  store: WorkflowStore;
  config: WorkflowConfig;
  pending: Map<string, TurnNeedsInputResult>;
  inputRuns: Map<string, PlannerInputRun>;
  captureThreadOwner?(threadId: string): object | undefined;
  isThreadAvailable(threadId: string, expectedOwner?: object): boolean;
  interruptPlannerTurn(threadId: string, turnId: string, expectedOwner?: object): Promise<boolean>;
  /** Exact original-pair acknowledgement or independently proved process exit. */
  confirmPlannerTerminalCleanup?(workflowId: string, run: RecoverableWorkflowRun): Promise<boolean>;
  requireAgent(exec: ToolRunContext): Agent;
  acquireCreateLease(sessionId: string): Promise<{ release(): Promise<boolean>; renew?(): Promise<boolean> } | undefined>;
  assertNoActiveWorkflow(sessionId: string): Promise<void>;
  startThread(options: { cwd: string; model?: string; name?: string; ephemeral?: boolean }, signal?: AbortSignal): Promise<string>;
  bindUsage?(workflowId: string, threadId: string, model?: string, expected?: PlannerRunIdentity, threadOwner?: object): Promise<void>;
  releasePlannerThread?(threadId: string, expectedOwner?: object): Promise<unknown>;
  resumeThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void>;
  startTurnWithRetry(
    threadId: string,
    options: Parameters<CodexGateway["startTurn"]>[1],
    signal?: AbortSignal,
  ): Promise<TurnWaitResult>;
  continueTurn(pending: TurnNeedsInputResult, answers: Record<string, string[]>, signal?: AbortSignal, onProgress?: (entry: AppServerLiveEvent) => void, expectedOwner?: object): Promise<TurnWaitResult>;
  createLiveRelay(record: WorkflowRecord, stage: "planning"): LiveRelay;
  planStarted(record: WorkflowRecord, childSessionId?: string): void;
  planStateChanged?(record: WorkflowRecord, childSessionId?: string): void;
  planFailed(record: WorkflowRecord): void;
  createChildSession(record: WorkflowRecord, exec: ToolRunContext): Promise<CodexChildSessionHandle | undefined>;
  disposeChildSession(workflowId: string, child: CodexChildSessionHandle | undefined): Promise<void>;
  beginRound(): void;
  endRound(): void;
  registerActiveTurn(workflowId: string, threadId: string, turnId: string, kind: "planner" | "reviewer", ephemeral?: boolean, expected?: PlannerRunIdentity, threadOwner?: object): Promise<void> | void;
  clearActiveTurn(workflowId: string): void;
  acceptPlannerOutcome(workflowId: string, outcome: TurnWaitResult, exec: ToolRunContext, model: string | undefined, cwd: string, expected: PlannerRunIdentity, checkpoint?: PlannerRunCheckpoint): Promise<WorkflowRecord>;
  owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord>;
  resumeWorkflow(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord>;
  trackForeground<T>(task: Promise<T>): Promise<T>;
  plannerPrompt(task: string): string;
  canCachePlannerText?(text: string): boolean;
  resumedAnswerPrompt(answers: Record<string, string[]>): string;
  threadName(prefix: string, text: string): string;
  errorMessage(error: unknown): string;
  getRecoverableRun(workflowId: string): RecoverableWorkflowRun | undefined;
  setRecoverableRun(workflowId: string, run: RecoverableWorkflowRun): void;
  clearRecoverableRun(workflowId: string): void;
  isStopping(): boolean;
}

/** Planner state machine: create/resume the durable planner task and hand its
 * visible reply to the shared normalization/commit path. */
export class PlannerExecution {
  private readonly starting = new Set<string>();

  constructor(private readonly ctx: PlannerExecutionContext) {}

  isStarting(workflowId: string): boolean { return this.starting.has(workflowId); }

  start(
    args: { task: string; plannerModel?: string; plannerEffort?: WorkflowConfig["plannerEffort"] },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    return this.ctx.trackForeground(this.startInner(args, exec));
  }

  async continue(workflowId: string, answers: Record<string, string[]>, exec: ToolRunContext): Promise<WorkflowRecord> {
    const record = await this.ctx.owned(workflowId, exec);
    if (record.retryState?.stage === "planning" && record.processState === "waiting") {
      return this.ctx.resumeWorkflow(workflowId, exec);
    }
    if (record.phase !== "waiting_input") {
      throw new Error(`workflow ${workflowId} is not waiting for planner input`);
    }
    const input = this.ctx.inputRuns.get(workflowId);
    const threadOwner = input?.threadOwner ?? input?.plannerCheckpoint?.threadOwner;
    if (!input || !this.originalThreadAvailable(input.threadId, threadOwner)) {
      throw new Error(`workflow ${workflowId} has no available original Planner clarification; no replacement will be started`);
    }
    assertPlannerRun(input.plannerIdentity, record, "waiting_input");
    const checkpoint = input.plannerCheckpoint ?? capturePlannerRunCheckpoint(record, input.threadId,
      { model: record.plannerModel || this.ctx.config.plannerModel || undefined,
        effort: record.plannerEffort ?? this.ctx.config.plannerEffort }, input.child, threadOwner);
    assertPlannerRunCheckpoint(checkpoint, record);
    if (input.pending && this.ctx.pending.get(workflowId) !== input.pending) {
      throw new Error(`workflow ${workflowId} has lost its original clarification request; no replacement will be started`);
    }
    exec.signal.throwIfAborted();
    this.ctx.inputRuns.delete(workflowId);
    this.ctx.pending.delete(workflowId);
    let plannerModel = checkpoint.settings.model;
    const answersPrompt = `${this.ctx.resumedAnswerPrompt(answers)}\n\n请使用这些回答，在当前会话中继续完成原规划，不要重发原任务或重复已回答的问题。`;
    const live = this.ctx.createLiveRelay(record, "planning");
    const child = input.child;
    let retained = false;
    let nativeInvoked = false;
    try {
      exec.signal.throwIfAborted();
      const starting = await this.ctx.store.update(workflowId, (r) => {
        assertPlannerRun(record, r, "waiting_input");
        assertPlannerRunCheckpoint(checkpoint, r);
        // This claims the original pending request for cleanup as well as reply.
        // A caller abort before the answer RPC must still reach the confirmed
        // interruption/restore path; no model call runs without the later check.
        if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
        r.phase = "planning";
        r.processState = "running";
        r.pendingInput = undefined;
        r.lastProgressMessage = "Planner continuing with clarification answers in the same session";
      }, { ignoreCancelled: false });
      if (starting.suppressed) return starting.record;
      resetPlannerCheckpointForAnswers(checkpoint);
      await this.assertRunning(record, exec, input.threadId, checkpoint);
      child?.beginContinuation(answersPrompt);
      this.ctx.planStarted(record, child?.id);
      const onProgress = (entry: AppServerLiveEvent) => { live.onProgress(entry); child?.progress(entry); };
      checkpoint.onProgress = onProgress;
      const result = await this.runTurnWithContinuation(record, input.threadId, child, plannerModel,
        answersPrompt, exec, onProgress, (model) => { plannerModel = model; },
        checkpoint.settings.effort,
        input.pending ? () => {
          nativeInvoked = true;
          return this.ctx.continueTurn(input.pending!, answers, exec.signal, onProgress, checkpoint.threadOwner);
        } : undefined,
        answersPrompt, checkpoint);
      if (result.waiting) { retained = result.waiting.phase !== "cancelled"; return result.waiting; }
      const accepted = await this.acceptWithContinuation(record, result.outcome, checkpoint, exec, answersPrompt);
      if (accepted.processState === "waiting" && accepted.retryState?.awaitingContinuation) {
        retained = accepted.phase !== "cancelled"; return accepted;
      }
      const finished = await this.finishOrPark(accepted, checkpoint.outcome ?? result.outcome, input.threadId, child, exec, checkpoint);
      retained = finished.retained;
      return finished.record;
    } catch (error) {
      if (error instanceof CodexTurnReceiptPendingError) {
        retained = true;
        return this.retainPendingStart(record, input.threadId, child, error, checkpoint);
      }
      if (error instanceof CodexTurnInterruptionError && error.cleanupOnly) {
        retained = true;
        return this.retainTerminalCleanup(record, input.threadId, child, error, checkpoint);
      }
      const current = await this.ctx.store.load(workflowId);
      assertPlannerRunIdentity(record, current);
      if (current.phase === "cancelled") return current;
      assertPlannerRunCheckpoint(checkpoint, current);
      if (current.phase !== "planning") throw error;
      if (error instanceof CodexTurnInterruptionError && error.threadId === input.threadId && !this.ctx.isStopping()) {
        const waiting = await this.waitForContinuation(record, input.threadId, child,
          error.message, answersPrompt, error.turnId, checkpoint, error);
        retained = waiting.waiting.phase !== "cancelled";
        return waiting.waiting;
      }
      if (!(error instanceof CodexTurnInterruptionError) && !this.ctx.isStopping()
        && (exec.signal.aborted || this.ctx.errorMessage(error) === "operation aborted")) {
        if (input.pending) {
          const interrupted = await this.ctx.interruptPlannerTurn(input.threadId, input.pending.turnId, checkpoint.threadOwner);
          const latest = await this.ctx.owned(workflowId, exec);
          assertPlannerRunIdentity(record, latest);
          if (latest.phase === "cancelled") return latest;
          if (this.ctx.isStopping()) return latest;
          assertPlannerRun(record, latest);
          assertPlannerRunCheckpoint(checkpoint, latest);
          if (!this.originalThreadAvailable(input.threadId, checkpoint.threadOwner)) throw new Error("original Planner thread is unavailable; no replacement will be started");
          if (!interrupted && nativeInvoked) {
            const waiting = await this.waitForContinuation(record, input.threadId, child,
              "Original submitted Planner turn interruption is unconfirmed; resume must retry cleanup before starting another turn",
              answersPrompt, input.pending.turnId, checkpoint);
            retained = waiting.waiting.phase !== "cancelled";
            return waiting.waiting;
          }
          if (!interrupted) {
            const restored = await this.ctx.store.update(workflowId, (r) => {
              assertPlannerRun(record, r);
              assertPlannerRunCheckpoint(checkpoint, r);
              r.phase = "waiting_input";
              r.processState = undefined;
              r.retryState = undefined;
              r.pendingInput = { turnId: input.pending!.turnId, itemId: input.pending!.request.itemId };
              r.questions = record.questions;
              r.error = "Original native Planner interruption is unconfirmed; answer the original clarification before starting a new turn";
            }, { ignoreCancelled: false });
            if (restored.suppressed || this.ctx.isStopping()) return restored.record;
            child?.pauseForInput?.(restored.record.error!);
            this.ctx.pending.set(workflowId, input.pending);
            this.ctx.inputRuns.set(workflowId, input);
            input.plannerCheckpoint = checkpoint;
            retained = true;
            this.ctx.planStateChanged?.(restored.record, child?.id);
            return restored.record;
          }
        }
        const waiting = await this.waitForContinuation(record, input.threadId, child, this.ctx.errorMessage(error), answersPrompt, undefined, checkpoint);
        retained = waiting.waiting.phase !== "cancelled";
        return waiting.waiting;
      }
      const failed = await this.ctx.store.update(workflowId, (r) => {
        assertPlannerRun(record, r);
        assertPlannerRunCheckpoint(checkpoint, r);
        r.phase = "failed";
        r.processState = "failed";
        r.retryState = undefined;
        r.error = this.ctx.errorMessage(error);
      }, { ignoreCancelled: false });
      if (!failed.suppressed) this.ctx.planFailed(failed.record);
      child?.finish(this.ctx.errorMessage(error), "failed");
      throw error;
    } finally {
      try {
        if (!retained) this.ctx.clearActiveTurn(workflowId);
        live.close();
        if (!retained) {
          this.ctx.inputRuns.delete(workflowId);
          this.ctx.clearRecoverableRun(workflowId);
          this.ctx.pending.delete(workflowId);
          await this.ctx.disposeChildSession(workflowId, child);
        }
      } finally {
        if (!retained) {
          try { await this.releaseOriginalThread(input.threadId, checkpoint.threadOwner); }
          finally { this.ctx.endRound(); }
        }
      }
    }
  }

  async resume(workflowId: string, instruction: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const recovery = this.ctx.getRecoverableRun(workflowId);
    if (!recovery || recovery.state.stage !== "planning") {
      throw new Error(`workflow ${workflowId} has no in-process Planner session to resume; restart cannot recover an ephemeral thread`);
    }
    const cleanupOnly = Boolean(recovery.terminalFailure || recovery.state.awaitingCleanup || recovery.pendingStartIntent);
    if (cleanupOnly && recovery.plannerIdentity?.dshSessionId !== this.ctx.requireAgent(exec).id) {
      throw new Error("workflow belongs to another DSH session");
    }
    const record = cleanupOnly ? await this.ctx.store.load(workflowId) : await this.ctx.owned(workflowId, exec);
    if (!record) throw new Error(`unknown workflow ${workflowId}`);
    if (recovery.terminalFailure || recovery.state.awaitingCleanup || recovery.pendingStartIntent) {
      return this.resumeTerminalCleanup(record, recovery, exec);
    }
    if (!recovery.plannerIdentity) throw new Error("original Planner identity is unavailable; no replacement will be started");
    if (recovery.pendingStart) {
      const status = recovery.pendingStart.operation.status();
      if (status !== "ready") throw recovery.pendingStart;
    }
    const threadOwner = recovery.threadOwner ?? recovery.plannerCheckpoint?.threadOwner;
    if (!this.originalThreadAvailable(recovery.threadId, threadOwner)) {
      throw new Error("original Planner thread is unavailable; no replacement will be started");
    }
    assertPlannerRun(recovery.plannerIdentity, record);
    if (record.retryState?.plannerCheckpoint && !recovery.plannerCheckpoint) {
      throw new Error("original Planner stage checkpoint is unavailable; no replacement will be started");
    }
    const checkpoint = recovery.plannerCheckpoint ?? capturePlannerRunCheckpoint(record, recovery.threadId,
      { model: record.plannerModel || this.ctx.config.plannerModel || undefined,
        effort: record.plannerEffort ?? this.ctx.config.plannerEffort }, recovery.child, threadOwner);
    if (!recovery.plannerCheckpoint) {
      checkpoint.automaticContinuations = recovery.automaticContinuations ?? 1;
      checkpoint.legacySettingsPending = true;
    }
    assertPlannerRunCheckpoint(checkpoint, record);
    // Retry the original turn's cleanup before claiming another model writer.
    // Submitted native answers are retained as context, never replayed as RPCs.
    if (recovery.interruptionTurnId) {
      exec.signal.throwIfAborted();
      if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
      const interrupted = await this.ctx.interruptPlannerTurn(recovery.threadId, recovery.interruptionTurnId, checkpoint.threadOwner);
      const latest = await this.ctx.owned(workflowId, exec);
      assertPlannerRunIdentity(recovery.plannerIdentity, latest);
      if (latest.phase === "cancelled" || this.ctx.isStopping()) return latest;
      assertPlannerRun(recovery.plannerIdentity, latest);
      assertPlannerRunCheckpoint(checkpoint, latest);
      if (this.ctx.getRecoverableRun(workflowId) !== recovery || latest.processState !== "waiting"
        || !latest.retryState?.awaitingContinuation) throw new Error("original Planner recovery owner changed during interruption cleanup");
      if (!interrupted) throw new Error("Original Planner turn interruption is unconfirmed; no model continuation was sent");
      recovery.interruptionTurnId = undefined;
      if (recovery.pendingStart?.operation.finished()) {
        await this.ctx.confirmPlannerTerminalCleanup?.(workflowId, recovery);
        this.ctx.clearRecoverableRun(workflowId);
        recovery.pendingStart = undefined;
        checkpoint.pendingStart = undefined;
        recovery.state.awaitingStartReceipt = undefined;
      }
    }
    // Transfer the retained round to this execution. cancel/stop clean waiting
    // handles only; this execution releases its own pin in finally.
    if (!recovery.pendingStart) this.ctx.clearRecoverableRun(workflowId);
    let plannerModel = checkpoint.settings.model;
    record.plannerEffort = checkpoint.settings.effort;
    const live = this.ctx.createLiveRelay(record, "planning");
    let retained = false;
    try {
      exec.signal.throwIfAborted();
      const starting = await this.ctx.store.update(workflowId, (r) => {
        assertPlannerRun(record, r);
        assertPlannerRunCheckpoint(checkpoint, r);
        exec.signal.throwIfAborted();
        if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
        if (plannerModel) r.plannerModel = plannerModel;
        r.plannerEffort = record.plannerEffort;
        r.processState = "running";
        r.retryState = undefined;
        r.error = undefined;
        r.lastProgressMessage = "Planner continuing in the same session";
      }, { ignoreCancelled: false });
      if (starting.suppressed) return starting.record;
      checkpoint.legacySettingsPending = false;
      await this.assertRunning(record, exec, recovery.threadId, checkpoint);
      const prompt = recovery.answersPrompt ? `${recovery.answersPrompt}\n\n当前继续指令：${instruction}` : instruction;
      if (checkpoint.nextStep !== "visible") checkpoint.continuation = { step: checkpoint.nextStep, instruction };
      if (checkpoint.nextStep !== "completion") recovery.child?.beginContinuation(recovery.pendingStart
        ? "接回原模型回合并继续观察其输出，不重新启动模型。" : prompt);
      this.ctx.planStarted(record, recovery.child?.id);
      checkpoint.onProgress = (entry) => { live.onProgress(entry); recovery.child?.progress(entry); };
      const result = checkpoint.nextStep === "visible"
        ? await this.runTurnWithContinuation(record, recovery.threadId, recovery.child, plannerModel,
          prompt, exec, checkpoint.onProgress, (model) => { plannerModel = model; }, checkpoint.settings.effort,
          undefined, recovery.answersPrompt, checkpoint)
        : { outcome: checkpoint.outcome!, waiting: undefined };
      if (result.waiting) { retained = result.waiting.phase !== "cancelled"; return result.waiting; }
      this.ctx.clearRecoverableRun(workflowId);
      const accepted = await this.acceptWithContinuation(record, result.outcome, checkpoint, exec, recovery.answersPrompt);
      if (accepted.processState === "waiting" && accepted.retryState?.awaitingContinuation) {
        retained = accepted.phase !== "cancelled"; return accepted;
      }
      const finished = await this.finishOrPark(accepted, checkpoint.outcome ?? result.outcome, recovery.threadId, recovery.child, exec, checkpoint);
      retained = finished.retained;
      return finished.record;
    } catch (error) {
      if (error instanceof CodexTurnReceiptPendingError) {
        retained = true;
        return this.retainPendingStart(record, recovery.threadId, recovery.child, error, checkpoint);
      }
      if (error instanceof CodexTurnInterruptionError && error.cleanupOnly) {
        retained = true;
        return this.retainTerminalCleanup(record, recovery.threadId, recovery.child, error, checkpoint);
      }
      const current = await this.ctx.store.load(workflowId);
      assertPlannerRunIdentity(record, current);
      if (current.phase === "cancelled") return current;
      assertPlannerRunCheckpoint(checkpoint, current);
      if (current.phase !== "planning") throw error;
      if (error instanceof CodexTurnInterruptionError && error.threadId === recovery.threadId && !this.ctx.isStopping()) {
        const waiting = await this.waitForContinuation(record, recovery.threadId, recovery.child,
          error.message, recovery.answersPrompt, error.turnId, checkpoint, error);
        retained = waiting.waiting.phase !== "cancelled";
        return waiting.waiting;
      }
      if (!(error instanceof CodexTurnInterruptionError) && !this.ctx.isStopping()
        && (exec.signal.aborted || this.ctx.errorMessage(error) === "operation aborted")) {
        const waiting = await this.waitForContinuation(record, recovery.threadId, recovery.child, this.ctx.errorMessage(error), recovery.answersPrompt, undefined, checkpoint);
        retained = waiting.waiting.phase !== "cancelled";
        return waiting.waiting;
      }
      const failed = await this.ctx.store.update(workflowId, (r) => {
        assertPlannerRun(record, r);
        assertPlannerRunCheckpoint(checkpoint, r);
        r.phase = "failed";
        r.processState = "failed";
        r.retryState = undefined;
        r.error = this.ctx.errorMessage(error);
      }, { ignoreCancelled: false });
      if (!failed.suppressed) this.ctx.planFailed(failed.record);
      throw error;
    } finally {
      try {
        if (recovery.pendingStart && (this.ctx.getRecoverableRun(workflowId) === recovery || recovery.receiptCleanupClaimed)) retained = true;
        // Native clarification still owns an open turn; terminal/completed
        // model calls must never remain a cancellation target after cleanup.
        if (!retained) this.ctx.clearActiveTurn(workflowId);
        live.close();
        if (!retained) {
          this.ctx.clearRecoverableRun(workflowId);
          this.ctx.inputRuns.delete(workflowId);
          this.ctx.pending.delete(workflowId);
          await this.ctx.disposeChildSession(workflowId, recovery.child);
        }
      } finally {
        if (!retained) {
          try {
            await this.releaseOriginalThread(recovery.threadId, checkpoint.threadOwner);
          } finally { this.ctx.endRound(); }
        }
      }
    }
  }

  private async finishOrPark(record: WorkflowRecord, outcome: TurnWaitResult, threadId: string,
    child: CodexChildSessionHandle | undefined, exec: ToolRunContext, checkpoint?: PlannerRunCheckpoint): Promise<{ record: WorkflowRecord; retained: boolean }> {
    if (record.phase === "waiting_input") {
      const current = await this.ctx.owned(record.id, exec);
      assertPlannerRunIdentity(record, current);
      if (current.phase === "waiting_input" && !this.ctx.isStopping()) {
        const pending = this.ctx.pending.get(record.id);
        if ((pending && pending.threadId !== threadId) || (!pending && outcome.kind !== "completed")) {
          throw new Error("original Planner clarification request is unavailable; refusing a replacement");
        }
        const text = outcome.kind === "completed" ? checkpoint?.visibleText ?? outcome.text : current.questions.map((question) => question.question).join("\n\n");
        child?.pauseForInput?.(text || "Planner is waiting for clarification answers.");
        if (!this.originalThreadAvailable(threadId, checkpoint?.threadOwner)) {
          throw new Error("original Planner clarification thread is unavailable; no replacement will be started");
        }
        this.ctx.inputRuns.set(record.id, { threadId, threadOwner: checkpoint?.threadOwner, child, plannerIdentity: plannerRunIdentity(record),
          ...(checkpoint ? { plannerCheckpoint: checkpoint } : {}), ...(pending ? { pending } : {}) });
        return { record: current, retained: true };
      }
      record = current;
    }
    child?.finish(outcome.kind === "completed" ? checkpoint?.visibleText ?? outcome.text : "Planner requested input",
      record.phase === "cancelled" ? "aborted" : record.phase === "failed" ? "failed" : "completed");
    return { record, retained: false };
  }

  private async startInner(
    args: { task: string; plannerModel?: string; plannerEffort?: WorkflowConfig["plannerEffort"] },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    exec.signal.throwIfAborted();
    if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
    const chosenModel = args.plannerModel || this.ctx.config.plannerModel || undefined;
    const chosenEffort = args.plannerEffort ?? this.ctx.config.plannerEffort;
    const agent = this.ctx.requireAgent(exec);
    const sessionId = agent.id;
    const createLease = await this.ctx.acquireCreateLease(sessionId);
    if (!createLease) {
      throw new Error(`session ${agent.id} is already creating a Codex workflow; continue the existing workflow instead of starting another`);
    }
    let record: WorkflowRecord | undefined;
    try {
      try {
        exec.signal.throwIfAborted();
        if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
        await this.ctx.assertNoActiveWorkflow(sessionId);
        if (createLease.renew && !await createLease.renew()) throw new Error(`session ${sessionId} lost its workflow creation lease`);
        exec.signal.throwIfAborted();
        if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
        if (this.ctx.requireAgent(exec).id !== sessionId) throw new Error("workflow creation session owner changed during cleanup admission");
        const now = new Date().toISOString();
        record = {
          schemaVersion: 1,
          id: randomUUID(),
          dshSessionId: sessionId,
          cwd: agent.session.header.cwd ?? process.cwd(),
          task: args.task.trim(),
          ...(chosenModel ? { plannerModel: chosenModel } : {}),
          plannerEffort: chosenEffort,
          mode: "planned",
          phase: "planning",
          createdAt: now,
          updatedAt: now,
          assumptions: [],
          questions: [],
          reviewCycles: 0,
          noChangeReviewRounds: 0,
        };
        // Mark this exact creator before saving: the row may already commit
        // while its asynchronous save receipt is still being observed.
        this.starting.add(record.id);
        await this.ctx.store.save(record);
      } finally {
        await createLease.release().catch(() => undefined);
      }
      return await this.runStartedPlanner(record, args.task, chosenEffort, exec);
    } finally {
      if (record) this.starting.delete(record.id);
    }
  }

  private async runStartedPlanner(record: WorkflowRecord, task: string,
    chosenEffort: WorkflowConfig["plannerEffort"], exec: ToolRunContext): Promise<WorkflowRecord> {
    const live = this.ctx.createLiveRelay(record, "planning");
    let child: CodexChildSessionHandle | undefined;
    let plannerThreadId: string | undefined;
    let checkpoint: PlannerRunCheckpoint | undefined;
    let plannerModel = record.plannerModel;
    let retained = false;
    this.ctx.beginRound();
    try {
      await this.assertRunning(record, exec);
      child = await this.ctx.createChildSession(record, exec);
      await this.assertRunning(record, exec);
      this.ctx.planStarted(record, child?.id);
      // Creation owns its bounded response once admitted. Cancelling its RPC
      // observer can discard a thread already created by the server. Collect
      // the original receipt within the existing App Server RPC timeout; the
      // checks before any model turn then park caller aborts or clean up a
      // cancelled/stopped owner. Ordinary model turns still use exec.signal.
      plannerThreadId = await this.ctx.startThread({
        cwd: record.cwd,
        ...(plannerModel ? { model: plannerModel } : {}),
        name: this.ctx.threadName("DSH Plan", task),
        ephemeral: true,
      });
      checkpoint = capturePlannerRunCheckpoint(record, plannerThreadId,
        { model: plannerModel, effort: chosenEffort }, child, this.ctx.captureThreadOwner?.(plannerThreadId));
      if (!this.originalThreadAvailable(plannerThreadId, checkpoint.threadOwner)) {
        throw new Error("original Planner creation owner is unavailable; no replacement will be started");
      }
      checkpoint.onProgress = (entry) => { live.onProgress(entry); child?.progress(entry); };
      await this.ctx.bindUsage?.(record.id, plannerThreadId, plannerModel, record, checkpoint.threadOwner);
      const result = await this.runTurnWithContinuation(record, plannerThreadId, child, plannerModel,
        this.ctx.plannerPrompt(record.task), exec, checkpoint.onProgress,
        (model) => { plannerModel = model; }, chosenEffort, undefined, undefined, checkpoint);
      if (result.waiting) { retained = result.waiting.phase !== "cancelled"; return result.waiting; }
      this.ctx.clearRecoverableRun(record.id);
      const accepted = await this.acceptWithContinuation(record, result.outcome, checkpoint, exec);
      if (accepted.processState === "waiting" && accepted.retryState?.awaitingContinuation) {
        retained = accepted.phase !== "cancelled"; return accepted;
      }
      const finished = await this.finishOrPark(accepted, checkpoint.outcome ?? result.outcome, plannerThreadId, child, exec, checkpoint);
      retained = finished.retained;
      return finished.record;
    } catch (error) {
      if (error instanceof CodexTurnReceiptPendingError && plannerThreadId && checkpoint) {
        retained = true;
        return this.retainPendingStart(record, plannerThreadId, child, error, checkpoint);
      }
      if (error instanceof CodexTurnInterruptionError && error.cleanupOnly && plannerThreadId) {
        retained = true;
        return this.retainTerminalCleanup(record, plannerThreadId, child, error, checkpoint);
      }
      const current = await this.ctx.store.load(record.id);
      assertPlannerRunIdentity(record, current);
      if (current.phase === "cancelled") {
        if (current.retryState?.awaitingStartReceipt && !this.ctx.getRecoverableRun(record.id)) {
          return (await this.ctx.store.update(record.id, (r) => {
            assertPlannerRunIdentity(record, r);
            if (r.phase !== "cancelled") throw new Error("Cancelled Planner startup phase changed");
            r.processState = "cancelled"; r.retryState = undefined;
          }, { ignoreCancelled: true })).record;
        }
        return current;
      }
      if (checkpoint) assertPlannerRunCheckpoint(checkpoint, current);
      if (current.phase !== "planning") throw error;
      if (error instanceof CodexTurnInterruptionError && error.threadId === plannerThreadId && !this.ctx.isStopping()) {
        const waiting = await this.waitForContinuation(record, plannerThreadId, child, error.message, undefined, error.turnId, checkpoint, error);
        retained = waiting.waiting.phase !== "cancelled";
        return waiting.waiting;
      }
      if (plannerThreadId && !this.ctx.isStopping()
        && !(error instanceof CodexTurnInterruptionError)
        && (exec.signal.aborted || this.ctx.errorMessage(error) === "operation aborted")) {
        const waiting = await this.waitForContinuation(record, plannerThreadId, child, this.ctx.errorMessage(error), undefined, undefined, checkpoint);
        retained = waiting.waiting.phase !== "cancelled";
        return waiting.waiting;
      }
      const failed = await this.ctx.store.update(record.id, (r) => {
        assertPlannerRun(record, r);
        if (checkpoint) assertPlannerRunCheckpoint(checkpoint, r);
        r.phase = "failed";
        r.error = this.ctx.errorMessage(error);
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      this.ctx.planFailed(failed.record);
      child?.finish(this.ctx.errorMessage(error), "failed");
      throw error;
    } finally {
      try {
        if (!retained) this.ctx.clearActiveTurn(record.id);
        live.close();
        if (!retained) {
          this.ctx.inputRuns.delete(record.id);
          this.ctx.pending.delete(record.id);
          await this.ctx.disposeChildSession(record.id, child);
        }
      } finally {
        if (!retained) {
          try {
            if (plannerThreadId) await this.releaseOriginalThread(plannerThreadId, checkpoint?.threadOwner);
          } finally { this.ctx.endRound(); }
        }
      }
    }
  }

  private async runTurnWithContinuation(
    record: WorkflowRecord,
    threadId: string,
    child: CodexChildSessionHandle | undefined,
    plannerModel: string | undefined,
    prompt: string,
    exec: ToolRunContext,
    onProgress: (entry: AppServerLiveEvent) => void,
    onModel: (model: string) => void = () => undefined,
    effort: WorkflowConfig["plannerEffort"] = record.plannerEffort ?? this.ctx.config.plannerEffort,
    initial?: () => Promise<TurnWaitResult>,
    answersPrompt?: string,
    checkpoint?: PlannerRunCheckpoint,
  ): Promise<{ outcome: TurnWaitResult; waiting?: undefined } | { waiting: WorkflowRecord; outcome?: undefined }> {
    checkpoint ??= capturePlannerRunCheckpoint(record, threadId, { model: plannerModel, effort }, child,
      this.ctx.captureThreadOwner?.(threadId));
    record.plannerEffort = effort;
    let initialUsed = false;
    for (;;) {
      await this.assertRunning(record, exec, threadId, checkpoint);
      let outcome: TurnWaitResult;
      try {
        const turnOptions: Parameters<CodexGateway["startTurn"]>[1] = {
          prompt,
          ...(plannerModel ? { model: plannerModel } : {}),
          effort,
          expectedOwner: checkpoint.threadOwner,
          planMode: true,
          onModel: (model) => {
            plannerModel = model;
            record.plannerModel = model;
            checkpoint!.settings = Object.freeze({ model, effort: checkpoint!.settings.effort });
            // The transient wrapper reuses this options object within one
            // operation. Keep its retries on the resolved model as well.
            turnOptions.model = model;
            onModel(model);
          },
          onProgress,
          onStarted: async (started) => {
            if (started.threadId !== threadId) {
              await this.ctx.interruptPlannerTurn(started.threadId, started.turnId, checkpoint!.threadOwner);
              throw new Error("Planner returned a different original thread; refusing a replacement");
            }
            await this.ctx.registerActiveTurn(record.id, started.threadId, started.turnId, "planner", true, record, checkpoint!.threadOwner);
          },
        };
        const invokeInitial = !initialUsed && initial;
        initialUsed = true;
        if (checkpoint.pendingStart) {
          const pending = checkpoint.pendingStart;
          const original = await pending.operation.resume({ onStarted: turnOptions.onStarted, onProgress }, exec.signal);
          outcome = original.result;
          checkpoint.pendingStart = undefined;
          const held = this.ctx.getRecoverableRun(record.id);
          if (held?.pendingStart === pending) {
            if (outcome.kind === "needs_input") held.metadataOnly = true;
            else if (pending.operation.finished()) {
              await this.ctx.confirmPlannerTerminalCleanup?.(record.id, held);
              this.ctx.clearRecoverableRun(record.id);
            }
          }
        } else outcome = invokeInitial ? await invokeInitial()
          : await this.ctx.startTurnWithRetry(threadId, turnOptions, exec.signal);
      } catch (error) {
        if (error instanceof CodexTurnReceiptPendingError) throw error;
        if (error instanceof CodexTurnInterruptionError && error.cleanupOnly) throw error;
        if (exec.signal.aborted || this.ctx.isStopping()) throw error;
        const message = this.ctx.errorMessage(error);
        if (error instanceof CodexTurnInterruptionError && error.threadId === threadId) {
          await this.assertRunning(record, exec, threadId, checkpoint);
          return this.waitForContinuation(record, threadId, child, message, answersPrompt, error.turnId, checkpoint, error);
        }
        if (!isRecoverableModelFailure(error)) throw error;
        await this.assertRunning(record, exec, threadId, checkpoint);
        if (checkpoint.automaticContinuations === 0) {
          checkpoint.automaticContinuations = 1;
          prompt = answersPrompt ?? "上一轮模型回合因可恢复的运行错误中断。请在当前会话上下文中继续完成原任务，不要重新开始或重复已经完成的内容。";
          child?.beginContinuation(prompt);
          continue;
        }
        return this.waitForContinuation(record, threadId, child, message, answersPrompt, undefined, checkpoint);
      }
      if (outcome.threadId !== threadId) throw new Error("Planner result belongs to a different original thread; refusing a replacement");
      if (outcome.kind === "needs_input" && exec.signal.aborted && !this.ctx.isStopping()) {
        // The server has already opened this original clarification request.
        // Retain its exact input handle after caller-only cancellation instead
        // of offering a fresh turn against a still-active native writer. All
        // ownership, phase, cancel and teardown CAS checks remain in force.
        const receiptExec = Object.assign(Object.create(exec), {
          signal: new AbortController().signal,
        }) as ToolRunContext;
        const parked = await this.ctx.acceptPlannerOutcome(record.id, outcome, receiptExec,
          checkpoint.settings.model, record.cwd, checkpoint.identity, checkpoint);
        const finished = await this.finishOrPark(parked, outcome, threadId, child, receiptExec, checkpoint);
        return { waiting: finished.record };
      }
      if (outcome.kind === "completed" && outcome.status === "completed"
        && this.ctx.canCachePlannerText?.(outcome.text)) {
        // The receipt already completed on the original thread. Preserve its
        // validated display output before caller cancellation; committing it
        // still requires the separate structured conversion and scope gates.
        checkpoint.outcome = outcome;
        checkpoint.visibleText = outcome.text;
        checkpoint.converted = undefined;
        checkpoint.nextStep = "conversion";
        checkpoint.continuation = undefined;
      }
      await this.assertRunning(record, exec, threadId, checkpoint);
      if (outcome.kind === "completed" && outcome.status !== "completed") {
        if (exec.signal.aborted || this.ctx.isStopping()) throw new Error("operation aborted");
        const detail = `${outcome.reason ?? "turn failed"}${outcome.error ? `: ${outcome.error}` : ""}`;
        if (!outcome.text?.trim() && isRecoverableModelFailure(detail)) {
          if (checkpoint.automaticContinuations === 0) {
            checkpoint.automaticContinuations = 1;
            prompt = answersPrompt ?? "上一轮模型回合因可恢复的运行错误中断。请在当前会话上下文中继续完成原任务，不要重新开始或重复已经完成的内容。";
            child?.beginContinuation(prompt);
            continue;
          }
          return this.waitForContinuation(record, threadId, child, detail, answersPrompt, undefined, checkpoint);
        }
      }
      return { outcome };
    }
  }

  private async acceptWithContinuation(record: WorkflowRecord, outcome: TurnWaitResult,
    checkpoint: PlannerRunCheckpoint, exec: ToolRunContext, answersPrompt?: string): Promise<WorkflowRecord> {
    for (;;) {
      await this.assertRunning(record, exec, checkpoint.threadId, checkpoint);
      try {
        return await this.ctx.acceptPlannerOutcome(record.id, checkpoint.outcome ?? outcome, exec,
          checkpoint.settings.model, record.cwd, checkpoint.identity, checkpoint);
      } catch (error) {
        if (!(error instanceof PlannerStageModelError) || exec.signal.aborted || this.ctx.isStopping()) throw error;
        if (error.stage !== checkpoint.nextStep) throw new Error("Planner failure does not belong to its current checkpoint stage; no continuation was sent");
        await this.assertRunning(record, exec, checkpoint.threadId, checkpoint);
        if (error.interruption) {
          if (error.interruption.threadId !== checkpoint.threadId) throw error;
          return (await this.waitForContinuation(record, checkpoint.threadId, checkpoint.child,
            error.message, answersPrompt, error.interruption.turnId, checkpoint)).waiting;
        }
        if (checkpoint.automaticContinuations === 1) {
          return (await this.waitForContinuation(record, checkpoint.threadId, checkpoint.child,
            error.message, answersPrompt, undefined, checkpoint)).waiting;
        }
        checkpoint.automaticContinuations = 1;
        const instruction = "上一轮规划处理因可恢复的模型错误中断。请在当前会话继续未完成的步骤，保留已经完成的规划，不要重新开始。";
        checkpoint.continuation = { step: checkpoint.nextStep, instruction };
        if (checkpoint.nextStep !== "completion") checkpoint.child?.beginContinuation(instruction);
      }
    }
  }

  private async waitForContinuation(
    record: WorkflowRecord,
    threadId: string,
    child: CodexChildSessionHandle | undefined,
    reason: string,
    answersPrompt?: string,
    interruptionTurnId?: string,
    checkpoint?: PlannerRunCheckpoint,
    interruption?: CodexTurnInterruptionError,
  ): Promise<{ waiting: WorkflowRecord; outcome?: undefined }> {
    child?.failAttempt(reason);
    const state = { stage: "planning" as const, reason, attempts: 1, awaitingContinuation: true,
      ...(interruption ? { interruption: { target: "planner" as const,
        ...(interruption.originalProcessId === undefined ? {} : { processId: interruption.originalProcessId }),
        ...(interruption.originalProcessIds === undefined ? {} : { processIds: [...interruption.originalProcessIds] }),
        ...(interruption.originalProcessIdentities === undefined ? {}
          : { processIdentities: interruption.originalProcessIdentities.map((identity) => ({ ...identity })) }) } } : {}),
      ...(checkpoint ? { plannerCheckpoint: { nextStep: checkpoint.nextStep } } : {}) };
    const updated = await this.ctx.store.update(record.id, (current) => {
      assertPlannerRun(record, current);
      if (checkpoint) assertPlannerRunCheckpoint(checkpoint, current);
      if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
      if (!this.originalThreadAvailable(threadId, checkpoint?.threadOwner)) throw new Error("original Planner thread is unavailable; no replacement will be started");
      const model = checkpoint ? checkpoint.settings.model : record.plannerModel;
      if (model) current.plannerModel = model;
      current.plannerEffort = checkpoint?.settings.effort ?? record.plannerEffort ?? this.ctx.config.plannerEffort;
      current.phase = "planning";
      current.pendingInput = undefined;
      current.processState = "waiting";
      current.retryState = state;
      current.activeTurnId = undefined;
      current.error = reason;
      current.lastProgressAt = new Date().toISOString();
      current.lastProgressMessage = "Planner failed; the same session is waiting for continuation";
    }, { ignoreCancelled: false });
    if (!updated.suppressed && checkpoint) checkpoint.legacySettingsPending = false;
    if (!updated.suppressed) this.ctx.setRecoverableRun(record.id, { state, threadId, threadOwner: checkpoint?.threadOwner, child,
      plannerIdentity: plannerRunIdentity(record), ...(answersPrompt ? { answersPrompt } : {}),
      ...(checkpoint ? { plannerCheckpoint: checkpoint, automaticContinuations: checkpoint.automaticContinuations } : {}),
      ...(interruption ? { originalProcessId: interruption.originalProcessId, originalProcessIds: interruption.originalProcessIds,
        originalProcessIdentities: interruption.originalProcessIdentities } : {}),
      ...(interruptionTurnId ? { interruptionTurnId } : {}) });
    if (!updated.suppressed) this.ctx.planStateChanged?.(updated.record, child?.id);
    return { waiting: updated.record };
  }

  /** A terminal contract failure may still own a live writer. Keep only its
   * cleanup capability; the saved artifacts and model budget cannot resume it. */
  private async retainPendingStart(record: WorkflowRecord, threadId: string,
    child: CodexChildSessionHandle | undefined, error: CodexTurnReceiptPendingError,
    checkpoint: PlannerRunCheckpoint): Promise<WorkflowRecord> {
    checkpoint.pendingStart = error;
    const evidence = await error.operation.evidence();
    const previous = this.ctx.getRecoverableRun(record.id);
    const state = { stage: "planning" as const, reason: error.message, attempts: 1,
      awaitingContinuation: true, awaitingStartReceipt: true,
      plannerCheckpoint: { nextStep: checkpoint.nextStep },
      ...(previous?.pendingStart?.operation === error.operation && previous.state.terminalCleanup
        ? { terminalCleanup: previous.state.terminalCleanup } : {}) };
    const recovery: RecoverableWorkflowRun = previous?.pendingStart?.operation === error.operation ? previous : {
      state, threadId, threadOwner: checkpoint.threadOwner, child,
      plannerIdentity: plannerRunIdentity(record), plannerCheckpoint: checkpoint,
      automaticContinuations: checkpoint.automaticContinuations,
      originalProcessId: evidence.processId, originalProcessIds: evidence.processIds,
      originalProcessIdentities: evidence.processIdentities,
    };
    recovery.state = state;
    recovery.pendingStart = error;
    this.ctx.setRecoverableRun(record.id, recovery);
    child?.failAttempt(error.message);
    const current = await this.ctx.store.load(record.id);
    assertPlannerRunIdentity(record, current);
    if (current.phase === "cancelled" || this.ctx.isStopping()) {
      recovery.pendingStartIntent = "cancel";
      recovery.terminalFailure = "Original Planner cancelled while its start receipt was pending";
      recovery.state.awaitingCleanup = true;
      recovery.state.terminalFailure = recovery.terminalFailure;
    } else {
      assertPlannerRun(record, current);
      assertPlannerRunCheckpoint(checkpoint, current);
    }
    const waiting = await this.ctx.store.update(record.id, (r) => {
      assertPlannerRunIdentity(record, r);
      if (r.phase !== "cancelled") {
        assertPlannerRun(record, r); assertPlannerRunCheckpoint(checkpoint, r);
      }
      r.processState = "waiting";
      r.retryState = recovery.state;
      r.pendingInput = undefined;
      r.error = error.message;
      r.lastProgressAt = new Date().toISOString();
      r.lastProgressMessage = "Original Planner start receipt is pending; no replacement model request was sent";
    }, { ignoreCancelled: true });
    if (!waiting.suppressed) this.ctx.planStateChanged?.(waiting.record, child?.id);
    return waiting.record;
  }

  private async retainTerminalCleanup(record: WorkflowRecord, threadId: string,
    child: CodexChildSessionHandle | undefined, error: CodexTurnInterruptionError,
    checkpoint?: PlannerRunCheckpoint): Promise<WorkflowRecord> {
    const terminalFailure = error.cause instanceof Error ? error.cause.message : error.message;
    const state = { stage: "planning" as const, reason: terminalFailure, attempts: 1,
      awaitingContinuation: true, awaitingCleanup: true, terminalFailure,
      ...(checkpoint ? { plannerCheckpoint: { nextStep: checkpoint.nextStep } } : {}) };
    const recovery: RecoverableWorkflowRun = { state, threadId,
      threadOwner: checkpoint?.threadOwner ?? (error.threadId === threadId ? error.originalThreadOwner : undefined), child, terminalFailure,
      interruptionTurnId: error.turnId, plannerIdentity: plannerRunIdentity(record),
      cleanupTarget: { threadId: error.threadId, turnId: error.turnId },
      cleanupThreadOwner: error.originalThreadOwner ?? (error.threadId === threadId ? checkpoint?.threadOwner : undefined),
      originalProcessId: error.originalProcessId, originalProcessIds: error.originalProcessIds,
      originalProcessIdentities: error.originalProcessIdentities,
      ...(checkpoint ? { plannerCheckpoint: checkpoint, automaticContinuations: checkpoint.automaticContinuations } : {}) };
    // Claim cleanup before any scope/owner/CAS check can throw. A changed row
    // cannot authorize model work, but it cannot orphan the original writer.
    this.ctx.setRecoverableRun(record.id, recovery);
    child?.failAttempt(terminalFailure);
    const current = await this.ctx.store.load(record.id);
    assertPlannerRunIdentity(record, current);
    if (current.phase === "cancelled" || this.ctx.isStopping()) return current;
    assertPlannerRun(record, current);
    if (checkpoint) assertPlannerRunCheckpoint(checkpoint, current);
    const waiting = await this.ctx.store.update(record.id, (r) => {
      assertPlannerRun(record, r);
      if (checkpoint) assertPlannerRunCheckpoint(checkpoint, r);
      if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
      r.processState = "waiting";
      r.retryState = state;
      r.pendingInput = undefined;
      r.error = terminalFailure;
      r.lastProgressAt = new Date().toISOString();
      r.lastProgressMessage = "Planner failed; only original-turn cleanup is waiting for acknowledgement";
    }, { ignoreCancelled: false });
    if (!waiting.suppressed) this.ctx.planStateChanged?.(waiting.record, child?.id);
    return waiting.record;
  }

  private async resumeTerminalCleanup(record: WorkflowRecord, recovery: RecoverableWorkflowRun,
    exec: ToolRunContext): Promise<WorkflowRecord> {
    if (recovery.pendingStart) {
      exec.signal.throwIfAborted();
      const confirmed = await this.ctx.confirmPlannerTerminalCleanup?.(record.id, recovery);
      if (!confirmed) throw new Error("Original Planner start receipt cleanup is unconfirmed; no model continuation was sent");
      if (this.ctx.getRecoverableRun(record.id) !== recovery) throw new Error("Original Planner receipt cleanup owner changed");
      this.ctx.clearRecoverableRun(record.id);
      try {
        const current = await this.ctx.store.load(record.id);
        assertPlannerRunIdentity(recovery.plannerIdentity!, current);
        const cleaned = await this.ctx.store.update(record.id, (r) => {
          assertPlannerRunIdentity(recovery.plannerIdentity!, r);
          if (r.phase !== "cancelled") r.phase = "failed";
          r.processState = r.phase === "cancelled" ? "cancelled" : "failed";
          r.retryState = undefined;
          r.error = recovery.terminalFailure ?? recovery.pendingStart!.message;
        }, { ignoreCancelled: true });
        if (!cleaned.suppressed) this.ctx.planStateChanged?.(cleaned.record, recovery.child?.id);
        return cleaned.record;
      } finally {
        this.ctx.clearActiveTurn(record.id); this.ctx.inputRuns.delete(record.id); this.ctx.pending.delete(record.id);
        try { await this.ctx.disposeChildSession(record.id, recovery.child); }
        finally {
          try { await this.releaseOriginalThread(recovery.threadId, recovery.threadOwner); }
          finally { if (!recovery.metadataOnly) this.ctx.endRound(); }
        }
      }
    }
    const terminalFailure = recovery.terminalFailure;
    if (!terminalFailure || recovery.state.terminalFailure !== terminalFailure
      || !recovery.state.awaitingCleanup || !recovery.interruptionTurnId || !recovery.plannerIdentity) {
      throw new Error("original Planner terminal cleanup capability is incomplete; no model continuation was sent");
    }
    exec.signal.throwIfAborted();
    if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
    const confirmed = this.ctx.confirmPlannerTerminalCleanup
      ? await this.ctx.confirmPlannerTerminalCleanup(record.id, recovery)
      : await this.ctx.interruptPlannerTurn(recovery.threadId, recovery.interruptionTurnId, recovery.cleanupThreadOwner ?? recovery.threadOwner);
    if (!confirmed) throw new Error("Original Planner terminal cleanup is unconfirmed; no model continuation was sent");
    // Only the caller removing this exact handle owns disposal and its pin.
    if (this.ctx.getRecoverableRun(record.id) !== recovery) {
      const current = await this.ctx.owned(record.id, exec);
      if (current.phase === "cancelled" || this.ctx.isStopping()) return current;
      throw new Error("original Planner cleanup owner changed during interruption");
    }
    this.ctx.clearRecoverableRun(record.id);
    try {
      const current = await this.ctx.store.load(record.id);
      assertPlannerRunIdentity(recovery.plannerIdentity, current);
      if (current.phase === "cancelled") {
        const cancelled = await this.ctx.store.update(record.id, (r) => {
          assertPlannerRunIdentity(recovery.plannerIdentity!, r);
          if (r.phase !== "cancelled") throw new Error("original cancelled Planner cleanup phase changed");
          if (r.retryState?.awaitingCleanup && r.retryState.terminalFailure === terminalFailure) r.retryState = undefined;
        }, { ignoreCancelled: true });
        return cancelled.record;
      }
      if (this.ctx.isStopping() || exec.signal.aborted) return current;
      assertPlannerRun(recovery.plannerIdentity, current);
      if (recovery.plannerCheckpoint) assertPlannerRunCheckpoint(recovery.plannerCheckpoint, current);
      const failed = await this.ctx.store.update(record.id, (r) => {
        assertPlannerRun(recovery.plannerIdentity!, r);
        if (recovery.plannerCheckpoint) assertPlannerRunCheckpoint(recovery.plannerCheckpoint, r);
        exec.signal.throwIfAborted();
        if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
        r.phase = "failed";
        r.processState = "failed";
        r.retryState = undefined;
        r.error = terminalFailure;
        r.lastProgressAt = new Date().toISOString();
        r.lastProgressMessage = "Planner failed; original-turn cleanup is confirmed";
      }, { ignoreCancelled: false });
      if (!failed.suppressed) {
        this.ctx.planFailed(failed.record);
        recovery.child?.finish(terminalFailure, "failed");
      }
      return failed.record;
    } finally {
      try {
        this.ctx.clearActiveTurn(record.id);
        this.ctx.inputRuns.delete(record.id);
        this.ctx.pending.delete(record.id);
        await this.ctx.disposeChildSession(record.id, recovery.child);
      } finally {
        try { await this.releaseOriginalThread(recovery.threadId, recovery.threadOwner); }
        finally { this.ctx.endRound(); }
      }
    }
  }

  private async assertRunning(record: PlannerRunIdentity, exec: ToolRunContext, threadId?: string,
    checkpoint?: PlannerRunCheckpoint): Promise<void> {
    const current = await this.ctx.owned(record.id, exec);
    exec.signal.throwIfAborted();
    if (this.ctx.isStopping()) throw new Error("workflow manager is stopped");
    assertPlannerRun(record, current);
    if (checkpoint) assertPlannerRunCheckpoint(checkpoint, current);
    if (threadId && !this.originalThreadAvailable(threadId, checkpoint?.threadOwner)) throw new Error("original Planner thread is unavailable; no replacement will be started");
  }

  private originalThreadAvailable(threadId: string, threadOwner?: object): boolean {
    if (this.ctx.captureThreadOwner && !threadOwner) return false;
    return this.ctx.isThreadAvailable(threadId, threadOwner);
  }

  private async releaseOriginalThread(threadId: string, threadOwner?: object): Promise<void> {
    if (this.ctx.captureThreadOwner && !threadOwner) return;
    await this.ctx.releasePlannerThread?.(threadId, threadOwner);
  }
}
