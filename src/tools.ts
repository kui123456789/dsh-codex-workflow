import { APPENDED_READBACK_TIMEOUT_MS } from "./app-server.js";
import { defineTool, type JsonValue, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { WorkflowConfig } from "./types.js";
import type { WorkflowManager } from "./workflow.js";

const jsonOutput = {
  schema: { type: "json" as const },
  render: (_args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
};

/**
 * Tool timeout budgets. A tool may NEVER be cut by the host before the plugin's
 * own (configurable) operation could finish — the budget is PROVABLE: every
 * serial step is bounded either by `turnTimeoutMs` (model turns) or by the
 * tighter `rpcTimeoutMs` (control RPCs), and the budget covers the WORST-CASE
 * serial path of each tool:
 *  - start/continue: FOUR serial turns — visible plan turn + ephemeral
 *    conversion fork + (when the first visible reply is not a complete plan)
 *    one controlled completion turn on the same task + a SECOND conversion
 *    fork;
 *  - review/review_only: SEVEN serial turns — native review turn + (when the
 *    persisted native review violates the display contract) one visible
 *    rewrite turn + the ephemeral conversion fork + the 1.0.10 review-authority
 *    alignment fork + (on conflict) one visible reconciliation turn on the
 *    same durable task + a SECOND conversion fork + a SECOND alignment fork;
 *  - submit only validates, captures evidence, persists the submission and
 *    starts a manager-owned background review on the existing workflow task.
 *  - review/review_only additionally reserve ONE bounded persisted-read-back
 *    window per readable turn (the native review, the display rewrite and the
 *    reconciliation turn each poll {@link APPENDED_READBACK_TIMEOUT_MS} for
 *    the authoritative text).
 * Budgets are computed overflow-safely (saturated at MAX_SAFE_INTEGER) with a
 * cleanup margin so the host never pre-empts a legitimate operation, including
 * the completion/rewrite/reconciliation/read-back/cleanup paths at the
 * production-aligned 600 s turn ceiling.
 */
const CLEANUP_MARGIN_MS = 15_000;

/** Worst-case serial TURNS per tool flow (each independently bounded by
 * `turnTimeoutMs`): the Planner worst path is visible plan turn → conversion
 * fork → completion turn → conversion fork; the reviewer worst path is native
 * review turn → display-rewrite turn → conversion fork → authority-alignment
 * fork → reconciliation turn → second conversion fork → second alignment fork
 * (the 1.0.10 authority path only engages its extra turns when the alignment
 * finds a conflict; the budget must cover it regardless). */
export const PLANNER_MAX_TURNS = 4;
export const REVIEW_MAX_TURNS = 7;

/** Upper bound on the number of SERIAL control RPCs (thread/start,
 * thread/name/set, collaborationMode/list, turn/start, thread/fork,
 * thread/unsubscribe, model/list, settings/update, thread/read baselines and
 * read-backs, review/start, ...) a tool flow can issue before its turn waits.
 * The Planner reaches ≈15; review/review_only reaches ≈31 with its 1.0.10
 * authority path (alignment fork, reconciliation turn, second conversion fork
 * and second alignment fork each add a thread/fork + collaborationMode/list +
 * turn/start + thread/unsubscribe or turn/start + settings, plus one read-back
 * poll per visible turn). MAX_SERIAL_RPCS = 40 covers both with headroom. The
 * budgets multiply this by the (tighter) control RPC timeout, so the total
 * stays provable: slow control RPCs can never make the host pre-empt a tool
 * before its own cleanup. */
export const MAX_SERIAL_RPCS = 40;

function saturatedAdd(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    if (total > Number.MAX_SAFE_INTEGER - value) return Number.MAX_SAFE_INTEGER;
    total += value;
  }
  return total;
}

function rpcTimeoutOf(config: WorkflowConfig): number {
  return config.rpcTimeoutMs ?? Math.max(5_000, Math.min(config.turnTimeoutMs, 60_000));
}

/** start/continue: the Planner worst path of FOUR serial turns (visible +
 * conversion + completion + conversion) + every control RPC at its own
 * timeout + margin. */
export function startToolTimeout(turnTimeoutMs: number, rpcTimeoutMs: number): number {
  return saturatedAdd(turnTimeoutMs * PLANNER_MAX_TURNS, MAX_SERIAL_RPCS * rpcTimeoutMs, CLEANUP_MARGIN_MS);
}

/** review/review_only: SEVEN serial turns (native + display rewrite +
 * conversion + authority alignment + reconciliation + second conversion +
 * second alignment) + RPCs + one bound for EACH persisted read-back (the
 * native read-back, the rewrite read-back and the reconciliation read-back
 * poll a bounded rollout window) + margin. */
export function reviewToolTimeout(turnTimeoutMs: number, rpcTimeoutMs: number): number {
  return saturatedAdd(
    turnTimeoutMs * REVIEW_MAX_TURNS,
    MAX_SERIAL_RPCS * rpcTimeoutMs,
    3 * APPENDED_READBACK_TIMEOUT_MS,
    CLEANUP_MARGIN_MS,
  );
}

export function createWorkflowTools(manager: WorkflowManager, config: WorkflowConfig): ToolDefinition[] {
  const rpcTimeoutMs = rpcTimeoutOf(config);
  const startTimeout = startToolTimeout(config.turnTimeoutMs, rpcTimeoutMs);
  const reviewTimeout = reviewToolTimeout(config.turnTimeoutMs, rpcTimeoutMs);
  const instantTimeout = 60_000;
  return [
    defineTool({
      name: "codex_workflow_start",
      description: "Start the Codex planning workflow before making changes. DSH may call this autonomously when the installed auto-trigger policy matches the user's development task. Call it at most once per task/session: Codex inspects the bound workspace read-only and returns the plan that this same DSH session must execute, test, and submit to the existing Codex task for review.",
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
      description: "Append an independent read-only Codex review to this workflow's existing Codex task: for planned workflows that is the original Planner task, for review_only it is the workflow's dedicated review task (no Planner exists). Call after implementing the plan and after every repair round; re-reviews reuse the same task.",
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
