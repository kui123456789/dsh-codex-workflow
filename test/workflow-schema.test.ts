import test from "node:test";
import assert from "node:assert/strict";
import { deserializeWorkflowRecord, migrateWorkflowRecord, serializeWorkflowRecord } from "../src/state/workflow-schema.js";
import type { WorkflowRecord } from "../src/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { WorkflowStore } from "../src/store.js";
import { LifecycleExecution } from "../src/application/lifecycle-execution.js";
import { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { ReviewObservation } from "../src/application/review-observation.js";
import { TurnGateway } from "../src/application/app-server/turn-gateway.js";

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
  const original = record({ desktopOpenState: "disabled", error: "retryable", reviewPhaseTimings: {
    review_conversion: { startedAt: "2026-09-25T00:00:02.000Z", endedAt: "2026-09-25T00:00:03.000Z", elapsedMs: 1000 },
  } });
  const encoded = serializeWorkflowRecord(original);
  const parsed = JSON.parse(encoded) as Record<string, unknown>;
  assert.equal(parsed.schemaVersion, 2);
  assert.equal((parsed.desktop as Record<string, unknown>).desktopOpenState, "disabled");
  assert.deepEqual((parsed.execution as Record<string, unknown>).reviewPhaseTimings, original.reviewPhaseTimings);
  assert.deepEqual(deserializeWorkflowRecord(parsed), original);
  assert.deepEqual(deserializeWorkflowRecord(original), original);
});

test("workflow schema rejects unknown versions", () => {
  assert.throws(() => deserializeWorkflowRecord({ schemaVersion: 99 }), /unsupported workflow schemaVersion 99/);
});

test("workflow schema rejects malformed continuation checkpoints before resume admission", () => {
  const state = { stage: "planning", reason: "turn failed", attempts: 1, awaitingContinuation: true,
    plannerCheckpoint: { nextStep: "conversion" } };
  const base = { schemaVersion: 1, retryState: state };
  assert.deepEqual(deserializeWorkflowRecord(base).retryState, state);
  for (const retryState of [
    { ...state, stage: "replacement" },
    { ...state, attempts: 0 },
    { ...state, attempts: 1.5 },
    { ...state, awaitingContinuation: "yes" },
    { ...state, plannerCheckpoint: { nextStep: "unknown" } },
    { ...state, reviewCheckpoint: { nextStep: "visible" } },
    { ...state, terminalFailure: { message: "permission denied" } },
    null,
    [],
  ]) {
    assert.throws(() => deserializeWorkflowRecord({ schemaVersion: 1, retryState }), /workflow retry|Planner retry|Reviewer retry|terminal failure/i);
    assert.throws(() => serializeWorkflowRecord({ ...record(), retryState } as unknown as WorkflowRecord), /workflow retry|Planner retry|Reviewer retry|terminal failure/i);
  }
  // Pre-validation interruption-only rows remain readable for old cleanup records.
  assert.deepEqual(deserializeWorkflowRecord({ schemaVersion: 1, retryState: { interruption: { target: "planner" } } }).retryState,
    { interruption: { target: "planner" } });
});

test("workflow retry selectors reject JSON type coercion and already-versioned migration bypasses", () => {
  const state = { stage: "planning", reason: "turn failed", attempts: 1, awaitingContinuation: true };
  const retryStates = [
    { ...state, stage: ["planning"] },
    { ...state, plannerCheckpoint: { nextStep: ["conversion"] } },
    { ...state, stage: "reviewing", reviewCheckpoint: { nextStep: ["alignment"] } },
    { ...state, awaitingContinuation: "true" },
    { ...state, plannerCheckpoint: null },
  ];
  for (const retryState of retryStates) {
    const flat = { ...record(), retryState };
    assert.throws(() => serializeWorkflowRecord(flat as unknown as WorkflowRecord), /retry|checkpoint/i);
    assert.throws(() => deserializeWorkflowRecord(flat), /retry|checkpoint/i);
    const envelope = JSON.parse(serializeWorkflowRecord(record()));
    envelope.execution.retryState = retryState;
    assert.throws(() => deserializeWorkflowRecord(envelope), /retry|checkpoint/i);
    assert.throws(() => migrateWorkflowRecord(envelope), /retry|checkpoint/i,
      "Being version 2 does not establish that a checkpoint is valid");
  }
  const valid = JSON.parse(serializeWorkflowRecord({ ...record(), retryState: state as WorkflowRecord["retryState"] }));
  assert.equal(migrateWorkflowRecord(valid), valid, "Valid migration remains idempotent and preserves its envelope");
});

