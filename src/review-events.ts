import z, { type ZodType } from "zod";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type { PlannerQuestion, ReviewResult, ReviewStep, WorkflowProcessState } from "./types.js";

export type CodexReviewId = string;

export interface CodexLiveEntry {
  kind: "message" | "plan" | "reasoning" | "tool";
  itemId: string;
  text: string;
  replace?: boolean;
  command?: string;
  cwd?: string;
  exitCode?: number;
  status?: string;
  files?: string[];
}

export interface CodexLiveEvent {
  workflowId: string;
  stage: "planning" | "reviewing";
  reviewId?: CodexReviewId;
  entries: CodexLiveEntry[];
  at: string;
}

export type CodexLiveViewEntry = Omit<CodexLiveEntry, "replace">;

export interface CodexPlanUpdatedEvent {
  workflowId: string;
  childSessionId?: string;
  status: "planning" | "waiting_input" | "ready" | "failed";
  processState?: WorkflowProcessState;
  planMarkdown?: string;
  questions: PlannerQuestion[];
  assumptions: string[];
  message?: string;
}

export interface CodexReviewStartEvent {
  workflowId: string;
  childSessionId?: string;
  reviewId: CodexReviewId;
  attempt: number;
  startedAt: string;
  mode: "planned" | "review_only" | "bridge";
}

export interface CodexReviewProgressEvent {
  workflowId: string;
  reviewId: CodexReviewId;
  step?: ReviewStep;
  processState: WorkflowProcessState;
  message?: string;
  elapsedMs?: number;
  at: string;
}

export interface CodexReviewEndEvent {
  workflowId: string;
  reviewId: CodexReviewId;
  processState: WorkflowProcessState;
  verdict?: ReviewResult["verdict"];
  result?: ReviewResult;
  visibleText?: string;
  summary?: string;
  error?: string;
  finishedAt: string;
}

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap {
    "dsh-codex-workflow/plan-updated": CodexPlanUpdatedEvent;
    "dsh-codex-workflow/review-start": CodexReviewStartEvent;
    "dsh-codex-workflow/review-progress": CodexReviewProgressEvent;
    "dsh-codex-workflow/review-end": CodexReviewEndEvent;
    "dsh-codex-workflow/live": CodexLiveEvent;
  }
}

export interface CodexPlanView {
  workflowId: string;
  childSessionId?: string;
  status: CodexPlanUpdatedEvent["status"];
  processState?: WorkflowProcessState;
  planMarkdown?: string;
  questions: PlannerQuestion[];
  assumptions: string[];
  message?: string;
  live?: CodexLiveViewEntry[];
}

export interface CodexReviewView {
  workflowId: string;
  childSessionId?: string;
  reviewId: CodexReviewId;
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  processState: WorkflowProcessState;
  step?: ReviewStep;
  message?: string;
  elapsedMs?: number;
  verdict?: ReviewResult["verdict"];
  result?: ReviewResult;
  visibleText?: string;
  summary?: string;
  error?: string;
  live?: CodexLiveViewEntry[];
}

export interface CodexWorkflowProjectionState {
  currentWorkflowId: string | null;
  plan: CodexPlanView | null;
  activeReview: CodexReviewView | null;
  reviews: CodexReviewView[];
  failure: string | null;
}

export interface CodexWorkflowProjection {
  currentWorkflowId: string | null;
  plan: CodexPlanView | null;
  activeReview: CodexReviewView | null;
  reviews: CodexReviewView[];
}

export type CodexWorkflowSessionEvent =
  | { type: "dsh-codex-workflow/plan-updated"; data: CodexPlanUpdatedEvent }
  | { type: "dsh-codex-workflow/review-start"; data: CodexReviewStartEvent }
  | { type: "dsh-codex-workflow/review-progress"; data: CodexReviewProgressEvent }
  | { type: "dsh-codex-workflow/review-end"; data: CodexReviewEndEvent }
  | { type: "dsh-codex-workflow/live"; data: CodexLiveEvent };

const CODEX_WORKFLOW_SESSION_EVENT_TYPES = [
  "dsh-codex-workflow/plan-updated",
  "dsh-codex-workflow/review-start",
  "dsh-codex-workflow/review-progress",
  "dsh-codex-workflow/review-end",
  "dsh-codex-workflow/live",
] as const;

