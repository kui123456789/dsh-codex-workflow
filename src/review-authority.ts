import type { ReviewResult } from "./types.js";

/**
 * 1.0.10 review-authority machinery.
 *
 * After the visible Reviewer reply is normalized into the public
 * `ReviewResult`, an INVISIBLE ephemeral fork (the same `normalizeInFork`
 * conversion machinery, low effort, same model, internal output schema) checks
 * every finding/test gap against the AUTHORITY HIERARCHY below. A conflict
 * never overwrites `latestReview`, never consumes a review cycle and never
 * asks DSH to change code: ONE visible reconciliation turn on the SAME
 * durable Codex task asks the Reviewer to rewrite the complete verdict per
 * the hierarchy, then the corrected review is re-normalized and re-aligned.
 * Only an aligned verdict is applied (one business cycle). Two consecutive
 * unresolved conflicts block the workflow with a reportable contract failure.
 *
 * This module is INTERNAL: it does not change the public `ReviewResult`, any
 * tool parameter, or the bridge protocol.
 */

/** The authority hierarchy shared by the reviewer contracts (the
 * `review/start` custom target and the background Reviewer callback), the
 * planner prompt reminder and the alignment/reconciliation prompts. */
export const AUTHORITY_HIERARCHY = `AUTHORITY HIERARCHY (in descending priority):
1. A REPRODUCIBLE critical/high correctness, security or data-corruption defect — must include CONCRETE code evidence (file:line and the exact failing scenario); generic suspicion is never evidence.
2. The user's ORIGINAL TASK and its explicit constraints (file scope, exact test counts, dependency limits, acceptance method, manual verification steps).
3. The APPROVED PLAN.
4. The previously APPLIED review findings and this round's DSH fix summary.
5. Generic quality suggestions.
Ordinary scope, test-count, dependency and verification-method conflicts resolve in favor of the ORIGINAL TASK / APPROVED PLAN: an explicit verification method named there (automated tests, static checks, or REAL COMMAND verification) is formal evidence for that requirement. Never demand automated tests for behavior the task/plan verifies by real command runs or static checks, and never demand changes that exceed the task/plan's explicit file count, test count, scope or dependency limits. A level-1 exception may override ordinary scope/test-count limits ONLY with concrete reproducible evidence.`;

/** One review entry (finding or test gap) judged to conflict with the review
 * authority hierarchy. */
export interface ReviewConflictEntry {
  /** Kind of the conflicting entry inside the normalized ReviewResult. */
  kind: "finding" | "testGap";
  /** 0-based index of the entry inside the normalized ReviewResult. */
  index: number;
  reason: string;
  /** The original-task constraint or approved-plan entry the entry violates
   * ("generic quality suggestion" when none applies). */
  violated: string;
  /** True when the entry is excused by a REPRODUCIBLE critical/high
   * correctness, security or data-corruption defect (level-1 evidence). */
  highSeverityException: boolean;
}

/** Durable audit of the most recent authority-alignment conflict. */
export interface ReviewConflictInfo {
  conflicts: ReviewConflictEntry[];
  /** True when ONE visible reconciliation turn ran on the same Codex task. */
  reconciled: boolean;
  /** True when the reconciliation re-alignment ended aligned (the corrected
   * verdict was applied). An unresolved conflict never touches `latestReview`. */
  resolved: boolean;
  at: string;
}

/** Internal result of the alignment fork. */
export interface AlignmentOutcome {
  aligned: boolean;
  conflicts: ReviewConflictEntry[];
}

/** Internal JSON schema enforced on the alignment fork (never the public
 * ReviewResult, never a tool parameter, never part of the bridge protocol). */
export const ALIGN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    aligned: { type: "boolean" },
    conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["finding", "testGap"] },
          index: { type: "integer" },
          reason: { type: "string" },
          violated: { type: "string" },
          highSeverityException: { type: "boolean" },
        },
        required: ["kind", "index", "reason", "violated", "highSeverityException"],
      },
    },
  },
  required: ["aligned", "conflicts"],
} as const;

/** Parse the alignment fork's single JSON output. Invalid entries are
 * dropped; a structurally unusable output throws so the caller treats the
 * round as retryable infrastructure failure (no cycle, no latestReview). */
export function parseAlignment(text: string): AlignmentOutcome {
  const value = parseJsonObject(text);
  if (typeof value.aligned !== "boolean") {
    throw new Error("invalid authority alignment result: missing aligned");
  }
  const conflicts: ReviewConflictEntry[] = [];
  if (Array.isArray(value.conflicts)) {
    for (const entry of value.conflicts) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const kind = item.kind;
      if (kind !== "finding" && kind !== "testGap") continue;
      if (typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0) continue;
      if (typeof item.reason !== "string" || typeof item.violated !== "string") continue;
      conflicts.push({
        kind,
        index: item.index,
        reason: item.reason,
        violated: item.violated,
        highSeverityException: item.highSeverityException === true,
      });
    }
  }
  return { aligned: value.aligned, conflicts };
}

