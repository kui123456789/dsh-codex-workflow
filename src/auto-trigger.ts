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
    "When auto-triggering, briefly tell the user: \"检测到复杂开发任务，先调用 Codex 制定计划。\" Then call codex_workflow_start exactly once before any modification. Pass a self-contained task containing the user's complete goal, constraints, and acceptance requirements, not a short summary.",
    "If the Planner needs input, ask the questions in the original DSH session and continue with codex_workflow_continue. When the plan is ready, execute it in this DSH session, run tests, and use the existing Codex review/repair loop.",
  ].join("\n");
}