/**
 * Register this plugin's session events before a host replays persisted history.
 * The host exposes this catalog as a mutable Set at runtime, although its
 * declaration is readonly for consumers that only need membership checks.
 */
export function registerCodexWorkflowSessionEventTypes(
  runtimeCatalog: Set<string> = KNOWN_SESSION_EVENT_TYPES as Set<string>,
): void {
  for (const type of CODEX_WORKFLOW_SESSION_EVENT_TYPES) runtimeCatalog.add(type);
}

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    codexWorkflow: CodexWorkflowProjectionState;
  }
  interface SessionProjectionMap {
    codexWorkflow: CodexWorkflowProjection;
  }
}

const reviewResultSchema = z.object({
  verdict: z.enum(["pass", "changes_requested"]),
  findings: z.array(z.any()),
  testGaps: z.array(z.string()),
  summary: z.string(),
}).passthrough();

const planSchema = z.object({
  workflowId: z.string(),
  status: z.enum(["planning", "waiting_input", "ready", "failed"]),
  processState: z.enum(["running", "waiting", "completed", "failed", "cancelled", "stale"]).optional(),
  planMarkdown: z.string().optional(),
  questions: z.array(z.any()),
  assumptions: z.array(z.string()),
  message: z.string().optional(),
  live: z.array(z.object({ kind: z.enum(["message", "plan", "reasoning", "tool"]), itemId: z.string(), text: z.string() })).optional(),
}).passthrough();

const reviewSchema = z.object({
  workflowId: z.string(),
  reviewId: z.string(),
  attempt: z.number().int().nonnegative(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  processState: z.enum(["running", "waiting", "completed", "failed", "cancelled", "stale"]),
  step: z.enum([
    "reviewing", "review_native_turn", "review_readback", "review_display_rewrite",
    "review_conversion", "review_alignment", "review_reconciliation", "review_finalizing",
  ]).optional(),
  message: z.string().optional(),
  elapsedMs: z.number().nonnegative().optional(),
  verdict: z.enum(["pass", "changes_requested"]).optional(),
  result: reviewResultSchema.optional(),
  visibleText: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  live: z.array(z.object({ kind: z.enum(["message", "plan", "reasoning", "tool"]), itemId: z.string(), text: z.string() })).optional(),
}).passthrough();

const projectionSchema = z.object({
  currentWorkflowId: z.string().nullable(),
  plan: planSchema.nullable(),
  activeReview: reviewSchema.nullable(),
  reviews: z.array(reviewSchema),
}) as unknown as ZodType<CodexWorkflowProjection>;

const stateSchema = z.object({
  currentWorkflowId: z.string().nullable(),
  plan: planSchema.nullable(),
  activeReview: reviewSchema.nullable(),
  reviews: z.array(reviewSchema),
  failure: z.string().nullable(),
}) as unknown as ZodType<CodexWorkflowProjectionState>;

function upsert(reviews: CodexReviewView[], next: CodexReviewView): CodexReviewView[] {
  const index = reviews.findIndex(entry => entry.reviewId === next.reviewId);
  if (index < 0) return [...reviews, next];
  return reviews.map((entry, i) => i === index ? next : entry);
}

function appendLive(current: CodexLiveViewEntry[] | undefined, entries: CodexLiveEntry[]): CodexLiveViewEntry[] {
  const next = [...(current ?? [])];
  for (const entry of entries) {
    const index = next.findIndex((item) => item.kind === entry.kind && item.itemId === entry.itemId);
    if (index < 0) {
      if (next.length >= 96) next.shift();
      next.push({ kind: entry.kind, itemId: entry.itemId, text: entry.text.slice(0, 65_536),
        ...(entry.command ? { command: entry.command } : {}), ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}), ...(entry.status ? { status: entry.status } : {}),
        ...(entry.files ? { files: entry.files } : {}) });
    } else {
      next[index] = { ...next[index]!, text: (entry.replace ? entry.text : next[index]!.text + entry.text).slice(0, 65_536),
        ...(entry.command ? { command: entry.command } : {}), ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}), ...(entry.status ? { status: entry.status } : {}),
        ...(entry.files ? { files: entry.files } : {}) };
    }
  }
  return next;
}