test("invalid retry checkpoints cannot change SQLite revisions or advertise a live continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-retry-checkpoint-schema-"));
  const store = new WorkflowStore(directory);
  const runtime = new WorkflowRuntimeState();
  const state = { stage: "planning" as const, reason: "turn failed", attempts: 1, awaitingContinuation: true };
  const original = record({ cwd: directory, phase: "planning", processState: "waiting", retryState: state });
  let modelCalls = 0;
  let availabilityChecks = 0;
  const unexpected = async (): Promise<never> => { modelCalls += 1; throw new Error("Schema rejection cannot request a model"); };
  const lifecycle = new LifecycleExecution({ store, runtime,
    turnGateway: new TurnGateway({ startTurn: unexpected, startReview: unexpected, continueTurn: unexpected,
      normalizeInFork: unexpected, interrupt: unexpected,
      isThreadAvailable: () => { availabilityChecks += 1; return true; } }),
    reviewObservation: new ReviewObservation({ store, runtime, heartbeatMs: 1000, staleMs: 60000,
      isSubmissionActive: () => false }),
    requireAgent: exec => exec.agent,
    submissionTaskKey: (id, submissionId) => `${id}:${submissionId}`,
  });
  const exec = { agent: { id: original.dshSessionId }, signal: new AbortController().signal } as ToolRunContext;
  try {
    await store.save(original);
    const before = store.coordinationHandle.loadWorkflow(original.id);
    const invalid = { ...state, stage: ["planning"] };
    await assert.rejects(store.save({ ...original, retryState: invalid as unknown as WorkflowRecord["retryState"] }), /retry stage/i);
    assert.deepEqual(store.coordinationHandle.loadWorkflow(original.id), before, "Rejected saves cannot replace the row");
    await assert.rejects(store.update(original.id, current => {
      current.retryState = { ...state, plannerCheckpoint: { nextStep: ["conversion"] } } as unknown as WorkflowRecord["retryState"];
      current.planMarkdown = "A result that must never commit";
    }), /retry checkpoint/i);
    assert.deepEqual(store.coordinationHandle.loadWorkflow(original.id), before,
      "Rejected mutations roll back both the payload and actual SQLite revision");

    const envelope = JSON.parse(serializeWorkflowRecord(original));
    envelope.execution.retryState = invalid;
    store.coordinationHandle.saveWorkflow(original.id, JSON.stringify(envelope));
    const corrupt = store.coordinationHandle.loadWorkflow(original.id);
    runtime.recoverableRuns.set(original.id, { state, threadId: "retained-original",
      plannerIdentity: { id: original.id, dshSessionId: original.dshSessionId, cwd: original.cwd,
        task: original.task, createdAt: original.createdAt } });
    const handle = runtime.recoverableRuns.get(original.id);
    await assert.rejects(store.load(original.id), /workflow wf-schema record is invalid: invalid workflow retry stage/i);
    await assert.rejects(lifecycle.status(original.id, exec), /workflow wf-schema record is invalid/i);
    await assert.rejects(lifecycle.status(undefined, exec), /workflow wf-schema record is invalid/i);
    let mutations = 0;
    await assert.rejects(store.update(original.id, () => { mutations += 1; }), /retry stage/i);
    assert.equal(mutations, 0);
    assert.equal(availabilityChecks, 0);
    assert.equal(modelCalls, 0);
    assert.equal(runtime.recoverableRuns.get(original.id), handle, "A diagnostic cannot consume the original handle");
    assert.deepEqual(store.coordinationHandle.loadWorkflow(original.id), corrupt, "The original corrupt evidence remains intact");
  } finally {
    store.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
