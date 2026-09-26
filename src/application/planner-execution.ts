import type { Agent } from "@deepseek-ai/dsh-agent";
import { randomUUID } from "node:crypto";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { CodexGateway } from "../workflow.js";
import type { WorkflowStore } from "../store.js";
import type { TurnNeedsInputResult, TurnWaitResult, WorkflowConfig, WorkflowRecord } from "../types.js";
import type { AppServerLiveEvent } from "../app-server.js";
import type { LiveRelay } from "./live-relay.js";

export interface PlannerExecutionContext {
  store: WorkflowStore;
  config: WorkflowConfig;
  pending: Map<string, TurnNeedsInputResult>;
  requireAgent(exec: ToolRunContext): Agent;
  acquireCreateLease(sessionId: string): Promise<{ release(): Promise<boolean> } | undefined>;
  assertNoActiveWorkflow(sessionId: string): Promise<void>;
  startThread(options: { cwd: string; model?: string; name?: string; ephemeral?: boolean }, signal?: AbortSignal): Promise<string>;
  resumeThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void>;
  startTurnWithRetry(
    threadId: string,
    options: Parameters<CodexGateway["startTurn"]>[1],
    signal?: AbortSignal,
  ): Promise<TurnWaitResult>;
  continueTurn(pending: TurnNeedsInputResult, answers: Record<string, string[]>, signal?: AbortSignal, onProgress?: (entry: AppServerLiveEvent) => void): Promise<TurnWaitResult>;
  createLiveRelay(record: WorkflowRecord, stage: "planning"): LiveRelay;
  planStarted(record: WorkflowRecord): void;
  planFailed(record: WorkflowRecord): void;
  registerActiveTurn(workflowId: string, threadId: string, turnId: string, kind: "planner" | "reviewer", ephemeral?: boolean): Promise<void> | void;
  acceptPlannerOutcome(workflowId: string, outcome: TurnWaitResult, exec: ToolRunContext, model: string | undefined, cwd: string): Promise<WorkflowRecord>;
  owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord>;
  trackForeground<T>(task: Promise<T>): Promise<T>;
  plannerPrompt(task: string): string;
  resumedAnswerPrompt(answers: Record<string, string[]>): string;
  threadName(prefix: string, text: string): string;
  errorMessage(error: unknown): string;
}

/** Planner state machine: create/resume the durable planner task and hand its
 * visible reply to the shared normalization/commit path. */
export class PlannerExecution {
  constructor(private readonly ctx: PlannerExecutionContext) {}

  start(
    args: { task: string; plannerModel?: string; plannerEffort?: WorkflowConfig["plannerEffort"] },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    return this.ctx.trackForeground(this.startInner(args, exec));
  }

  async continue(workflowId: string, answers: Record<string, string[]>, exec: ToolRunContext): Promise<WorkflowRecord> {
    const record = await this.ctx.owned(workflowId, exec);
    if (record.phase !== "waiting_input") {
      throw new Error(`workflow ${workflowId} is not waiting for planner input`);
    }
    let plannerModel = record.plannerModel || this.ctx.config.plannerModel || undefined;
    const pending = this.ctx.pending.get(workflowId);
    this.ctx.planStarted(record);
    const live = this.ctx.createLiveRelay(record, "planning");
    let outcome: TurnWaitResult;
    try {
      outcome = pending
        ? await this.ctx.continueTurn(pending, answers, exec.signal, live.onProgress)
        : await this.resumeWithNewTurn(record, answers, exec, plannerModel, (model) => { plannerModel = model; }, live.onProgress);
    } finally {
      live.close();
    }
    return this.ctx.acceptPlannerOutcome(workflowId, outcome, exec, plannerModel, record.cwd);
  }

  private async resumeWithNewTurn(
    record: WorkflowRecord,
    answers: Record<string, string[]>,
    exec: ToolRunContext,
    plannerModel: string | undefined,
    onModel: (model: string) => void,
    onProgress: (entry: AppServerLiveEvent) => void,
  ): Promise<TurnWaitResult> {
    const plannerThreadId = await this.ctx.startThread({ cwd: record.cwd, model: plannerModel, name: this.ctx.threadName("DSH Plan", record.task), ephemeral: true }, exec.signal);
    return this.ctx.startTurnWithRetry(plannerThreadId, {
      prompt: `${this.ctx.plannerPrompt(record.task)}\n\nThe previous planning attempt asked these questions and the user answered them:\n${this.ctx.resumedAnswerPrompt(answers)}\n\nContinue the same plan using these answers. Do not restart the task or ask the same questions again.`,
      ...(plannerModel ? { model: plannerModel } : {}),
      effort: this.ctx.config.plannerEffort,
      planMode: true,
      onModel,
      onProgress,
      onStarted: (started) => this.ctx.registerActiveTurn(record.id, started.threadId, started.turnId, "planner", true),
    }, exec.signal);
  }

  private async startInner(
    args: { task: string; plannerModel?: string; plannerEffort?: WorkflowConfig["plannerEffort"] },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const agent = this.ctx.requireAgent(exec);
    const createLease = await this.ctx.acquireCreateLease(agent.id);
    if (!createLease) {
      throw new Error(`session ${agent.id} is already creating a Codex workflow; continue the existing workflow instead of starting another`);
    }
    let record: WorkflowRecord;
    try {
      await this.ctx.assertNoActiveWorkflow(agent.id);
      const now = new Date().toISOString();
      record = {
        schemaVersion: 1,
        id: randomUUID(),
        dshSessionId: agent.id,
        cwd: agent.session.header.cwd ?? process.cwd(),
        task: args.task.trim(),
        mode: "planned",
        phase: "planning",
        createdAt: now,
        updatedAt: now,
        assumptions: [],
        questions: [],
        reviewCycles: 0,
        noChangeReviewRounds: 0,
      };
      await this.ctx.store.save(record);
    } finally {
      await createLease.release().catch(() => undefined);
    }
    this.ctx.planStarted(record);
    const live = this.ctx.createLiveRelay(record, "planning");
    try {
      const plannerThreadId = await this.ctx.startThread({
        cwd: record.cwd,
        ...(args.plannerModel || this.ctx.config.plannerModel ? { model: args.plannerModel || this.ctx.config.plannerModel } : {}),
        name: this.ctx.threadName("DSH Plan", args.task),
        ephemeral: true,
      }, exec.signal);
      let plannerModel = args.plannerModel || this.ctx.config.plannerModel || undefined;
      const outcome = await this.ctx.startTurnWithRetry(plannerThreadId, {
        prompt: this.ctx.plannerPrompt(record.task),
        ...(plannerModel ? { model: plannerModel } : {}),
        effort: args.plannerEffort ?? this.ctx.config.plannerEffort,
        planMode: true,
        onModel: (model) => { plannerModel = model; },
        onProgress: live.onProgress,
        onStarted: (started) => this.ctx.registerActiveTurn(record.id, started.threadId, started.turnId, "planner", true),
      }, exec.signal);
      return this.ctx.acceptPlannerOutcome(record.id, outcome, exec, plannerModel, record.cwd);
    } catch (error) {
      const failed = await this.ctx.store.update(record.id, (r) => {
        r.phase = "failed";
        r.error = this.ctx.errorMessage(error);
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      this.ctx.planFailed(failed.record);
      throw error;
    } finally {
      live.close();
    }
  }
}
