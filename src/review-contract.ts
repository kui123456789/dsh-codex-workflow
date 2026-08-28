/**
 * Review-time contract shared by the App Server client and the reviewer
 * prompts.
 *
 * Since 1.0.7 the PERSISTED Reviewer task only ever produces a human-readable
 * review (Markdown, in the same language as the original task) — Codex Desktop
 * never sees raw JSON in the durable task history. The structured verdict is
 * produced by a SEPARATE ephemeral fork of the Reviewer thread whose
 * single-JSON output is enforced with `outputSchema` and the
 * {@link CONVERSION_DEVELOPER_INSTRUCTIONS} protocol-level instructions.
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
  "Reply in the same language as the original task.",
  "When your review is complete, emit exactly one final message: your complete readable review. Nothing else.",
].join(" ");

/**
 * Protocol-level instructions for the EPHEMERAL fork conversion turns. These
 * turns carry the enforced output schema and must emit exactly one final JSON
 * object; they run on a throwaway fork, so their output never lands in the
 * persisted task history of Codex Desktop.
 */
export const CONVERSION_DEVELOPER_INSTRUCTIONS = [
  "You are the structured-output converter in a DSH-controlled coding workflow.",
  "Work SILENTLY: emit NO commentary, NO progress messages, and NO intermediate text.",
  "Do NOT use collaboration, sub-agent, delegation, or task-creation capabilities of any kind.",
  "Do NOT create, fork, resume, or delegate to any other task or thread.",
  "Run only the read-only inspection commands that are necessary.",
  "When your conversion is complete, emit exactly one final message: the JSON object conforming to the enforced output schema. Nothing else.",
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
  + "Output exactly ONE final message: your complete readable review.";

/** Deterministic CJK probe: a Chinese original task/plan requires the final
 * authoritative visible review text to contain Chinese characters. */
export function isChineseText(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

/** The language/context the visible review must match (original task +
 * approved plan). */
export interface ReviewDisplayContext {
  task: string;
  planMarkdown?: string;
}

/** Section ANCHORS accepted for each of the four required readable sections:
 * the English labels the contract asks for verbatim, or their common Chinese
 * equivalents. Each required section must appear on a SECTION LINE — a
 * standalone (optionally markdown-decorated) line whose label STARTS the
 * trimmed line and is followed by a separator (`:`, `：`, `、`, whitespace, an
 * inline bold close) or ends the line. A prose paragraph that merely CONTAINS
 * the keywords ("结论是通过，没有问题，测试已经完成，总结如下……") is NOT a
 * section and must NOT satisfy the contract: only the fixed readable audit
 * format (VERDICT / FINDINGS / TEST GAPS / SUMMARY, or their Chinese heads) is
 * accepted without a rewrite turn. */
const VERDICT_ANCHOR = /VERDICT|结论|判定|审查结果|评审结果/i;
const FINDINGS_ANCHOR = /FINDINGS?|发现|问题|审查意见|整改项|修改建议/i;
const TEST_GAPS_ANCHOR = /TEST\s*GAPS?|测试缺口|测试差距|测试不足|测试/i;
const SUMMARY_ANCHOR = /SUMMARY|总结|摘要|概述/i;

/** True when `text` carries `anchor` as a section line: a trimmed line whose
 * label starts the line after optional markdown decoration (headings, bullets,
 * numbering, bold) and is followed by a separator or the end of the line. */
function hasSectionLine(text: string, anchor: RegExp): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // Strip markdown decoration prefixes (headings, bullets, numbering, bold)
    // until no decoration remains — handling "**" as a unit so a bullet never
    // eats half of a bold opener.
    let stripped = trimmed;
    for (let i = 0; i < 4; i += 1) {
      const next = stripped
        .replace(/^(#{1,6}\s*|\*\*\s*|[-*+]\s*|\d{1,2}[.、)]\s*)/, "")
        .trimStart();
      if (next === stripped) break;
      stripped = next;
    }
    const match = stripped.match(anchor);
    if (!match || match.index !== 0) return false;
    const rest = stripped.slice(match[0].length);
    // A label glued into prose ("结论是通过") or mid-sentence is NOT a section.
    return rest === "" || /^[\s:：、\-*]/.test(rest);
  });
}

/** True when the text IS the raw structured review JSON envelope that must
 * never appear in a visible reply (a JSON object carrying `verdict`). Readable
 * Markdown, JSON error payloads and plain JSON noise are not. */
export function isReviewJsonEnvelope(text: string): boolean {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed.startsWith("{")) return false;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return Boolean(
      value && typeof value === "object" && !Array.isArray(value)
      && "verdict" in (value as Record<string, unknown>),
    );
  } catch {
    // not JSON — readable text
  }
  return false;
}

