/**
 * Review-time contract shared by the App Server client and the reviewer
 * prompts: the Reviewer runs a silent, non-collaborative, single-verdict turn.
 *
 * `developer_instructions` is injected at the protocol level (as a
 * `collaborationMode` turn setting) in addition to the prompt block, so it is
 * enforced even if the model never sees a prompt-only instruction.
 */
export const SILENT_REVIEW_DEVELOPER_INSTRUCTIONS = [
  "You are the read-only Reviewer in a DSH-controlled coding workflow.",
  "Conduct the review silently: emit NO commentary, NO progress messages, and NO intermediate text.",
  "Do NOT use collaboration, sub-agent, delegation, or task-creation capabilities of any kind.",
  "Do NOT create, fork, resume, or delegate to any other task or thread.",
  "Run only the read-only inspection commands that are necessary for the review.",
  "When your review is complete, emit exactly one final message: the JSON verdict conforming to the enforced output schema. Nothing else.",
].join(" ");

/**
 * Human-readable block embedded in the reviewer prompts (bridge callback and
 * DSH-led review instructions). The protocol-level `developer_instructions`
 * above are the hard guarantee; this block keeps the instruction visible to
 * the model as well.
 */
export const SILENT_REVIEW_PROMPT_BLOCK =
  "Review SILENTLY: produce no commentary, progress, or intermediate messages and no sub-task or delegation; "
  + "do not create, fork, or delegate to any other task. Run only necessary read-only inspection. "
  + "Output exactly ONE final JSON verdict matching the enforced schema.";
