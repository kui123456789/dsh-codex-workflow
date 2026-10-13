import type { ReviewEvidence, WorkflowRecord } from "../types.js";

export const ORIGINAL_REVIEWER_UNAVAILABLE = "original_reviewer_unavailable";
export const ORIGINAL_REVIEW_RESULT_UNAVAILABLE = "original_review_result_unavailable";

// Older plugin versions persisted these exact project-owned errors without a
// machine reason. Interpret only proven ephemeral failures, without rewriting
// history or treating arbitrary legacy provider messages as recovery authority.
const historicalUnavailableMessages = new Set([
  "original ephemeral Reviewer consumer is retired or unavailable in this process; refusing to create a replacement",
  "original ephemeral Reviewer consumer was retired; no replacement will be created",
  "original ephemeral Reviewer consumer was retired and is unavailable; no replacement will be created",
  "original ephemeral Reviewer operation is unavailable in this process; no replacement will be created",
  "the original ephemeral Reviewer process was lost; submit a new review round",
  "the retained ephemeral Reviewer process was lost; its original thread cannot be resumed",
]);
const historicalResultUnavailableMessages = new Set([
  "completed Reviewer result is unavailable in this process; refusing to repeat the original review",
]);

export function bridgeReviewUnavailableReason(record: WorkflowRecord): "thread_unavailable" | "handle_unavailable" | undefined {
  if (record.origin !== "codex_bridge" || record.submissionState !== "failed" || !record.submissionId) return;
  if (record.submissionCallbackReason === ORIGINAL_REVIEWER_UNAVAILABLE) return "thread_unavailable";
  if (record.submissionCallbackReason === ORIGINAL_REVIEW_RESULT_UNAVAILABLE) return "handle_unavailable";
  if (record.reviewerThreadOrigin !== "app-server-ephemeral" || (record.submissionAttempts ?? 0) <= 0) return;
  const message = record.submissionError?.trim() ?? "";
  const messages = [message, ...["reviewer failed: ", "Codex Reviewer 后台审查失败："]
    .filter((prefix) => message.startsWith(prefix)).map((prefix) => message.slice(prefix.length).trim())];
  if (messages.some((value) => historicalUnavailableMessages.has(value))) return "thread_unavailable";
  if (messages.some((value) => historicalResultUnavailableMessages.has(value))) return "handle_unavailable";
}

export function originalBridgeResourceUnavailable(record: WorkflowRecord): boolean {
  return bridgeReviewUnavailableReason(record) !== undefined;
}

/** Recovery cannot become another review of unchanged material. A verified
 * evidence change or explicit new-round intent starts a separate business round. */
export function assertSubmissionReviewRound(record: WorkflowRecord, evidence: ReviewEvidence, newReviewRound: boolean): void {
  const reason = bridgeReviewUnavailableReason(record);
  if (!reason || newReviewRound) return;
  const previous = record.latestReviewEvidence;
  const changed = previous && !previous.insufficient && Boolean(previous.fingerprint)
    && !evidence.insufficient && Boolean(evidence.fingerprint)
    && previous.kind === evidence.kind && previous.fingerprint !== evidence.fingerprint;
  if (changed) return;
  const unavailable = reason === "handle_unavailable" ? "original completed review result is unavailable" : "original Reviewer is unavailable";
  throw new Error(`${unavailable}; unchanged review material cannot recover the original review. Report the unavailable state without a parent-authored substitute or automatic resubmission. An explicit newReviewRound is a separate review, never continuation.`);
}

export function unavailableReviewerInstruction(workflowId: string, reason: "thread_unavailable" | "handle_unavailable" = "thread_unavailable"): string {
  const detail = reason === "handle_unavailable"
    ? "the original completed review result is unavailable. 原审查此前已生成可读结果，但用于继续校验的原结果已丢失，无法继续该轮审查。"
    : "the original Reviewer is unavailable and cannot be resumed. 原 Reviewer 线程或会话资源已不可恢复。";
  return `Workflow ${workflowId}: ${detail}请检查 codex_workflow_status 并向用户报告原资源不可用；不要在父会话代写审查或计划，不要自动重新提交相同内容或创建替代 Reviewer。只有可验证的工作区证据已变化，或用户明确要求一轮新的独立审查，才开始新的审查轮次；newReviewRound 不能用于故障恢复。`;
}
