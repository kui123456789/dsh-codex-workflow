import type { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";

export type AutoTriggerMode = "off" | "complex" | "always";

export const AUTO_TRIGGER_SECTION_NAME = "plugin:dsh-codex-workflow:auto-trigger";
export const AUTO_TRIGGER_SECTION_ORDER = 190;

type PromptRegistry = Pick<SystemPrompt, "section">;

/** Register the model-facing policy that lets DSH decide when to start Codex. */
export function registerAutoTriggerPrompt(systemPrompt: PromptRegistry, mode: AutoTriggerMode): () => void {
  if (mode === "off") return () => undefined;
  return systemPrompt.section({
    name: AUTO_TRIGGER_SECTION_NAME,
    order: AUTO_TRIGGER_SECTION_ORDER,
    text: autoTriggerGuidance(mode),
  });
}

export function autoTriggerGuidance(mode: Exclude<AutoTriggerMode, "off">): string {
  const scope = mode === "always"
    ? `AUTO-TRIGGER MODE: always. For every user-requested development task that intends to modify code, configuration, tests, build files, or documentation as part of an implementation, start the Codex planning workflow before making changes.`
    : `AUTO-TRIGGER MODE: complex. Start the Codex planning workflow only when a user-requested development task intends to make changes AND at least one condition applies: it likely spans multiple files/modules or cross-layer interfaces; it changes architecture, a public API, data structures, persistence, concurrency, security, lifecycle, migration, compatibility, or release behavior; it is a recurring or root-cause-unclear defect requiring diagnosis and regression tests; the user requests a mature, stable, complete, end-to-end, or release-quality implementation; or the scope is uncertain but likely requires coordinated implementation and testing.`;

  return [
    "DSH CODEX WORKFLOW AUTO-TRIGGER POLICY",
    scope,
    "Do not auto-trigger for ordinary questions, explanations, translation, status queries, read-only inspection/research, Git-only operations, or an obviously local low-risk edit such as a typo, constant, or simple configuration value.",
    "An explicit user instruction to work directly, skip planning, or not use Codex always overrides auto-triggering.",
    "Never auto-trigger from plugin-generated plan delivery, clarification continuation, review verdict, repair, submission, or other workflow-control messages. Never start a second workflow while this DSH session is already planning, executing, reviewing, fixing, submitting, or continuing one.",
    "If complexity is uncertain, perform only the minimum read-only inspection needed to decide. Do not edit files or run state-changing implementation commands before the decision.",
    "When auto-triggering, briefly tell the user: \"检测到复杂开发任务，先调用 Codex 制定计划。\" Then call codex_workflow_start exactly once before any modification. This prevents duplicate starts and is not a permanent attempt quota after a failed startup; never automatically start a replacement for an interrupted workflow. This DSH-led path starts the NPM Codex CLI App Server in the background with an ephemeral thread; the plan and later review appear in DSH's Codex Review right sidebar and do not require opening Codex Desktop. Pass a self-contained task containing the user's complete goal, constraints, and acceptance requirements, not a short summary.",
    "If the Planner needs input, ask the questions in the original DSH session and continue with codex_workflow_continue. A status phase of waiting_input needs this clarification tool, even though failure continuation.available is false. It reuses the original child/thread and rejects lost input handles without starting a replacement. When the plan is ready, execute it in this DSH session, run tests, and call codex_workflow_review for every review round. Use codex_workflow_submit only for a workflow explicitly created by the Codex-led bridge; do not create a dispatch_plan or wait for a Desktop Codex task for a normal DSH-led workflow.",
    "When a workflow call is interrupted before returning an id, or the user says 继续 after a Planner/Reviewer failure, first call codex_workflow_status without an id. For a DSH-led workflow, send a new model continuation through codex_workflow_resume (workflowId is optional) only when status.continuation.available is true; safe receipt inspection and original-turn cleanup below are separate operations that may run while it is false. A waiting record with retryState alone does not prove that its original thread is available. If continuation.reason is running, wait for the existing operation and do not duplicate it. For other unavailable reasons, report continuation.reason (or the status lookup error) precisely. Do not author a substitute plan/review in the parent session or start a replacement workflow. If startup ended before a thread id was returned, or the old ephemeral process has been lost, report that the original thread cannot be resumed instead of claiming recovery.",
    "For start_receipt_pending, the original submitted model operation is still waiting for its real reply. In a DSH-led workflow, wait for that reply or use resume only to check the retained operation without sending turn/start or review/start again. A genuine late reply lets resume reattach the same turn with fresh callbacks and no replacement model request. start_receipt_invalid remains unconfirmed and requires original cleanup; never fabricate a turn handle or create a replacement. Bridge receipts recover through the original submission's background retry even when continuation.available becomes true; do not call foreground resume or resubmit unchanged material.",
    "For a DSH-led workflow, if continuation.reason is interruption_unconfirmed, the original server turn is not confirmed ended. Any native answer that has already been submitted must not be sent again. You may call codex_workflow_resume to retry only cleanup of that original turn; it sends a short continuation on the same thread only after interruption is confirmed. Bridge recovery keeps its original submission's background retry. Never repeat the native answer, start a replacement Planner or write a substitute plan while waiting for confirmation.",
    "If a Bridge background review reports original_reviewer_unavailable, original_review_result_unavailable, thread_unavailable or handle_unavailable, report the original Reviewer or its completed review result as unavailable. A lost completed result means its readable review already finished; do not claim that the review never ran. Do not automatically call codex_workflow_submit again for unchanged evidence, create a replacement Reviewer, or author a substitute plan/review in the parent session. Verified changed workspace evidence permits a new business review; newReviewRound=true for unchanged evidence is only for a user-requested new independent round, never a workaround for failure recovery.",
  ].join("\n");
}
