import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { collectEvidence, isGitRepository } from "./evidence.js";
import { PLANNER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import { WorkflowStore } from "./store.js";
import type {
  PlannerResult,
  ReviewEvidence,
  ReviewResult,
  TurnNeedsInputResult,
  TurnWaitResult,
  WorkflowConfig,
  WorkflowPhase,
  WorkflowRecord,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface CodexGateway {
  startThread(options: { cwd: string; model?: string; name: string }, signal?: AbortSignal): Promise<string>;
  resumeThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void>;
  startTurn(threadId: string, options: {
    prompt: string;
    model?: string;
    effort?: WorkflowConfig["plannerEffort"];
    outputSchema?: Record<string, unknown>;
    planMode?: boolean;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }, signal?: AbortSignal): Promise<TurnWaitResult>;
  continueTurn(
    pending: TurnNeedsInputResult,
    answers: Record<string, string[]>,
    signal?: AbortSignal,
  ): Promise<TurnWaitResult>;
  startReview(options: {
    threadId: string;
    cwd: string;
    target: Record<string, unknown>;
    detached: boolean;
    onStarted?: (started: { threadId: string; turnId: string }) => Promise<void> | void;
  }, signal?: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }>;
  interrupt(threadId: string, turnId: string, signal?: AbortSignal): Promise<void>;
}

export interface ReviewInput {
  implementationSummary: string;
  changedFiles?: string[];
  testResults?: string;
}

export class WorkflowManager {
  private readonly pending = new Map<string, TurnNeedsInputResult>();
  private readonly nudgedTurns = new Set<string>();

  constructor(
    private readonly store: WorkflowStore,
    private readonly codex: CodexGateway,
    private readonly config: WorkflowConfig,
  ) {}

  async start(
    args: { task: string; plannerModel?: string; plannerEffort?: WorkflowConfig["plannerEffort"] },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    await this.assertNoActiveWorkflow(agent.id);
    const now = new Date().toISOString();
    const record: WorkflowRecord = {
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
    await this.store.save(record);
    try {
      const plannerThreadId = await this.codex.startThread({
        cwd: record.cwd,
        ...(args.plannerModel || this.config.plannerModel
          ? { model: args.plannerModel || this.config.plannerModel }
          : {}),
        name: threadName("DSH Plan", args.task),
      }, exec.signal);
      const threadCommit = await this.store.update(record.id, (r) => {
        r.plannerThreadId = plannerThreadId;
      }, { ignoreCancelled: false });
      if (threadCommit.suppressed) return threadCommit.record;
      const outcome = await this.codex.startTurn(plannerThreadId, {
        prompt: plannerPrompt(record.task),
        ...(args.plannerModel || this.config.plannerModel
          ? { model: args.plannerModel || this.config.plannerModel }
          : {}),
        effort: args.plannerEffort ?? this.config.plannerEffort,
        outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        planMode: true,
        // Persist the planner turn the moment it starts so cancel can interrupt it.
        onStarted: (started) => this.registerActiveTurn(record.id, started.threadId, started.turnId, "planner"),
      }, exec.signal);
      return await this.acceptPlannerOutcome(record.id, outcome, exec);
    } catch (error) {
      const failed = await this.store.update(record.id, (r) => {
        r.phase = "failed";
        r.error = errorMessage(error);
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      throw error;
    }
  }

  async continue(
    workflowId: string,
    answers: Record<string, string[]>,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.phase !== "waiting_input" || !record.plannerThreadId) {
      throw new Error(`workflow ${workflowId} is not waiting for planner input`);
    }
    let outcome: TurnWaitResult;
    const pending = this.pending.get(workflowId);
    if (pending) {
      outcome = await this.codex.continueTurn(pending, answers, exec.signal);
    } else {
      await this.codex.resumeThread(record.plannerThreadId, record.cwd, exec.signal);
      outcome = await this.codex.startTurn(record.plannerThreadId, {
        prompt: resumedAnswerPrompt(answers),
        ...(this.config.plannerModel ? { model: this.config.plannerModel } : {}),
        effort: this.config.plannerEffort,
        outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        planMode: true,
        onStarted: (started) => this.registerActiveTurn(workflowId, started.threadId, started.turnId, "planner"),
      }, exec.signal);
    }
    return this.acceptPlannerOutcome(workflowId, outcome, exec);
  }

  async review(
    workflowId: string,
    input: ReviewInput,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.phase !== "executing" && record.phase !== "fixing") {
      throw new Error(`workflow ${workflowId} cannot be reviewed from phase ${record.phase}`);
    }
    if (record.mode !== "review_only") {
      if (!record.planMarkdown || !record.plannerThreadId) throw new Error(`workflow ${workflowId} has no completed plan`);
    }
    return this.reviewOnce(workflowId, input, exec, record.mode === "review_only" ? undefined : record.plannerThreadId);
  }

  /**
   * Review-only entry: unlike `start`, it never runs the Codex planner. A fresh
   * read-only source thread hosts the first detached reviewer; later rounds
   * reuse the persisted reviewer thread via the ordinary `review` tool. All
   * evidence, decision-gate, no-change and cycle-limit logic is shared.
   */
  async reviewOnly(
    args: {
      task?: string;
      implementationSummary: string;
      changedFiles?: string[];
      testResults?: string;
      reviewerModel?: string;
      reviewerEffort?: WorkflowConfig["reviewerEffort"];
    },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    await this.assertNoActiveWorkflow(agent.id);
    const cwd = agent.session.header.cwd ?? process.cwd();
    if (!(await isGitRepository(cwd)) && !(Array.isArray(args.changedFiles) && args.changedFiles.length > 0)) {
      throw new Error(
        "review-only in a non-git workspace requires changedFiles so the changes can be observed by the reviewer",
      );
    }
    const now = new Date().toISOString();
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      dshSessionId: agent.id,
      cwd,
      task: (args.task ?? "").trim(),
      mode: "review_only",
      phase: "reviewing",
      createdAt: now,
      updatedAt: now,
      assumptions: [],
      questions: [],
      reviewCycles: 0,
      noChangeReviewRounds: 0,
      // Persist the effective reviewer model/effort so later repair rounds keep
      // the caller's override even when the bundle config changes.
      reviewerModel: args.reviewerModel || this.config.reviewerModel || undefined,
      reviewerEffort: args.reviewerEffort ?? this.config.reviewerEffort,
    };
    await this.store.save(record);
    let sourceThread: string;
    try {
      sourceThread = await this.codex.startThread({
        cwd: record.cwd,
        ...(record.reviewerModel ? { model: record.reviewerModel } : {}),
        name: threadName("DSH Review", record.task || "review workspace"),
      }, exec.signal);
      const sourceCommit = await this.store.update(record.id, (r) => {
        r.sourceThreadId = sourceThread;
      }, { ignoreCancelled: false });
      if (sourceCommit.suppressed) return sourceCommit.record;
    } catch (error) {
      const failed = await this.store.update(record.id, (r) => {
        r.phase = "failed";
        r.error = errorMessage(error);
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      throw error;
    }
    return this.reviewOnce(record.id, {
      implementationSummary: args.implementationSummary,
      ...(args.changedFiles ? { changedFiles: args.changedFiles } : {}),
      ...(args.testResults ? { testResults: args.testResults } : {}),
    }, exec, sourceThread);
  }

  async decide(
    workflowId: string,
    input: { decision: "accept" | "fix"; note?: string },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (record.phase !== "waiting_review_decision") {
      throw new Error(`workflow ${workflowId} is not waiting for a review decision (phase ${record.phase})`);
    }
    const review = record.latestReview;
    if (!review) throw new Error(`workflow ${workflowId} has no review to decide on`);
    const message = input.decision === "accept"
      ? `Codex review for workflow ${workflowId} was accepted by the user: the non-blocking improvements below are recorded as deliberately not fixed.\n${formatFindings(review)}`
      : `Codex review for workflow ${workflowId} has non-blocking findings to fix. Apply each improvement below, rerun relevant tests, then call codex_workflow_review again before answering the user.\n${formatFindings(review)}`;
    const commit = await this.store.update(workflowId, (r) => {
      r.reviewDecision = {
        decision: input.decision,
        ...(input.note ? { note: input.note } : {}),
        decidedAt: new Date().toISOString(),
      };
      r.noChangeReviewRounds = 0;
      r.phase = input.decision === "accept" ? "passed" : "fixing";
      r.error = undefined;
    }, { ignoreCancelled: false });
    if (commit.suppressed) return commit.record;
    exec.deferContext(pluginMessage(message));
    return commit.record;
  }

  async status(workflowId: string | undefined, exec: ToolRunContext): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    const record = workflowId ? await this.store.load(workflowId) : await this.store.activeForSession(agent.id);
    if (!record) throw new Error(workflowId ? `unknown workflow ${workflowId}` : "no active Codex workflow for this session");
    if (record.dshSessionId !== agent.id) throw new Error("workflow belongs to another DSH session");
    return record;
  }

  /**
   * Cancel is the only writer allowed to flip any state to cancelled. The
   * phase flip and the read of the currently known active turn happen in one
   * atomic update; the interrupt afterwards is best-effort and a failure keeps
   * the workflow cancelled. All other writers suppress themselves once the
   * record is cancelled, so cancelled is terminal.
   */
  async cancel(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    let target: { threadId: string; turnId: string } | undefined;
    const outcome = await this.store.update(workflowId, (r) => {
      if (r.dshSessionId !== agent.id) throw new Error("workflow belongs to another DSH session");
      const threadId = r.reviewerThreadId ?? r.plannerThreadId;
      const turnId = r.reviewerTurnId ?? r.plannerTurnId;
      if (threadId && turnId) target = { threadId, turnId };
      r.phase = "cancelled";
    }, { ignoreCancelled: true });
    if (target) {
      await this.codex.interrupt(target.threadId, target.turnId, exec.signal).catch(() => undefined);
    }
    return outcome.record;
  }

  async onTurnStopping(agent: Agent, turn: number): Promise<void> {
    const record = await this.store.activeForSession(agent.id);
    // waiting_review_decision must not be steered: the user (not the agent)
    // decides whether non-blocking findings get fixed.
    if (!record || (record.phase !== "executing" && record.phase !== "fixing")) return;
    const key = `${record.id}:${turn}`;
    if (this.nudgedTurns.has(key)) return;
    this.nudgedTurns.add(key);
    agent.steer(pluginMessage(
      record.phase === "executing"
        ? `Workflow ${record.id} is not complete: finish implementing the approved Codex plan, run tests, then call codex_workflow_review before ending this turn.`
        : `Workflow ${record.id} still has review findings: finish the fixes, rerun tests, then call codex_workflow_review before ending this turn.`,
    ));
  }

  /**
   * Shared review pipeline used by both `review` and `reviewOnly`: capture
   * evidence, run the detached/inline reviewer, normalize its verdict, and
   * apply the blocking gate, no-change termination and cycle limits. Every
   * store write goes through the atomic update primitive; any write that races
   * a cancellation is suppressed and the cancelled record is returned.
   */
  private async reviewOnce(
    workflowId: string,
    input: ReviewInput,
    exec: ToolRunContext,
    initialSourceThread: string | undefined,
  ): Promise<WorkflowRecord> {
    const entering = await this.store.update(workflowId, (r) => {
      r.phase = "reviewing";
      r.reviewCycles += 1;
    }, { ignoreCancelled: false });
    if (entering.suppressed) return entering.record;
    let current = entering.record;
    try {
      const evidence = await collectEvidence({
        cwd: current.cwd,
        maxDiffBytes: this.config.reviewDiffMaxBytes,
        changedFiles: input.changedFiles,
      });
      const git = await isGitRepository(current.cwd);
      const sourceThread = current.reviewerThreadId ?? initialSourceThread;
      if (!sourceThread) throw new Error(`workflow ${workflowId} has no review source thread`);
      if (current.reviewerThreadId) await this.codex.resumeThread(current.reviewerThreadId, current.cwd, exec.signal);

      const evidenceCommit = await this.store.update(workflowId, (r) => {
        r.latestReviewEvidence = evidence;
        this.trackNoChange(r, evidence);
      }, { ignoreCancelled: false });
      if (evidenceCommit.suppressed) return evidenceCommit.record;
      current = evidenceCommit.record;

      const review = await this.codex.startReview({
        threadId: sourceThread,
        cwd: current.cwd,
        detached: !current.reviewerThreadId,
        target: git
          ? { type: "uncommittedChanges" }
          : { type: "custom", instructions: reviewInstructions(current, input) },
        // Persist the reviewer thread/turn the moment the review has started so
        // codex_workflow_cancel can interrupt it while it is still running.
        onStarted: (started) => this.registerActiveTurn(workflowId, started.threadId, started.turnId, "reviewer"),
      }, exec.signal);
      const afterReview = await this.store.load(workflowId);
      if (!afterReview || afterReview.phase === "cancelled") return afterReview!;
      current = afterReview;
      if (review.result.kind !== "completed") throw new Error("review unexpectedly requested user input");

      const normalized = await this.codex.startTurn(review.threadId, {
        prompt: normalizeReviewPrompt(current, input, review.result.text),
        // Effective model/effort persisted at review-only creation; planned
        // workflows fall back to the bundle config.
        ...(current.reviewerModel || this.config.reviewerModel
          ? { model: current.reviewerModel || this.config.reviewerModel }
          : {}),
        effort: current.reviewerEffort ?? this.config.reviewerEffort,
        outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        // The normalize turn becomes the active reviewer turn for cancellation.
        onStarted: (started) => this.registerActiveTurn(workflowId, started.threadId, started.turnId, "reviewer"),
      }, exec.signal);
      const afterNormalize = await this.store.load(workflowId);
      if (!afterNormalize || afterNormalize.phase === "cancelled") return afterNormalize!;
      current = afterNormalize;
      if (normalized.kind !== "completed") throw new Error("review normalization unexpectedly requested user input");

      const result = applyReviewConsistency(parseReview(normalized.text));
      // Compute the outcome and its message before touching the store; the
      // message is only injected after the atomic commit confirmed we were not
      // cancelled in the meantime.
      const outcome = this.computeReviewOutcome(current, result);
      const commit = await this.store.update(workflowId, (r) => {
        r.latestReview = result;
        r.noChangeReviewRounds = outcome.noChangeReviewRounds ?? r.noChangeReviewRounds;
        r.phase = outcome.phase;
        r.error = outcome.error;
      }, { ignoreCancelled: false });
      if (commit.suppressed) return commit.record;
      if (outcome.message) exec.deferContext(pluginMessage(outcome.message));
      return commit.record;
    } catch (error) {
      // A concurrent cancel wins over failure handling: never overwrite a
      // cancelled record with failed or any other phase.
      const failed = await this.store.update(workflowId, (r) => {
        r.phase = "failed";
        r.error = errorMessage(error);
      }, { ignoreCancelled: false });
      if (failed.suppressed) return failed.record;
      throw error;
    }
  }

  /**
   * Persist a freshly started turn as the active turn of its kind. If the
   * workflow was cancelled in the meantime the write is suppressed (the record
   * is never resurrected) and the turn we just obtained is interrupted.
   */
  private async registerActiveTurn(
    workflowId: string,
    threadId: string,
    turnId: string,
    kind: "planner" | "reviewer",
  ): Promise<void> {
    const outcome = await this.store.update(workflowId, (r) => {
      if (kind === "planner") {
        r.plannerThreadId = threadId;
        r.plannerTurnId = turnId;
      } else {
        r.reviewerThreadId = threadId;
        r.reviewerTurnId = turnId;
      }
    }, { ignoreCancelled: false });
    if (outcome.suppressed) {
      // Cancelled while the turn was being registered: kill the turn we just
      // started, never the record.
      await this.codex.interrupt(threadId, turnId).catch(() => undefined);
    }
  }

  private trackNoChange(record: WorkflowRecord, evidence: ReviewEvidence): void {
    record.latestReviewEvidence = evidence;
    if (evidence.insufficient || !evidence.fingerprint) {
      // Unobservable rounds must not chain across themselves: clear the chain
      // so a later return to an old fingerprint is treated as fresh progress.
      record.noChangeReviewRounds = 0;
      record.previousReviewFingerprint = undefined;
      return;
    }
    if (record.previousReviewFingerprint !== undefined && evidence.fingerprint === record.previousReviewFingerprint) {
      record.noChangeReviewRounds = (record.noChangeReviewRounds ?? 0) + 1;
    } else {
      record.noChangeReviewRounds = 0;
    }
    record.previousReviewFingerprint = evidence.fingerprint;
  }

  /** Pure outcome computation: no store writes and no side effects. */
  private computeReviewOutcome(record: WorkflowRecord, result: ReviewResult): ReviewOutcome {
    const hasBlocking = result.findings.some((finding) => finding.blocking) || result.testGaps.length > 0;
    if (result.verdict === "pass") {
      return {
        phase: "passed",
        noChangeReviewRounds: 0,
        message: `Codex Reviewer passed workflow ${record.id}. Report the verified implementation and tests to the user.`,
      };
    }
    if (!hasBlocking) {
      // Non-blocking only: stop automatic repair and let the user decide.
      return {
        phase: "waiting_review_decision",
        noChangeReviewRounds: 0,
        message: `Codex Reviewer found only non-blocking improvements for workflow ${record.id}. Present each item below to the user and wait for their choice, then call codex_workflow_decide with workflowId ${record.id} and decision "accept" (ship as-is) or "fix" (repair first).\n${formatFindings(result)}`,
      };
    }
    if ((record.noChangeReviewRounds ?? 0) >= this.config.maxNoChangeReviewRounds) {
      return {
        phase: "blocked",
        noChangeReviewRounds: record.noChangeReviewRounds,
        error: `workspace produced no verifiable change for ${record.noChangeReviewRounds} consecutive review round(s) while the Codex Reviewer kept requesting blocking changes`,
        message: `Codex Reviewer still requests changes for workflow ${record.id}, but the workspace has not changed since the previous review (fingerprint identical). Stopping automatic repair and clearing the active turn. Report that no verifiable workspace change was made and show the remaining findings:\n${formatFindings(result)}`,
      };
    }
    if (record.reviewCycles >= this.config.maxReviewCycles) {
      return {
        phase: "blocked",
        noChangeReviewRounds: record.noChangeReviewRounds,
        error: `Codex Reviewer still requests changes after ${record.reviewCycles} review cycles`,
        message: `Codex Reviewer still requests changes after ${record.reviewCycles} review cycles. Stop automatic repair and report the remaining findings:\n${formatFindings(result)}`,
      };
    }
    return {
      phase: "fixing",
      noChangeReviewRounds: record.noChangeReviewRounds,
      message: `Codex Reviewer requested changes for workflow ${record.id}. Fix every finding below in this same DSH session, rerun relevant tests, then call codex_workflow_review again before answering the user.\n${formatFindings(result)}`,
    };
  }

  private async acceptPlannerOutcome(
    workflowId: string,
    outcome: TurnWaitResult,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    if (outcome.kind === "needs_input") {
      this.pending.set(workflowId, outcome);
      const commit = await this.store.update(workflowId, (r) => {
        r.phase = "waiting_input";
        r.questions = outcome.request.questions;
        r.pendingInput = { turnId: outcome.turnId, itemId: outcome.request.itemId };
      }, { ignoreCancelled: false });
      return commit.record;
    }
    this.pending.delete(workflowId);
    if (outcome.status !== "completed") throw new Error(outcome.error ?? `planner turn ${outcome.status}`);
    const result = parsePlanner(outcome.text);
    if (result.status === "needs_input") {
      const commit = await this.store.update(workflowId, (r) => {
        r.phase = "waiting_input";
        r.questions = result.questions;
        r.assumptions = result.assumptions;
      }, { ignoreCancelled: false });
      return commit.record;
    }
    if (result.status === "ready" && result.planMarkdown?.trim()) {
      const planMarkdown = ensurePlanBlock(result.planMarkdown);
      const commit = await this.store.update(workflowId, (r) => {
        r.phase = "executing";
        r.planMarkdown = planMarkdown;
        r.assumptions = result.assumptions;
        r.questions = [];
        r.pendingInput = undefined;
      }, { ignoreCancelled: false });
      if (!commit.suppressed) exec.deferContext(pluginMessage(executionPrompt(commit.record)));
      return commit.record;
    }
    const commit = await this.store.update(workflowId, (r) => {
      r.phase = "failed";
      r.error = result.message ?? "Codex planner did not return a usable plan";
    }, { ignoreCancelled: false });
    return commit.record;
  }

  private async owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const record = await this.store.load(workflowId);
    if (!record) throw new Error(`unknown workflow ${workflowId}`);
    if (record.dshSessionId !== requireAgent(exec).id) throw new Error("workflow belongs to another DSH session");
    return record;
  }

  private async assertNoActiveWorkflow(sessionId: string): Promise<void> {
    const active = await this.store.activeForSession(sessionId);
    if (active) throw new Error(`session already has active Codex workflow ${active.id} (${active.phase})`);
  }
}

interface ReviewOutcome {
  phase: WorkflowPhase;
  error?: string;
  message?: string;
  noChangeReviewRounds?: number;
}

function plannerPrompt(task: string): string {
  return `You are the planning gate in a DSH-controlled coding workflow. Inspect the current workspace read-only and produce a decision-complete implementation plan for the task below. Do not edit files. Ask user questions only when a missing product decision makes a safe plan impossible. Return only the requested JSON object. planMarkdown must contain a complete <proposed_plan> block.\n\nTASK:\n${task}`;
}

function resumedAnswerPrompt(answers: Record<string, string[]>): string {
  return `Continue the existing plan using these user answers, then return the complete planner JSON result:\n${JSON.stringify(answers, null, 2)}`;
}

function executionPrompt(record: WorkflowRecord): string {
  return `Codex planning is complete for workflow ${record.id}. Implement the approved plan below in ${record.cwd}. You are the only mutation-capable executor: use normal DSH tools and approvals, keep scope faithful to the plan, run relevant verification, and then call codex_workflow_review with workflowId ${record.id}, a concise implementation summary, changed files, and test results before answering the user.\n\n${record.planMarkdown}`;
}

function reviewInstructions(record: WorkflowRecord, input: ReviewInput): string {
  const plan = record.planMarkdown ? `\n\nPLAN:\n${record.planMarkdown}` : "";
  const task = record.mode === "review_only"
    ? `\n\nREVIEW TASK:\n${record.task || "(no explicit task — review the current changes)"}`
    : "";
  return `Review the current workspace read-only. Focus on correctness, regressions, security, and missing tests. Do not edit files.${plan}${task}\n\nIMPLEMENTATION SUMMARY:\n${input.implementationSummary}\n\nCHANGED FILES:\n${(input.changedFiles ?? []).join("\n") || "not supplied"}\n\nTEST RESULTS:\n${input.testResults ?? "not supplied"}`;
}

function normalizeReviewPrompt(
  record: WorkflowRecord,
  input: ReviewInput,
  rawReview: string,
): string {
  return `Convert the code review you just completed into the required JSON schema. For every finding set blocking to true only when it must be fixed before delivery: critical and high findings block by default; medium and low findings block only when they create an actual correctness, regression, security, or delivery-required test gap. Every entry in testGaps counts as blocking. verdict is pass only when there are no actionable correctness, regression, security, or material test findings. Preserve concrete file and line references.\n\nWorkflow: ${record.id}\nImplementation: ${input.implementationSummary}\nRaw review:\n${rawReview}`;
}

function parsePlanner(text: string): PlannerResult {
  const value = parseJsonObject(text);
  const status = value.status;
  if (status !== "ready" && status !== "needs_input" && status !== "failed") throw new Error("invalid planner status");
  return {
    status,
    ...(typeof value.planMarkdown === "string" ? { planMarkdown: value.planMarkdown } : {}),
    questions: Array.isArray(value.questions) ? value.questions.map(parsePlannerQuestion) : [],
    assumptions: Array.isArray(value.assumptions) ? value.assumptions.filter((item): item is string => typeof item === "string") : [],
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  };
}

function parseReview(text: string): ReviewResult {
  const value = parseJsonObject(text);
  if (value.verdict !== "pass" && value.verdict !== "changes_requested") throw new Error("invalid review verdict");
  return {
    verdict: value.verdict,
    findings: Array.isArray(value.findings) ? value.findings.map(parseReviewFinding) : [],
    testGaps: Array.isArray(value.testGaps) ? value.testGaps.filter((item): item is string => typeof item === "string") : [],
    summary: typeof value.summary === "string" ? value.summary : "",
  };
}

/**
 * Enforce the cross-field invariant between verdict and content so a
 * structurally valid but semantically contradictory JSON result never lets a
 * blocking problem ship: a "pass" carrying findings/testGaps is demoted to
 * changes_requested (the blocking/non-blocking gate then applies), while a
 * changes_requested with nothing actionable is rejected outright.
 */
function applyReviewConsistency(result: ReviewResult): ReviewResult {
  const hasContent = result.findings.length > 0 || result.testGaps.length > 0;
  if (result.verdict === "pass" && hasContent) {
    return { ...result, verdict: "changes_requested" };
  }
  if (result.verdict === "changes_requested" && !hasContent) {
    throw new Error("invalid review result: changes_requested without findings or test gaps");
  }
  return result;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(trimmed) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex returned non-object JSON");
  return value as Record<string, unknown>;
}

function parsePlannerQuestion(value: unknown): PlannerResult["questions"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid planner question");
  const question = value as Record<string, unknown>;
  if (typeof question.id !== "string" || typeof question.question !== "string") throw new Error("invalid planner question");
  return {
    id: question.id,
    header: typeof question.header === "string" ? question.header : "Codex question",
    question: question.question,
    ...(Array.isArray(question.options) ? {
      options: question.options.flatMap((option) => {
        if (!option || typeof option !== "object" || Array.isArray(option)) return [];
        const entry = option as Record<string, unknown>;
        return typeof entry.label === "string" ? [{
          label: entry.label,
          ...(typeof entry.description === "string" && entry.description ? { description: entry.description } : {}),
        }] : [];
      }),
    } : {}),
    allowOther: question.allowOther === true,
    secret: question.secret === true,
  };
}

function parseReviewFinding(value: unknown): ReviewResult["findings"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid review finding");
  const finding = value as Record<string, unknown>;
  if (!isSeverity(finding.severity) || typeof finding.blocking !== "boolean"
    || typeof finding.title !== "string" || typeof finding.body !== "string") {
    throw new Error("invalid review finding");
  }
  return {
    severity: finding.severity,
    blocking: finding.blocking,
    title: finding.title,
    body: finding.body,
    ...(typeof finding.file === "string" && finding.file ? { file: finding.file } : {}),
    ...(Number.isInteger(finding.line) ? { line: finding.line as number } : {}),
  };
}

function isSeverity(value: unknown): value is ReviewResult["findings"][number]["severity"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low";
}

function ensurePlanBlock(plan: string): string {
  const trimmed = plan.trim();
  return trimmed.includes("<proposed_plan>") ? trimmed : `<proposed_plan>\n${trimmed}\n</proposed_plan>`;
}

function formatFindings(review: ReviewResult): string {
  const findings = review.findings.map((finding, index) => {
    const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
    const blocking = finding.blocking ? ", blocking" : "";
    return `${index + 1}. [${finding.severity}${blocking}] ${finding.title}${location}: ${finding.body}`;
  });
  return [...findings, ...review.testGaps.map((gap) => `Test gap: ${gap}`)].join("\n") || review.summary;
}

function pluginMessage(text: string) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "dsh-codex-workflow", form: "notice", summary: "Codex workflow continuation" },
  });
}

function requireAgent(exec: ToolRunContext): Agent {
  if (!exec.agent) throw new Error("Codex workflow tools require a live DSH agent session");
  return exec.agent;
}

function threadName(prefix: string, text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return `${prefix}: ${compact.slice(0, 72)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}