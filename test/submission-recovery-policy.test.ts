import assert from "node:assert/strict";
import test from "node:test";
import { assertSubmissionReviewRound, bridgeReviewUnavailableReason,
  ORIGINAL_REVIEWER_UNAVAILABLE, ORIGINAL_REVIEW_RESULT_UNAVAILABLE } from "../src/application/submission-recovery-policy.js";
import { deserializeWorkflowRecord, serializeWorkflowRecord } from "../src/state/workflow-schema.js";
import type { ReviewEvidence, WorkflowRecord } from "../src/types.js";

const evidence: ReviewEvidence = { kind: "files", changedFiles: ["changed.txt"], status: "verified", diff: "v1",
  diffTruncated: false, diffBytes: 2, fingerprint: "original-verified-material", fileHashes: [],
  missingFiles: [], rejectedPaths: [], insufficient: false };
const record = (): WorkflowRecord => ({ schemaVersion: 1, id: "policy-workflow", dshSessionId: "policy-parent",
  cwd: "C:/isolated-policy-workspace", task: "Inspect the approved diagnostic", phase: "executing",
  createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z",
  assumptions: [], questions: [], reviewCycles: 0, origin: "codex_bridge", submissionId: "original-submission",
  submissionState: "failed", processState: "failed", submissionAttempts: 1,
  reviewerThreadOrigin: "app-server-ephemeral", latestReviewEvidence: structuredClone(evidence) });

test("machine causes distinguish missing thread and completed result through stored schema round trips", () => {
  for (const [cause, expected] of [[ORIGINAL_REVIEWER_UNAVAILABLE, "thread_unavailable"],
    [ORIGINAL_REVIEW_RESULT_UNAVAILABLE, "handle_unavailable"]] as const) {
    const original = { ...record(), submissionCallbackReason: cause, submissionError: "The primary failure detail is preserved" };
    const stored = deserializeWorkflowRecord(JSON.parse(serializeWorkflowRecord(original))) as unknown as WorkflowRecord;
    assert.equal(stored.submissionCallbackReason, cause);
    assert.equal(stored.submissionError, original.submissionError);
    assert.equal(bridgeReviewUnavailableReason(stored), expected);
    assert.equal(bridgeReviewUnavailableReason({ ...stored, origin: "dsh" }), undefined);
    assert.equal(bridgeReviewUnavailableReason({ ...stored, submissionState: "received" }), undefined);
  }
});

test("known historic diagnostics are interpreted read-only and unknown legacy text is not classified", () => {
  const historic = { ...record(), submissionError:
    "reviewer failed: original ephemeral Reviewer operation is unavailable in this process; no replacement will be created" };
  const before = structuredClone(historic);
  assert.equal(bridgeReviewUnavailableReason(historic), "thread_unavailable");
  assert.deepEqual(historic, before, "No migration or machine reason is fabricated by a historical probe");
  assert.equal(historic.submissionCallbackReason, undefined);
  assert.equal(bridgeReviewUnavailableReason({ ...historic, reviewerThreadOrigin: "cli" }), undefined);
  assert.equal(bridgeReviewUnavailableReason({ ...historic, submissionAttempts: 0 }), undefined);
  const unknown = { ...record(), submissionError: "A provider says some original resource might be unavailable; try again" };
  assert.equal(bridgeReviewUnavailableReason(unknown), undefined);
  assert.doesNotThrow(() => assertSubmissionReviewRound(unknown, evidence, false), "Unknown legacy behavior is not reclassified from keywords");
});

test("a new round requires verifiable changed evidence or explicit intent, never a fabricated missing baseline", () => {
  for (const cause of [ORIGINAL_REVIEWER_UNAVAILABLE, ORIGINAL_REVIEW_RESULT_UNAVAILABLE]) {
    const failed = { ...record(), submissionCallbackReason: cause };
    assert.throws(() => assertSubmissionReviewRound(failed, evidence, false), /unchanged review material/);
    assert.doesNotThrow(() => assertSubmissionReviewRound(failed, { ...evidence, fingerprint: "new-verified-material" }, false));
    assert.doesNotThrow(() => assertSubmissionReviewRound(failed, evidence, true));
    assert.throws(() => assertSubmissionReviewRound({ ...failed, latestReviewEvidence: undefined },
      { ...evidence, fingerprint: "candidate-with-no-original-baseline" }, false), /unchanged review material/);
    assert.throws(() => assertSubmissionReviewRound(failed, { ...evidence, insufficient: true, fingerprint: "" }, false),
      /unchanged review material/);
  }
});
