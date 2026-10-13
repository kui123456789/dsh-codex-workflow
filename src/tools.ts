import { APPENDED_READBACK_TIMEOUT_MS } from "./app-server.js";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { JsonValue } from "@deepseek-ai/dsh-util-values";
import type { WorkflowConfig } from "./types.js";
import type { WorkflowManager } from "./workflow.js";
import { formatWorkflowToolResult } from "./tool-usage-render.js";
import { assertWorkflowToolTimeout } from "./tool-timeout-compat.js";

const jsonOutput = {
  schema: { type: "json" as const },
  render: (args: unknown, value: unknown) => [{ type: "text" as const, text: JSON.stringify(formatWorkflowToolResult(value,
    Boolean(args && typeof args === "object" && (args as Record<string, unknown>).includeUsageSources === true)), null, 2) }],
};

/**
 * Tool timeout budgets. A tool may NEVER be cut by the host before the plugin's
 * own (configurable) operation could finish — the budget is PROVABLE: every
 * serial step is bounded either by `turnTimeoutMs` (model turns) or by the
 * tighter `rpcTimeoutMs` (control RPCs), and the budget covers the WORST-CASE
 * serial path of each tool:
 *  - start/continue: FIVE serial turns — visible plan turn + one same-thread
 *    continuation + ephemeral
 *    conversion fork + (when the first visible reply is not a complete plan)
 *    one controlled completion turn on the same task + a SECOND conversion
 *    fork;
 *  - review/review_only: EIGHT serial turns — native review turn + one
 *    same-thread continuation + (when the
 *    persisted native review violates the display contract) one visible
 *    rewrite turn + the ephemeral conversion fork + the 1.0.10 review-authority
 *    alignment fork + (on conflict) one visible reconciliation turn on the
 *    same durable task + a SECOND conversion fork + a SECOND alignment fork;
 *  - CLI conversion/fallback additionally reserves its subprocess deadlines;
 *    a CLI reconciliation may include its own visible display repair.
 *  - submit only validates, captures evidence, persists the submission and
 *    starts a manager-owned background review on the workflow's dedicated
 *    Reviewer task (created on the first review — never the Planner or origin
 *    task, see 1.1.0).
 *  - review/review_only additionally reserve ONE bounded persisted-read-back
 *    window per readable turn (the native review, the display rewrite and the
 *    reconciliation turn each poll {@link APPENDED_READBACK_TIMEOUT_MS} for
 *    the authoritative text).
 * Budgets are computed overflow-safely (saturated at MAX_SAFE_INTEGER) with a
 * cleanup margin so the host never pre-empts a legitimate operation, including
 * the completion/rewrite/reconciliation/read-back/cleanup paths at the
 * production-aligned 600 s turn ceiling. Every serial model/control operation
 * reserves its own transient retry allowance. This is a host deadline upper
 * bound; it does not change the actual retry policy or number of continuations.
 * Unconfirmed interruption additionally observes the original process tree
 * for at most four seconds within the cleanup margin, then returns waiting.
 * A submitted start with no reply keeps its original receipt route; checking
 * or adopting that receipt grants no additional model start or retry budget.
 */
const CLEANUP_MARGIN_MS = 15_000;

/** Worst-case serial TURNS per tool flow (each independently bounded by
 * `turnTimeoutMs`): the Planner worst path is visible plan turn → one same-
 * thread continuation → conversion
 * fork → completion turn → conversion fork; the reviewer worst path is native
 * review turn → display-rewrite turn → conversion fork → authority-alignment
 * fork → reconciliation turn → second conversion fork → second alignment fork
 * (the 1.0.10 authority path only engages its extra turns when the alignment
 * finds a conflict; the budget must cover it regardless). */
export const PLANNER_MAX_TURNS = 5;
export const REVIEW_MAX_TURNS = 8;
/** CLI mode can normalize and align before reconciliation, then normalize and
 * align the correction (four subprocesses). Reconciliation also runs a visible
 * CLI turn and may repair its display once, giving six CLI turns in total. */
export const MAX_REVIEW_CLI_TURNS = 6;

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
 * before its own cleanup. Original-turn interruption acknowledgements and
 * a retained-turn cleanup at resume admission and creator-owned private seed
 * interruption/unsubscribe consume this same RPC reserve,
 * not the fixed cleanup margin. */
export const MAX_SERIAL_RPCS = 40;

function saturatedAdd(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    // A finite input can overflow during multiplication. Saturate that
    // required allowance instead of silently dropping it from the deadline.
    if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
    if (!Number.isFinite(value) || value <= 0) continue;
    if (total > Number.MAX_SAFE_INTEGER - value) return Number.MAX_SAFE_INTEGER;
    total += value;
  }
  return total;
}

