import { defineTool, type JsonValue, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { WorkflowConfig } from "./types.js";
import type { WorkflowManager } from "./workflow.js";

const jsonOutput = {
  schema: { type: "json" as const },
  render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
};

/**
 * Tool timeout budgets. A tool may NEVER be cut by the host before the plugin's
 * own (configurable) operation could finish:
 *  - start/continue run ONE Codex turn bounded by turnTimeoutMs;
 *  - review/review_only run TWO serial turns (the review turn, then the
 *    normalize turn), each of which can independently exhaust turnTimeoutMs;
 *  - submit only validates, captures evidence, persists the submission and
 *    starts a manager-owned background Reviewer task.
 * Budgets are computed overflow-safely (saturated at MAX_SAFE_INTEGER) with a
 * cleanup margin so the host never pre-empts a legitimate operation.
 */
const CLEANUP_MARGIN_MS = 15_000;

function saturatedAdd(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    if (total > Number.MAX_SAFE_INTEGER - value) return Number.MAX_SAFE_INTEGER;
    total += value;
  }
  return total;
}

/** start/continue: one turn + margin. */
function singleTurnToolTimeout(turnTimeoutMs: number): number {
  return saturatedAdd(turnTimeoutMs, CLEANUP_MARGIN_MS);
}

/** review/review_only: two serial turns (review + normalize) + margin. */
function reviewToolTimeout(turnTimeoutMs: number): number {
  return saturatedAdd(turnTimeoutMs, turnTimeoutMs, CLEANUP_MARGIN_MS);
}

export function createWorkflowTools(manager: WorkflowManager, config: WorkflowConfig): ToolDefinition[] {
  const startTimeout = singleTurnToolTimeout(config.turnTimeoutMs);
  const reviewTimeout = reviewToolTimeout(config.turnTimeoutMs);
  const instantTimeout = 60_000;
  return [
    defineTool({
      name: "codex_workflow_start",
      description: "Ask Codex to inspect this workspace read-only and produce the implementation plan that this same DSH session must execute, test, and submit to Codex review.",
      parameters: {
        task: { type: "string", required: true, description: "The complete coding task for Codex to plan." },
        plannerModel: { type: "string", description: "Optional Codex planner model override." },
        plannerEffort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      },
      output: jsonOutput,
      timeoutMs: startTimeout,
      execute: async (args, exec) => asJson(await manager.start(args, exec)),
    }),
    defineTool({
      name: "codex_workflow_continue",
      description: "Continue a Codex planning turn after the user answered its clarification questions.",
      parameters: {
        workflowId: { type: "string", required: true },
        answers: { type: "json", required: true, description: "Object mapping question ids to arrays of answer strings." },
      },
      output: jsonOutput,
      timeoutMs: startTimeout,
      execute: async (args, exec) => asJson(await manager.continue(args.workflowId, normalizeAnswers(args.answers), exec)),
    }),
    defineTool({
      name: "codex_workflow_review",
      description: "Send the implementation in this workspace to an independent read-only Codex Reviewer. Call after implementing the plan and after every repair round.",
      parameters: {
        workflowId: { type: "string", required: true },
        implementationSummary: { type: "string", required: true },
        changedFiles: { type: "array", items: { type: "string" } },
        testResults: { type: "string" },
      },
      output: jsonOutput,
      timeoutMs: reviewTimeout,
      execute: async (args, exec) => asJson(await manager.review(args.workflowId, {
        implementationSummary: args.implementationSummary,
        ...(args.changedFiles ? { changedFiles: args.changedFiles } : {}),
        ...(args.testResults ? { testResults: args.testResults } : {}),
      }, exec)),
    }),
    defineTool({
      name: "codex_workflow_review_only",
      description: "Review the current workspace with an independent read-only Codex Reviewer without running the Planner. Reuses the same evidence, verdict-gate, no-change and cycle-limit pipeline as normal reviews.",
      parameters: {
        task: { type: "string", description: "Optional scope of the review; a sensible default is used when omitted." },
        implementationSummary: { type: "string", required: true },
        changedFiles: { type: "array", items: { type: "string" }, description: "Required for non-git workspaces so changes can be observed." },
        testResults: { type: "string" },
        reviewerModel: { type: "string", description: "Optional Codex reviewer model override." },
        reviewerEffort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      },
      output: jsonOutput,
      timeoutMs: reviewTimeout,
      execute: async (args, exec) => asJson(await manager.reviewOnly({
        task: args.task,
        implementationSummary: args.implementationSummary,
        ...(args.changedFiles ? { changedFiles: args.changedFiles } : {}),
        ...(args.testResults ? { testResults: args.testResults } : {}),
        ...(args.reviewerModel ? { reviewerModel: args.reviewerModel } : {}),
        ...(args.reviewerEffort ? { reviewerEffort: args.reviewerEffort } : {}),
      }, exec)),
    }),
    defineTool({
      name: "codex_workflow_submit",
      description: "Queue the implementation of a Codex-bridge workflow for background Codex review. Returns immediately after durable persistence; the verdict or a terminal error will automatically wake this same DSH session.",
      parameters: {
        workflowId: { type: "string", required: true },
        implementationSummary: { type: "string", required: true },
        changedFiles: { type: "array", items: { type: "string" } },
        testResults: { type: "string" },
      },
      output: jsonOutput,
      timeoutMs: instantTimeout,
      execute: async (args, exec) => {
        const record = await manager.submit(args.workflowId, {
          implementationSummary: args.implementationSummary,
          ...(args.changedFiles ? { changedFiles: args.changedFiles } : {}),
          ...(args.testResults ? { testResults: args.testResults } : {}),
        }, exec);
        exec.concludeTurn();
        return asJson({
          ...record,
          backgroundReview: true,
          statusMessage: "Codex Reviewer 正在后台运行；当前 DSH turn 已结束，结果会自动回到本会话。",
        });
      },
    }),
    defineTool({
      name: "codex_workflow_decide",
      description: "Decide how to handle non-blocking Codex review findings. Only valid while the workflow is waiting_review_decision. accept ships as-is; fix enters the repair loop.",
      parameters: {
        workflowId: { type: "string", required: true },
        decision: { type: "string", enum: ["accept", "fix"], required: true },
        note: { type: "string", description: "Optional note recorded with the decision." },
      },
      output: jsonOutput,
      timeoutMs: instantTimeout,
      execute: async (args, exec) => asJson(await manager.decide(args.workflowId, {
        decision: args.decision,
        ...(args.note ? { note: args.note } : {}),
      }, exec)),
    }),
    defineTool({
      name: "codex_workflow_status",
      description: "Read the current phase, plan, Codex task ids, review findings and evidence, and result of a Codex workflow owned by this DSH session.",
      parameters: { workflowId: { type: "string" } },
      output: jsonOutput,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => asJson(await manager.status(args.workflowId, exec)),
    }),
    defineTool({
      name: "codex_workflow_cancel",
      description: "Cancel the active Codex turn and mark this DSH session's workflow cancelled.",
      parameters: { workflowId: { type: "string", required: true } },
      output: jsonOutput,
      timeoutMs: instantTimeout,
      execute: async (args, exec) => asJson(await manager.cancel(args.workflowId, exec)),
    }),
  ];
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function normalizeAnswers(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("answers must be an object");
  return Object.fromEntries(Object.entries(value).map(([id, answer]) => {
    if (typeof answer === "string") return [id, [answer]];
    if (Array.isArray(answer) && answer.every((item) => typeof item === "string")) return [id, answer];
    throw new Error(`answer ${id} must be a string or string array`);
  }));
}