export function applyCodexWorkflowProjection(
  state: CodexWorkflowProjectionState,
  event: SessionEvent,
): CodexWorkflowProjectionState {
  if (state.failure !== null) return state;
  try {
    switch (event.type) {
      case "dsh-codex-workflow/plan-updated": {
        const newWorkflow = state.currentWorkflowId !== event.data.workflowId;
        const plan: CodexPlanView = { workflowId: event.data.workflowId, status: event.data.status,
          ...(event.data.processState === undefined ? {} : { processState: event.data.processState }),
          ...(event.data.childSessionId ?? (!newWorkflow ? state.plan?.childSessionId : undefined)
            ? { childSessionId: event.data.childSessionId ?? state.plan?.childSessionId } : {}),
          ...(event.data.planMarkdown === undefined ? {} : { planMarkdown: event.data.planMarkdown }),
          questions: event.data.questions, assumptions: event.data.assumptions,
          ...(event.data.message === undefined ? {} : { message: event.data.message }),
          live: state.plan?.workflowId === event.data.workflowId ? state.plan.live ?? [] : [] };
        return { ...state, currentWorkflowId: event.data.workflowId, plan,
          activeReview: newWorkflow ? null : state.activeReview,
          reviews: newWorkflow ? [] : state.reviews };
      }
      case "dsh-codex-workflow/review-start": {
        const review: CodexReviewView = { ...event.data, processState: "running" };
        const newWorkflow = state.currentWorkflowId !== event.data.workflowId;
        return { ...state, currentWorkflowId: event.data.workflowId,
          plan: newWorkflow ? null : state.plan,
          activeReview: review, reviews: upsert(newWorkflow ? [] : state.reviews, review) };
      }
      case "dsh-codex-workflow/review-progress": {
        const current = state.reviews.find(entry => entry.reviewId === event.data.reviewId)
          ?? { workflowId: event.data.workflowId, reviewId: event.data.reviewId, attempt: 0, startedAt: event.data.at };
        const review: CodexReviewView = { ...current, ...event.data };
        return { ...state, currentWorkflowId: event.data.workflowId, activeReview: review, reviews: upsert(state.reviews, review) };
      }
      case "dsh-codex-workflow/review-end": {
        const current = state.reviews.find(entry => entry.reviewId === event.data.reviewId)
          ?? { workflowId: event.data.workflowId, reviewId: event.data.reviewId, attempt: 0, startedAt: event.data.finishedAt };
        const review: CodexReviewView = { ...current, ...event.data };
        return { ...state, currentWorkflowId: event.data.workflowId, activeReview: null, reviews: upsert(state.reviews, review) };
      }
      case "dsh-codex-workflow/live": {
        if (event.data.stage === "planning") {
          const newWorkflow = state.currentWorkflowId !== event.data.workflowId;
          const plan = state.plan?.workflowId === event.data.workflowId
            ? state.plan
            : { workflowId: event.data.workflowId, status: "planning" as const, questions: [], assumptions: [] };
          return { ...state, currentWorkflowId: event.data.workflowId,
            plan: { ...plan, live: appendLive(plan.live, event.data.entries) },
            activeReview: newWorkflow ? null : state.activeReview,
            reviews: newWorkflow ? [] : state.reviews };
        }
        if (!event.data.reviewId) return state;
        const review = state.reviews.find((item) => item.reviewId === event.data.reviewId)
          ?? { workflowId: event.data.workflowId, reviewId: event.data.reviewId, attempt: 0,
            startedAt: event.data.at, processState: "running" as const };
        const updated = { ...review, live: appendLive(review.live, event.data.entries) };
        return { ...state, currentWorkflowId: event.data.workflowId,
          activeReview: state.activeReview?.reviewId === event.data.reviewId ? updated : state.activeReview,
          reviews: upsert(state.reviews, updated) };
      }
      default:
        return state;
    }
  } catch (error) {
    return { ...state, failure: `codex workflow projection failed at session event ${event.seq}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export const codexWorkflowProjectionDefinition = {
  key: "codexWorkflow",
  stateSchema,
  init: (): CodexWorkflowProjectionState => ({ currentWorkflowId: null, plan: null, activeReview: null, reviews: [], failure: null }),
  apply: applyCodexWorkflowProjection,
  wire: { viewSchema: projectionSchema, view: (state: CodexWorkflowProjectionState): CodexWorkflowProjection => ({
    currentWorkflowId: state.currentWorkflowId, plan: state.plan, activeReview: state.activeReview, reviews: state.reviews,
  }) },
  stateVersion: 2,
} satisfies ProjectionDefinition<"codexWorkflow", CodexWorkflowProjectionState>;
