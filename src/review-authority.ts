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

/** Parse and validate the alignment fork's single JSON output against the
 * ReviewResult it was asked to check. Any contradiction, malformed conflict,
 * or out-of-range index throws so the caller treats the round as retryable
 * infrastructure failure (no cycle, no latestReview). */
export function parseAlignment(text: string, result: ReviewResult): AlignmentOutcome {
  const value = parseJsonObject(text);
  if (typeof value.aligned !== "boolean") {
    throw new Error("invalid authority alignment result: missing aligned");
  }
  if (!Array.isArray(value.conflicts)) {
    throw new Error("invalid authority alignment result: conflicts must be an array");
  }
  const conflicts: ReviewConflictEntry[] = [];
  for (const entry of value.conflicts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("invalid authority alignment result: invalid conflict entry");
    }
    const item = entry as Record<string, unknown>;
    const kind = item.kind;
    if (kind !== "finding" && kind !== "testGap") {
      throw new Error("invalid authority alignment result: invalid conflict kind");
    }
    if (typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0) {
      throw new Error("invalid authority alignment result: invalid conflict index");
    }
    if (typeof item.reason !== "string" || typeof item.violated !== "string") {
      throw new Error("invalid authority alignment result: invalid conflict details");
    }
    const upperBound = kind === "finding" ? result.findings.length : result.testGaps.length;
    if (item.index >= upperBound) {
      throw new Error(`invalid authority alignment result: ${kind} index out of range`);
    }
    if (item.highSeverityException !== undefined && typeof item.highSeverityException !== "boolean") {
      throw new Error("invalid authority alignment result: invalid highSeverityException");
    }
    conflicts.push({
      kind,
      index: item.index,
      reason: item.reason,
      violated: item.violated,
      highSeverityException: item.highSeverityException === true,
    });
  }
  if (value.aligned && conflicts.length > 0) {
    throw new Error("invalid authority alignment result: aligned=true cannot include conflicts");
  }
  if (!value.aligned && conflicts.length === 0) {
    throw new Error("invalid authority alignment result: aligned=false requires at least one conflict");
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
  const conflictedFindings = new Set(conflicts.filter((entry) => entry.kind === "finding").map((entry) => entry.index));
  const conflictedGaps = new Set(conflicts.filter((entry) => entry.kind === "testGap").map((entry) => entry.index));
  const conflictLines = conflicts.map((conflict, index) => {
    const exception = conflict.highSeverityException
      ? " (high-severity exception satisfied — may remain)"
      : "";
    return `${index + 1}. [${conflict.kind} #${conflict.index}] ${conflict.reason} (violates: ${conflict.violated})${exception}`;
  });
  const preservedFindings = result.findings.flatMap((finding, index) => conflictedFindings.has(index)
    ? []
    : [`- finding #${index}: ${JSON.stringify(finding)}`]);
  const preservedGaps = result.testGaps.flatMap((gap, index) => conflictedGaps.has(index)
    ? []
    : [`- testGap #${index}: ${JSON.stringify(gap)}`]);
  const conflictingManifest = conflicts.map((conflict) => {
    const value = conflict.kind === "finding"
      ? result.findings[conflict.index]
      : result.testGaps[conflict.index];
    return `- ${conflict.kind} #${conflict.index}: ${JSON.stringify(value)}`;
  });
  return `Your previous review conflicts with the authority hierarchy below.

${AUTHORITY_HIERARCHY}

CONFLICTING ENTRIES (drop each one from the rewritten review unless its high-severity exception is satisfied):
${conflictLines.join("\n") || "(none listed)"}

PRESERVATION MANIFEST — NON-CONFLICTING FINDINGS (copy every field and every duplicate EXACTLY):
${preservedFindings.join("\n") || "(none)"}

PRESERVATION MANIFEST — NON-CONFLICTING TEST GAPS (copy the complete text and every duplicate EXACTLY):
${preservedGaps.join("\n") || "(none)"}

AUTHORITY-CONFLICTING SOURCE ENTRIES (only these entries may be removed or corrected as the authority decision permits):
${conflictingManifest.join("\n") || "(none)"}

The preservation manifest is binding. Copy every non-conflicting entry verbatim: do not summarize, rewrite, merge, split, omit, reorder fields, or change duplicate counts. Do not add any finding or test gap that did not exist in the previous review. A corrected conflicting finding must remain traceable to its source entry; unrelated new findings/test gaps are forbidden. The final response must be the COMPLETE four-section review, not only the corrected fragment.

Rewrite the COMPLETE review as EXACTLY ONE final readable message, in the SAME language as the original task, with these four section lines, each on its own line (the Chinese equivalents 结论/问题/测试缺口/总结 followed by a colon are also accepted):
VERDICT: pass | changes_requested
FINDINGS: one entry per finding with severity, blocking (yes/no), title, body and the concrete file:line reference when available; write "none" when empty
TEST GAPS: one per line, or "none"
SUMMARY: a short readable summary

Do NOT re-review the code. Keep every non-conflicting finding and test gap EXACTLY as before, including severity, blocking, title, body, file, line, full gap text, and duplicate count. Output exactly ONE final message: the rewritten review. Nothing else.

ORIGINAL TASK:
${ctx.task || "(no explicit task)"}

${ctx.planMarkdown ? `APPROVED PLAN:\n${ctx.planMarkdown}\n\n` : ""}PREVIOUS REVIEW (structured):
${JSON.stringify(result, null, 2)}`;
}