function rpcTimeoutOf(config: WorkflowConfig): number {
  return config.rpcTimeoutMs ?? Math.max(5_000, Math.min(config.turnTimeoutMs, 60_000));
}

/** start/continue: the Planner worst path of FIVE serial turns (visible +
 * conversion + completion + conversion) + every control RPC at its own
 * timeout + the transient-retry budget + margin. */
export function startToolTimeout(turnTimeoutMs: number, rpcTimeoutMs: number, transientRetryBudgetMs = 0): number {
  return saturatedAdd(
    turnTimeoutMs * PLANNER_MAX_TURNS,
    MAX_SERIAL_RPCS * rpcTimeoutMs,
    retryAllowance(transientRetryBudgetMs, PLANNER_MAX_TURNS),
    CLEANUP_MARGIN_MS,
  );
}

/** review/review_only: EIGHT serial turns (native + same-thread continuation + display rewrite +
 * conversion + authority alignment + reconciliation + second conversion +
 * second alignment) + RPCs + one bound for EACH persisted read-back (the
 * native read-back, the rewrite read-back and the reconciliation read-back
 * poll a bounded rollout window) + optional CLI subprocess deadlines, each
 * independent retry budget, and margin. App Server failure and CLI fallback
 * consume additive time; callbackTimeoutMs=0 preserves three-argument callers. */
export function reviewToolTimeout(turnTimeoutMs: number, rpcTimeoutMs: number, transientRetryBudgetMs = 0, callbackTimeoutMs = 0): number {
  const cliTurns = callbackTimeoutMs > 0 ? MAX_REVIEW_CLI_TURNS : 0;
  return saturatedAdd(
    turnTimeoutMs * REVIEW_MAX_TURNS,
    MAX_SERIAL_RPCS * rpcTimeoutMs,
    cliTurns * callbackTimeoutMs,
    retryAllowance(transientRetryBudgetMs, REVIEW_MAX_TURNS + cliTurns),
    3 * APPENDED_READBACK_TIMEOUT_MS,
    CLEANUP_MARGIN_MS,
  );
}

/**
 * 1.1.1: how much extra wall clock the transient-retry policy can add to a tool.
 *
 * App Server/CLI turns and control RPCs each receive independent retry budgets. Reserve
 * one budget for every possible serial operation, including thread creation and
 * configuration, so repeated outages cannot exhaust the host deadline before
 * the plugin completes its own bounded work. This conservative allowance only
 * enlarges the host deadline; it grants no extra model attempts or continuations.
 */
function retryAllowance(transientRetryBudgetMs: number, maxSerialTurns: number): number {
  return transientRetryBudgetMs > 0 ? (maxSerialTurns + MAX_SERIAL_RPCS) * transientRetryBudgetMs : 0;
}

/** Validate complete-operation budgets before allocating host resources. */
export function workflowToolTimeouts(config: WorkflowConfig): { startTimeout: number; reviewTimeout: number } {
  const rpcTimeoutMs = rpcTimeoutOf(config);
  const startTimeout = startToolTimeout(config.turnTimeoutMs, rpcTimeoutMs, config.transientRetryBudgetMs);
  const reviewTimeout = reviewToolTimeout(config.turnTimeoutMs, rpcTimeoutMs, config.transientRetryBudgetMs, config.callbackTimeoutMs);
  assertWorkflowToolTimeout("codex_workflow_start/continue", startTimeout);
  assertWorkflowToolTimeout("codex_workflow_review/review_only/resume", Math.max(startTimeout, reviewTimeout));
  return { startTimeout, reviewTimeout };
}

