import type { WorkflowRecord } from "../types.js";

/** Identity of the original waiting review, captured rather than reconstructed. */
export type ReviewerRunIdentity = Readonly<Pick<WorkflowRecord,
  "id" | "dshSessionId" | "cwd" | "task" | "createdAt" | "mode" | "phase"
  | "reviewerModel" | "reviewerEffort" | "reviewAttempt">>;

export function reviewerRunIdentity(record: ReviewerRunIdentity): ReviewerRunIdentity {
  const { id, dshSessionId, cwd, task, createdAt, mode, phase, reviewerModel, reviewerEffort, reviewAttempt } = record;
  return Object.freeze({ id, dshSessionId, cwd, task, createdAt, mode, phase, reviewerModel, reviewerEffort,
    reviewAttempt: reviewAttempt ?? 0 });
}

export function assertReviewerRunIdentity(expected: ReviewerRunIdentity, current: WorkflowRecord | undefined): asserts current is WorkflowRecord {
  if (!current || current.id !== expected.id || current.dshSessionId !== expected.dshSessionId || current.cwd !== expected.cwd
    || current.task !== expected.task || current.createdAt !== expected.createdAt || current.mode !== expected.mode
    || current.reviewerModel !== expected.reviewerModel || current.reviewerEffort !== expected.reviewerEffort
    || (current.reviewAttempt ?? 0) !== (expected.reviewAttempt ?? 0)) {
    throw new Error(`workflow ${expected.id} lost its original Reviewer identity, settings or attempt`);
  }
}

export function assertReviewerRecovery(expected: ReviewerRunIdentity, current: WorkflowRecord | undefined): asserts current is WorkflowRecord {
  assertReviewerRunIdentity(expected, current);
  if (current.phase !== expected.phase || !["executing", "fixing"].includes(current.phase)
    || current.processState !== "waiting" || current.retryState?.stage !== "reviewing" || !current.retryState.awaitingContinuation) {
    throw new Error(`workflow ${expected.id} is no longer waiting for its original Reviewer`);
  }
}