/** Returns a violation description when the visible review does not satisfy
 * the display contract — non-empty, readable Markdown (never a structured
 * JSON envelope), all four required sections present AS SECTION LINES
 * (verdict/conclusion, findings, test gaps, summary; each may say "none"),
 * and for Chinese original tasks the authoritative text must contain Chinese.
 * A single paragraph merely containing the section keywords is NOT compliant.
 * Returns `undefined` when the review conforms. */
export function reviewDisplayError(text: string, ctx: ReviewDisplayContext): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "review is empty";
  if (isReviewJsonEnvelope(trimmed)) return "review is a structured JSON envelope";
  const missing: string[] = [];
  if (!hasSectionLine(trimmed, VERDICT_ANCHOR)) missing.push("verdict/conclusion");
  if (!hasSectionLine(trimmed, FINDINGS_ANCHOR)) missing.push("findings");
  if (!hasSectionLine(trimmed, TEST_GAPS_ANCHOR)) missing.push("test gaps");
  if (!hasSectionLine(trimmed, SUMMARY_ANCHOR)) missing.push("summary");
  if (missing.length > 0) return `review is missing the ${missing.join(", ")} section(s)`;
  if (isChineseText(`${ctx.task}\n${ctx.planMarkdown ?? ""}`) && !isChineseText(trimmed)) {
    return "review is not in the original task's language (a Chinese task requires Chinese text)";
  }
  return undefined;
}

/** Prompt for the ONE controlled visible rewrite turn on the SAME durable
 * Reviewer task when the native review violated the display contract. The
 * rewrite must NOT re-review the code and must NOT add, remove, merge or
 * split any finding, test gap or verdict value — it only re-presents the
 * SAME verdict/findings/test-gaps in the original task's language with the
 * four fixed readable sections, as exactly one final message. */
export function reviewRewritePrompt(rawReview: string, ctx: ReviewDisplayContext): string {
  return `The reviewer's visible reply below violates the visible-review display contract: it must be readable Markdown in the SAME language as the original task with these four EXACT section lines, each on its OWN line (the English labels are accepted verbatim for any language; the Chinese equivalents 结论/问题/测试缺口/总结 followed by a colon are also accepted):
VERDICT: pass | changes_requested
FINDINGS: one entry per finding with severity, blocking (yes/no), title, body and the concrete file:line reference when available; write "none" when empty
TEST GAPS: one per line, or "none"
SUMMARY: a short readable summary

Do NOT re-review the code and do NOT add, remove, merge or split any finding, test gap or verdict value — keep the verdict, every finding (severity, blocking flag, file:line) and every test gap exactly as given. Rewrite ONLY the presentation: produce the complete review in the original task's language as readable Markdown with the four section lines above, EXACTLY as section lines and nothing else extra.
Output exactly ONE final message: the rewritten review. Nothing else.

Original task: ${ctx.task || "(none)"}
${ctx.planMarkdown ? `Approved plan (language guide):\n${ctx.planMarkdown}\n` : ""}
Raw review that violates the contract:
${rawReview}`;
}