export function createWorkflowTools(manager: WorkflowManager, config: WorkflowConfig): ToolDefinition[] {
  const { startTimeout, reviewTimeout } = workflowToolTimeouts(config);
  const instantTimeout = 60_000;
  return [
    defineTool({
      name: "codex_workflow_start",
      description: "Start the DSH-led Codex planning workflow before making changes. DSH may call this autonomously when the installed auto-trigger policy matches the user's development task. Codex runs through the NPM CLI App Server in a hidden ephemeral thread; the plan is returned to this DSH session and shown in the Codex Review right sidebar. Call it at most once per task/session to prevent duplicate starts; this is not a permanent attempt quota after a failed startup. If interrupted before returning workflowId, first call codex_workflow_status without an id. Send a model continuation through codex_workflow_resume with workflowId omitted only when status.continuation.available is true. For start_receipt_pending, resume may check only the original submitted operation; it sends no new model request. A genuine late reply permits reattaching that original turn, while start_receipt_invalid remains unconfirmed. For interruption_unconfirmed, codex_workflow_resume may retry cleanup of the original thread/turn pair even when continuation.available is false; it sends no new model turn until interruption is confirmed and never repeats submitted native answers. If continuation.reason is running, wait for the existing operation and do not duplicate it. For other unavailable reasons, report continuation.reason (or the status lookup error) precisely; do not create a replacement workflow or author a substitute plan/review in the parent session. The normal DSH-led path does not open Codex Desktop or use dispatch_plan.",
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
      description: "Continue a waiting_input Planner with the user's clarification answers in its original DSH child and App Server thread. A native question replies to its original request; a completed question turn receives only a short answer followup on the same thread. Identical concurrent answers share one execution; conflicting answers are rejected. An unavailable original input handle or thread is an error, never permission to start a replacement Planner. For a model-failure waiting state, use codex_workflow_resume after querying status.",
      parameters: {
        workflowId: { type: "string", required: true },
        answers: { type: "json", required: true, description: "Object mapping question ids to arrays of answer strings." },
      },
      output: jsonOutput,
      timeoutMs: startTimeout,
      execute: async (args, exec) => asJson(await manager.continue(args.workflowId, normalizeAnswers(args.answers), exec)),
    }),
    defineTool({
      name: "codex_workflow_resume",
      description: "Continue a waiting DSH-led Planner or foreground Reviewer in its original DSH child conversation and Codex App Server thread. Bridge reviews recover through their original submission's background retry, not this foreground tool; do not resubmit unchanged material. If retryState.awaitingCleanup is true, only retry confirmed cleanup of the rejected original turn; its primary terminal error is preserved and no model continuation is sent. First query codex_workflow_status. Send a new model continuation only when status.continuation.available is true; safe receipt checks and original-turn cleanup below may run while it is false. For start_receipt_pending, wait for the original reply or use resume to check that retained operation without repeating turn/start or review/start. Once its real reply arrives, resume reattaches the original turn using fresh callbacks with no replacement model request. For start_receipt_invalid, report the pending cleanup condition without fabricating a turn handle. For interruption_unconfirmed after a model wait or native answer, resume may retry cleanup of the original turn; no new model turn is sent until interruption is confirmed, and any submitted native answer is never repeated. Omit workflowId to find this DSH session's active workflow when the interrupted call returned no id. If continuation.reason is running, wait and do not duplicate the existing operation; for other unavailable reasons, report continuation.reason precisely. Planner stage recovery retries only unfinished conversion or completion; successful readable output is retained, and manual resume does not reset the original planning flow's one automatic continuation budget. Identical concurrent calls join one continuation. Do not replace the plan or review with a parent-authored result or start a replacement workflow. An interruption before thread creation or a lost ephemeral process cannot be resumed.",
      parameters: {
        workflowId: { type: "string", description: "Workflow id; omit to use this DSH session's active workflow." },
        instruction: { type: "string", description: "Optional short continuation instruction for the existing session." },
      },
      output: jsonOutput,
      timeoutMs: Math.max(startTimeout, reviewTimeout),
      execute: async (args, exec) => asJson(await manager.resume(args.workflowId, args.instruction, exec)),
    }),
    defineTool({
      name: "codex_workflow_review",
      description: "Run an independent read-only Codex review of this DSH-led workflow after implementation and after every repair round. Bridge-origin workflows must use codex_workflow_submit and their original background review; this foreground entry rejects them before creating resources. A new business review round uses a fresh hidden ephemeral Reviewer thread; a recoverable model failure continues once on the same Reviewer and can be resumed without creating another child. If a waiting Reviewer's original workspace evidence has changed, this explicit request starts a new business review on the same workflow, including after loss of its ephemeral process. Unchanged evidence keeps the original recovery path. Set newReviewRound=true for unchanged evidence only when the user explicitly requests a new independent review; never use it as failure recovery. Changing summary, test wording or file selection alone does not prove a workspace change. Any outstanding original turn interruption must be confirmed before starting a new round. Status and resume never replace the Reviewer. Progress and the readable verdict appear in the DSH right sidebar. No Codex Desktop task is created or resumed.",
      parameters: {
        workflowId: { type: "string", required: true },
        implementationSummary: { type: "string", required: true },
        changedFiles: { type: "array", items: { type: "string" }, description: "Required for non-Git workspaces: readable, workspace-contained files used to verify the review input before and after model execution." },
        testResults: { type: "string" },
        newReviewRound: { type: "boolean", description: "Set true only when the user explicitly requests a new independent review round; never use it for failure recovery." },
      },
      output: jsonOutput,
      timeoutMs: reviewTimeout,
      execute: async (args, exec) => asJson(await manager.review(args.workflowId, {
        implementationSummary: args.implementationSummary,
        ...(args.changedFiles ? { changedFiles: args.changedFiles } : {}),
        ...(args.testResults ? { testResults: args.testResults } : {}),
        ...(args.newReviewRound !== undefined ? { newReviewRound: args.newReviewRound } : {}),
      }, exec)),
    }),
    defineTool({
      name: "codex_workflow_review_only",
      description: "Review the current workspace with an independent read-only Codex Reviewer without running the Planner. A new review uses a hidden NPM CLI App Server ephemeral thread and appears in the DSH Codex Review right sidebar; recoverable model failures continue on that same thread. If interrupted before returning a workflow id or after a model failure, first call codex_workflow_status without an id. Continue the original review through codex_workflow_resume with workflowId omitted only when continuation.available is true; for start_receipt_pending, resume may inspect only its original submitted operation without another model start; for interruption_unconfirmed, resume may retry only the original turn cleanup. For running, wait for the existing operation. Report any other exact unavailable reason without creating another review-only workflow or authoring a substitute plan/review in the parent session. It uses the same evidence, verdict-gate, no-change and cycle-limit pipeline as normal reviews.",
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
      description: "Queue a workflow explicitly created by the Codex-led bridge for background review. Use this only when the workflow origin is codex_bridge and an external Codex task id is already stored. The Reviewer itself runs in a hidden NPM CLI App Server ephemeral thread; the verdict returns to this DSH session and the Codex Review right sidebar. A pending start receipt stays with this original submission's background retry; wait for it to adopt the real reply without resubmitting unchanged material or calling foreground codex_workflow_resume. If its readable review and conversion completed but authority validation failed, background recovery reuses that completed result and the original child; wait for validation instead of starting another Reviewer or replacing the result in the parent. submissionReviewPending indicates that this process-local validation checkpoint is pending, not an accepted verdict or a foreground model continuation. A lost checkpoint is reported explicitly without repeating the completed review; its readable review already ran. If the original Reviewer or its completed review result is unavailable, query status and report that state; do not automatically resubmit unchanged material or author a substitute plan/review in the parent session. Verified changed workspace evidence permits a new business review. Set newReviewRound=true for unchanged evidence only when the user explicitly requests a new independent review round; never use it to recover a failed original run or bypass unavailable resources. Changing summary or test wording does not establish a new round.",
      parameters: {
        workflowId: { type: "string", required: true },
        implementationSummary: { type: "string", required: true },
        changedFiles: { type: "array", items: { type: "string" } },
        testResults: { type: "string" },
        newReviewRound: { type: "boolean", description: "For unchanged evidence, set true only when the user explicitly requests a new independent review round; never use it for failure recovery." },
      },
      output: jsonOutput,
      timeoutMs: instantTimeout,
      execute: async (args, exec) => {
        const record = await manager.submit(args.workflowId, {
          implementationSummary: args.implementationSummary,
          ...(args.newReviewRound !== undefined ? { newReviewRound: args.newReviewRound } : {}),
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
      description: "Read the current phase, plan, review findings, evidence and continuation availability of a Codex workflow owned by this DSH session. Omit workflowId to find this session's active workflow after an interrupted call returned no id. With no active workflow, status can report only this session's latest failed Planner startup as diagnostics; that record is not resumable. A pending original creation response reports running: wait for its bounded receipt instead of ending the task or starting a replacement. Only continuation.available=true indicates that the original thread is eligible to continue at the time of observation; a waiting record alone does not prove it. For start_receipt_pending, wait for the original submitted model reply; a DSH-led workflow may use resume only to inspect its retained operation without another model start. start_receipt_invalid requires confirmed original cleanup, never a fabricated handle or replacement. Bridge pending receipts use the original submission's background retry even when available becomes true; do not call foreground resume or resubmit unchanged material. For interruption_unconfirmed in a DSH-led workflow, codex_workflow_resume may retry the original turn cleanup without starting a new model turn until confirmation. Waiting Reviewer probes read workspace evidence: workspace_changed requires a new business review round, and evidence_unavailable means the original review cannot currently be verified. The probe retains the original handle and sends no model request. If continuation.reason is running, wait for the existing operation. For other unavailable reasons, report the exact reason or lookup error without creating a replacement workflow or authoring a substitute plan/review.",
      parameters: {
        workflowId: { type: "string" },
        includeUsageSources: { type: "boolean", description: "Include detailed per-source usage snapshots in the displayed result; omitted by default to keep normal status concise." },
      },
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
