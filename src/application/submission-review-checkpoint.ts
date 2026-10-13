import { createHash } from "node:crypto";
import type { CodexChildSessionHandle } from "../codex-child-session.js";
import type { ReviewEvidence, ReviewResult, WorkflowRecord } from "../types.js";

/** Completed upstream work, retained only inside its original manager. */
export interface SubmissionReviewCheckpoint {
  submissionId: string;
  identity: string;
  verdict: ReviewResult;
  visibleText?: string;
  child?: CodexChildSessionHandle;
  cwd: string;
  changedFiles?: string[];
  fingerprint: string;
  evidenceKind: ReviewEvidence["kind"];
}

export class SubmissionReviewContextError extends Error {}
/** The readable review and conversion completed, but their process-local
 * result can no longer be used for authority validation. Never re-review it. */
export class SubmissionReviewResultUnavailableError extends Error {}

/** Progress, attempts and lease generations can change during a valid retry. */
export function submissionReviewIdentity(record: WorkflowRecord, prompt: string): string {
  return createHash("sha256").update(JSON.stringify([
    record.id, record.submissionId, record.dshSessionId, record.origin, record.codexThreadId,
    record.cwd, record.task, record.planMarkdown, record.createdAt, record.mode, record.phase,
    record.latestReview, record.pendingReviewRequest, record.reviewerModel, record.reviewerEffort,
    record.latestReviewEvidence?.kind, record.latestReviewEvidence?.fingerprint,
    record.latestReviewEvidence?.insufficient, prompt,
  ])).digest("hex");
}
