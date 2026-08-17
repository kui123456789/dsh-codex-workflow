import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { PLANNER_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import { WorkflowStore } from "./store.js";
import type {
  PlannerResult,
  ReviewResult,
  TurnNeedsInputResult,
  TurnWaitResult,
  WorkflowConfig,
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
  }, signal?: AbortSignal): Promise<{ threadId: string; result: TurnWaitResult }>;
  interrupt(threadId: string, turnId: string, signal?: AbortSignal): Promise<void>;
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
    const active = await this.store.activeForSession(agent.id);
    if (active) throw new Error(`session already has active Codex workflow ${active.id} (${active.phase})`);
    const now = new Date().toISOString();
    const record: WorkflowRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      dshSessionId: agent.id,
      cwd: agent.session.header.cwd ?? process.cwd(),
      task: args.task.trim(),
      phase: "planning",
      createdAt: now,
      updatedAt: now,
      assumptions: [],
      questions: [],
      reviewCycles: 0,
    };
    await this.store.save(record);
    try {
      record.plannerThreadId = await this.codex.startThread({
        cwd: record.cwd,
        ...(args.plannerModel || this.config.plannerModel
          ? { model: args.plannerModel || this.config.plannerModel }
          : {}),
        name: threadName("DSH Plan", args.task),
      }, exec.signal);
      await this.store.save(touch(record));
      const outcome = await this.codex.startTurn(record.plannerThreadId, {
        prompt: plannerPrompt(record.task),
        ...(args.plannerModel || this.config.plannerModel
          ? { model: args.plannerModel || this.config.plannerModel }
          : {}),
        effort: args.plannerEffort ?? this.config.plannerEffort,
        outputSchema: PLANNER_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        planMode: true,
      }, exec.signal);
      return await this.acceptPlannerOutcome(record, outcome, exec);
    } catch (error) {
      record.phase = "failed";
      record.error = errorMessage(error);
      await this.store.save(touch(record));
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
      }, exec.signal);
    }
    return this.acceptPlannerOutcome(record, outcome, exec);
  }

  async review(
    workflowId: string,
    input: { implementationSummary: string; changedFiles?: string[]; testResults?: string },
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    if (!record.planMarkdown || !record.plannerThreadId) throw new Error(`workflow ${workflowId} has no completed plan`);
    if (record.phase !== "executing" && record.phase !== "fixing") {
      throw new Error(`workflow ${workflowId} cannot be reviewed from phase ${record.phase}`);
    }
    record.phase = "reviewing";
    record.reviewCycles += 1;
    await this.store.save(touch(record));
    try {
      const git = await isGitRepository(record.cwd);
      const sourceThread = record.reviewerThreadId ?? record.plannerThreadId;
      if (record.reviewerThreadId) await this.codex.resumeThread(record.reviewerThreadId, record.cwd, exec.signal);
      const review = await this.codex.startReview({
        threadId: sourceThread,
        cwd: record.cwd,
        detached: !record.reviewerThreadId,
        target: git
          ? { type: "uncommittedChanges" }
          : { type: "custom", instructions: reviewInstructions(record, input) },
      }, exec.signal);
      record.reviewerThreadId = review.threadId;
      if (review.result.kind !== "completed") throw new Error("review unexpectedly requested user input");
      record.reviewerTurnId = review.result.turnId;
      const normalized = await this.codex.startTurn(review.threadId, {
        prompt: normalizeReviewPrompt(record, input, review.result.text),
        ...(this.config.reviewerModel ? { model: this.config.reviewerModel } : {}),
        effort: this.config.reviewerEffort,
        outputSchema: REVIEW_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      }, exec.signal);
      if (normalized.kind !== "completed") throw new Error("review normalization unexpectedly requested user input");
      const result = parseReview(normalized.text);
      record.latestReview = result;
      if (result.verdict === "pass") {
        record.phase = "passed";
        exec.deferContext(pluginMessage(`Codex Reviewer passed workflow ${record.id}. Report the verified implementation and tests to the user.`));
      } else if (record.reviewCycles >= this.config.maxReviewCycles) {
        record.phase = "blocked";
        exec.deferContext(pluginMessage(
          `Codex Reviewer still requests changes after ${record.reviewCycles} review cycles. Stop automatic repair and report the remaining findings:\n${formatFindings(result)}`,
        ));
      } else {
        record.phase = "fixing";
        exec.deferContext(pluginMessage(
          `Codex Reviewer requested changes for workflow ${record.id}. Fix every finding below in this same DSH session, rerun relevant tests, then call codex_workflow_review again before answering the user.\n${formatFindings(result)}`,
        ));
      }
      await this.store.save(touch(record));
      return record;
    } catch (error) {
      record.phase = "failed";
      record.error = errorMessage(error);
      await this.store.save(touch(record));
      throw error;
    }
  }

  async status(workflowId: string | undefined, exec: ToolRunContext): Promise<WorkflowRecord> {
    const agent = requireAgent(exec);
    const record = workflowId ? await this.store.load(workflowId) : await this.store.activeForSession(agent.id);
    if (!record) throw new Error(workflowId ? `unknown workflow ${workflowId}` : "no active Codex workflow for this session");
    if (record.dshSessionId !== agent.id) throw new Error("workflow belongs to another DSH session");
    return record;
  }

  async cancel(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const record = await this.owned(workflowId, exec);
    const threadId = record.reviewerThreadId ?? record.plannerThreadId;
    const turnId = record.reviewerTurnId ?? record.plannerTurnId;
    if (threadId && turnId) await this.codex.interrupt(threadId, turnId, exec.signal).catch(() => undefined);
    record.phase = "cancelled";
    await this.store.save(touch(record));
    return record;
  }

  async onTurnStopping(agent: Agent, turn: number): Promise<void> {
    const record = await this.store.activeForSession(agent.id);
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

  private async acceptPlannerOutcome(
    record: WorkflowRecord,
    outcome: TurnWaitResult,
    exec: ToolRunContext,
  ): Promise<WorkflowRecord> {
    record.plannerTurnId = outcome.turnId;
    if (outcome.kind === "needs_input") {
      this.pending.set(record.id, outcome);
      record.phase = "waiting_input";
      record.questions = outcome.request.questions;
      record.pendingInput = { turnId: outcome.turnId, itemId: outcome.request.itemId };
      await this.store.save(touch(record));
      return record;
    }
    this.pending.delete(record.id);
    if (outcome.status !== "completed") throw new Error(outcome.error ?? `planner turn ${outcome.status}`);
    const result = parsePlanner(outcome.text);
    if (result.status === "needs_input") {
      record.phase = "waiting_input";
      record.questions = result.questions;
      record.assumptions = result.assumptions;
    } else if (result.status === "ready" && result.planMarkdown?.trim()) {
      record.phase = "executing";
      record.planMarkdown = ensurePlanBlock(result.planMarkdown);
      record.assumptions = result.assumptions;
      record.questions = [];
      record.pendingInput = undefined;
      exec.deferContext(pluginMessage(executionPrompt(record)));
    } else {
      record.phase = "failed";
      record.error = result.message ?? "Codex planner did not return a usable plan";
    }
    await this.store.save(touch(record));
    return record;
  }

  private async owned(workflowId: string, exec: ToolRunContext): Promise<WorkflowRecord> {
    const record = await this.store.load(workflowId);
    if (!record) throw new Error(`unknown workflow ${workflowId}`);
    if (record.dshSessionId !== requireAgent(exec).id) throw new Error("workflow belongs to another DSH session");
    return record;
  }
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

function reviewInstructions(record: WorkflowRecord, input: { implementationSummary: string; changedFiles?: string[]; testResults?: string }): string {
  return `Review the current workspace read-only against this approved plan. Focus on correctness, regressions, security, and missing tests. Do not edit files.\n\nPLAN:\n${record.planMarkdown}\n\nIMPLEMENTATION SUMMARY:\n${input.implementationSummary}\n\nCHANGED FILES:\n${(input.changedFiles ?? []).join("\n") || "not supplied"}\n\nTEST RESULTS:\n${input.testResults ?? "not supplied"}`;
}

function normalizeReviewPrompt(
  record: WorkflowRecord,
  input: { implementationSummary: string; changedFiles?: string[]; testResults?: string },
  rawReview: string,
): string {
  return `Convert the code review you just completed into the required JSON schema. verdict is pass only when there are no actionable correctness, regression, security, or material test findings. Preserve concrete file and line references.\n\nWorkflow: ${record.id}\nImplementation: ${input.implementationSummary}\nRaw review:\n${rawReview}`;
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
  if (!isSeverity(finding.severity) || typeof finding.title !== "string" || typeof finding.body !== "string") {
    throw new Error("invalid review finding");
  }
  return {
    severity: finding.severity,
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
    return `${index + 1}. [${finding.severity}] ${finding.title}${location}: ${finding.body}`;
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

function touch(record: WorkflowRecord): WorkflowRecord {
  record.updatedAt = new Date().toISOString();
  return record;
}

function threadName(prefix: string, text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return `${prefix}: ${compact.slice(0, 72)}`;
}

async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, windowsHide: true });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