interface AuthorityContext {
  workflowId: string;
  task: string;
  planMarkdown?: string;
  /** The workflow's PREVIOUSLY APPLIED review (level 4 of the hierarchy):
   * carried-forward findings DSH was asked to fix. When present the prompt
   * quotes it so the alignment can never mistake a legitimately carried
   * finding for a generic suggestion. */
  previousReview?: ReviewResult;
  /** THIS round's DSH fix summary (the submitted implementation summary).
   * The alignment prompt quotes it as the level-4 "current fix summary". */
  fixSummary?: string;
}

/** Prompt for the INVISIBLE alignment fork: checks every finding/test gap of
 * the normalized review against the authority hierarchy, quotes the original
 * task, the approved plan, the PREVIOUSLY APPLIED review and this round's fix
 * summary (levels 2-4 of the hierarchy — so a carried-forward finding is
 * never misjudged as a generic conflict), and emits ONLY the internal
 * alignment JSON. */
export function reviewAlignPrompt(result: ReviewResult, ctx: AuthorityContext): string {
  return `You are the REVIEW AUTHORITY checker in a DSH-controlled coding workflow. Work SILENTLY and read-only; output ONLY the JSON object matching the enforced output schema, nothing else.

${AUTHORITY_HIERARCHY}

Check EVERY finding and EVERY test gap of the structured review below against the AUTHORITY HIERARCHY above, one entry at a time. An entry CONFLICTS when it has no basis in levels 1-4 or when it CONTRADICTS an explicit ORIGINAL TASK / APPROVED PLAN constraint (file scope, exact test count, dependency limits, or the verification method the plan named — automated tests, static checks, or real command verification). Generic quality suggestions, and demands for automated tests of behavior the task/plan verifies by real command runs or static checks, are conflicts. An entry backed by an explicit task/plan requirement, by a REPRODUCIBLE critical/high defect with concrete code evidence, or by a PREVIOUSLY APPLIED review finding that DSH was asked to fix (level 4 — quoted below, unless a HIGHER level now contradicts it), is aligned.

WORKFLOW: ${ctx.workflowId}
ORIGINAL TASK:
${ctx.task || "(no explicit task)"}

${ctx.planMarkdown ? `APPROVED PLAN:\n${ctx.planMarkdown}\n\n` : ""}${ctx.previousReview ? `PREVIOUSLY APPLIED REVIEW (level 4 — findings DSH was asked to fix; they stay aligned unless a HIGHER level contradicts them):
${JSON.stringify(ctx.previousReview, null, 2)}

` : ""}${ctx.fixSummary ? `THIS ROUND'S DSH FIX SUMMARY (implementation summary — what changed since the previous review):
${ctx.fixSummary}

` : ""}REVIEW UNDER CHECK (structured):
${JSON.stringify(result, null, 2)}

Emit the JSON result:
- "aligned": true ONLY when every entry is aligned.
- "conflicts": one entry per conflicting finding/test gap — kind ("finding" | "testGap"), the entry's 0-based index, reason, "violated" (the original-task constraint or plan entry it violates, or "generic suggestion without level-1 evidence"), and highSeverityException (whether the entry still stands because of a REPRODUCIBLE critical/high correctness, security or data-corruption defect with concrete code evidence).`;
}

/** Prompt for the ONE visible reconciliation turn on the SAME durable Codex
 * task when the alignment found conflicts: the Reviewer rewrites the COMPLETE
 * verdict per the authority hierarchy — dropping every conflicting entry
 * (unless a high-severity exception was satisfied), keeping every
 * non-conflicting entry exactly as before — as exactly one final readable
 * message in the original task's language with the four fixed section lines.
 * It must NOT re-review the code and must NOT add, remove or alter any other
 * entry. */
export function reviewReconcilePrompt(
  result: ReviewResult,
  conflicts: ReviewConflictEntry[],
  ctx: AuthorityContext,
): string {
  const conflictLines = conflicts.map((conflict, index) => {
    const exception = conflict.highSeverityException
      ? " (high-severity exception satisfied — may remain)"
      : "";
    return `${index + 1}. [${conflict.kind} #${conflict.index}] ${conflict.reason} (violates: ${conflict.violated})${exception}`;
  });
  return `Your previous review conflicts with the authority hierarchy below.

${AUTHORITY_HIERARCHY}

CONFLICTING ENTRIES (drop each one from the rewritten review unless its high-severity exception is satisfied):
${conflictLines.join("\n") || "(none listed)"}

Rewrite the COMPLETE review as EXACTLY ONE final readable message, in the SAME language as the original task, with these four section lines, each on its own line (the Chinese equivalents 结论/问题/测试缺口/总结 followed by a colon are also accepted):
VERDICT: pass | changes_requested
FINDINGS: one entry per finding with severity, blocking (yes/no), title, body and the concrete file:line reference when available; write "none" when empty
TEST GAPS: one per line, or "none"
SUMMARY: a short readable summary

Do NOT re-review the code. Keep every non-conflicting finding and test gap EXACTLY as before (severity, blocking flag, file:line). Output exactly ONE final message: the rewritten review. Nothing else.

ORIGINAL TASK:
${ctx.task || "(no explicit task)"}

${ctx.planMarkdown ? `APPROVED PLAN:\n${ctx.planMarkdown}\n\n` : ""}PREVIOUS REVIEW (structured):
${JSON.stringify(result, null, 2)}`;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(trimmed) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex returned non-object JSON");
  return value as Record<string, unknown>;
}