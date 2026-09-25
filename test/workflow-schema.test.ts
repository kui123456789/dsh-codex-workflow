import test from "node:test";
import assert from "node:assert/strict";
import { deserializeWorkflowRecord, migrateWorkflowRecord, serializeWorkflowRecord } from "../src/state/workflow-schema.js";
import type { WorkflowRecord } from "../src/types.js";

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    schemaVersion: 1,
    id: "wf-schema",
    dshSessionId: "session-schema",
    cwd: "C:\\workspace",
    task: "migrate records",
    mode: "planned",
    phase: "executing",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:01.000Z",
    assumptions: ["keep data"],
    questions: [],
    reviewCycles: 1,
    plannerThreadId: "planner",
    latestReview: { verdict: "pass", findings: [], testGaps: [], summary: "ok" },
    ...overrides,
  };
}

test("workflow schema v1 -> v2 migration preserves grouped state and is idempotent", () => {
  const original = record({ origin: "codex_bridge", submissionId: "sub-1", submissionState: "queued" });
  const v2 = migrateWorkflowRecord(original);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.identity.id, original.id);
  assert.equal(v2.planning.plannerThreadId, original.plannerThreadId);
  assert.deepEqual(v2.review.latestReview, original.latestReview);
  assert.equal(v2.submission.submissionId, original.submissionId);
  assert.equal(v2.identity.origin, original.origin);
  assert.deepEqual(migrateWorkflowRecord(v2), v2);
});

test("workflow schema serializer round-trips v1 and accepts legacy flat JSON", () => {
  const original = record({ desktopOpenState: "disabled", error: "retryable" });
  const encoded = serializeWorkflowRecord(original);
  const parsed = JSON.parse(encoded) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 2);
  assert.equal((parsed.desktop as Record<string, unknown>).desktopOpenState, "disabled");
  assert.deepEqual(deserializeWorkflowRecord(parsed), original);
  assert.deepEqual(deserializeWorkflowRecord(original), original);
});

test("workflow schema rejects unknown versions", () => {
  assert.throws(() => deserializeWorkflowRecord({ schemaVersion: 99 }), /unsupported workflow schemaVersion 99/);
});