/** Deterministic preservation check of a reconciliation rewrite: EVERY
 * NON-conflicting finding and test gap of the original review must survive
 * the rewrite EXACTLY — findings by severity/blocking/title/body/file/line,
 * test gaps by their full text. A rewrite may only drop (or downgrade) the
 * entries the authority alignment listed as conflicts; silently losing a
 * real, aligned review entry would ship a wrong verdict. Returns a
 * human-readable violation description, or `undefined` when the corrected
 * review preserves every non-conflicting entry. */
export function reconciliationPreservationViolation(
  original: ReviewResult,
  conflicts: ReviewConflictEntry[],
  corrected: ReviewResult,
): string | undefined {
  const conflictedFinding = new Set(conflicts.filter((c) => c.kind === "finding").map((c) => c.index));
  const conflictedGap = new Set(conflicts.filter((c) => c.kind === "testGap").map((c) => c.index));
  const findingMatches = (left: ReviewResult["findings"][number], right: ReviewResult["findings"][number]): boolean =>
    left.severity === right.severity
    && left.blocking === right.blocking
    && left.title === right.title
    && left.body === right.body
    && (left.file ?? undefined) === (right.file ?? undefined)
    && (left.line ?? undefined) === (right.line ?? undefined);
  const findingKey = (finding: ReviewResult["findings"][number]): string => JSON.stringify([
    finding.severity,
    finding.blocking,
    finding.title,
    finding.body,
    finding.file ?? null,
    finding.line ?? null,
  ]);
  const count = <T>(values: T[], key: (value: T) => string): Map<string, number> => {
    const result = new Map<string, number>();
    for (const value of values) {
      const identity = key(value);
      result.set(identity, (result.get(identity) ?? 0) + 1);
    }
    return result;
  };
  const requiredFindings = original.findings.filter((_, index) => !conflictedFinding.has(index));
  const requiredGaps = original.testGaps.filter((_, index) => !conflictedGap.has(index));
  const correctedFindingCounts = count(corrected.findings, findingKey);
  const correctedGapCounts = count(corrected.testGaps, (gap) => gap);
  for (const finding of requiredFindings) {
    const identity = findingKey(finding);
    const remaining = correctedFindingCounts.get(identity) ?? 0;
    if (remaining === 0) {
      return `reconciliation dropped a non-conflicting finding "${finding.title}" (severity ${finding.severity}, blocking ${finding.blocking}${finding.file ? `, ${finding.file}${finding.line ? `:${finding.line}` : ""}` : ""})`;
    }
    correctedFindingCounts.set(identity, remaining - 1);
  }
  for (const gap of requiredGaps) {
    const remaining = correctedGapCounts.get(gap) ?? 0;
    if (remaining === 0) return `reconciliation dropped a non-conflicting test gap "${gap}"`;
    correctedGapCounts.set(gap, remaining - 1);
  }

  const extraFindings = corrected.findings.filter((finding) => {
    const identity = findingKey(finding);
    const remaining = correctedFindingCounts.get(identity) ?? 0;
    if (remaining === 0) return false;
    correctedFindingCounts.set(identity, remaining - 1);
    return true;
  });
  const extraGaps = corrected.testGaps.filter((gap) => {
    const remaining = correctedGapCounts.get(gap) ?? 0;
    if (remaining === 0) return false;
    correctedGapCounts.set(gap, remaining - 1);
    return true;
  });
  const sourceFindings = original.findings.filter((_, index) => conflictedFinding.has(index));
  const sourceGaps = original.testGaps.filter((_, index) => conflictedGap.has(index));
  if (extraFindings.length > sourceFindings.length) {
    return `reconciliation added ${extraFindings.length - sourceFindings.length} unauthorized finding(s)`;
  }
  if (extraGaps.length > sourceGaps.length) {
    return `reconciliation added ${extraGaps.length - sourceGaps.length} unauthorized test gap(s)`;
  }
  const unusedSourceFindings = [...sourceFindings];
  for (const finding of extraFindings) {
    const exact = unusedSourceFindings.findIndex((source) => findingMatches(source, finding));
    const traceable = exact >= 0 ? exact : unusedSourceFindings.findIndex((source) =>
      source.title === finding.title
      && (source.file ?? undefined) === (finding.file ?? undefined)
      && (source.line ?? undefined) === (finding.line ?? undefined));
    if (traceable < 0) return `reconciliation added an unauthorized finding "${finding.title}"`;
    unusedSourceFindings.splice(traceable, 1);
  }
  const unusedSourceGaps = [...sourceGaps];
  for (const gap of extraGaps) {
    const sourceIndex = unusedSourceGaps.indexOf(gap);
    if (sourceIndex < 0) return `reconciliation added an unauthorized test gap "${gap}"`;
    unusedSourceGaps.splice(sourceIndex, 1);
  }
  return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(trimmed) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex returned non-object JSON");
  return value as Record<string, unknown>;
}
