/**
 * DSH 0.1.7 replaced the shared catch-all `plugin` message source with a
 * MERGE-EXTENSIBLE sum type: `MessageSourceMap` is augmented by each producer in
 * its own module, and `MessageSource.kind` answers *who produced this* while
 * `form` answers *what kind of thing it is* (the two axes are deliberately
 * independent). There is no longer a generic `plugin` kind to borrow.
 *
 * Declaring the kind here — exactly the way first-party producers such as
 * `dsh-agent-instructions` declare theirs — keeps every message this plugin
 * injects fully typed. A cast would compile, but it would hide the contract from
 * the compiler AND leave the harness unable to attribute our context to a
 * declared producer.
 */
export interface CodexWorkflowSource {
  kind: "dsh-codex-workflow";
}

/**
 * The two context forms this plugin injects:
 *   - `relay`  — a message addressed to another agent (a plan handoff, a
 *                verdict, a submission outcome);
 *   - `notice` — a one-off account of something that just happened, which the
 *                form requires to carry its short summary.
 */
export type CodexWorkflowMessageSource =
  | (CodexWorkflowSource & { form: "relay" })
  | (CodexWorkflowSource & { form: "notice"; summary: string });

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "dsh-codex-workflow": CodexWorkflowMessageSource;
  }
}

/** Source of an inter-agent relay message (plan handoff, verdict, outcome). */
export function relaySource(): CodexWorkflowMessageSource {
  return { kind: "dsh-codex-workflow", form: "relay" };
}

/** Source of a one-off notice carrying its short account. */
export function noticeSource(summary: string): CodexWorkflowMessageSource {
  return { kind: "dsh-codex-workflow", form: "notice", summary };
}
