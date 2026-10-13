import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { TurnGateway, type TurnGatewayPort } from "../src/application/app-server/turn-gateway.js";
import { LifecycleExecution, type LifecycleExecutionContext } from "../src/application/lifecycle-execution.js";
import { ReviewObservation } from "../src/application/review-observation.js";
import { WorkflowRuntimeState } from "../src/application/workflow-runtime-state.js";
import { reviewerRunIdentity } from "../src/application/reviewer-run-identity.js";
import { WorkflowStore } from "../src/store.js";
import type { ReviewEvidence, WorkflowRecord } from "../src/types.js";

async function fixture(t: TestContext, available?: (threadId: string) => boolean, flushUsage?: (workflowId?: string) => Promise<void>,
  readReviewEvidence?: LifecycleExecutionContext["readReviewEvidence"]) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-recovery-status-"));
  const store = new WorkflowStore(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const record: WorkflowRecord = {
    schemaVersion: 1, id: "workflow", dshSessionId: "owner", cwd: directory,
    task: "Inspect the workflow", phase: "planning", processState: "waiting",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    assumptions: [], questions: [], reviewCycles: 0,
    retryState: { stage: "planning", reason: "turn failed", attempts: 2, awaitingContinuation: true },
  };
  await store.save(record);
  const runtime = new WorkflowRuntimeState();
  let requests = 0;
  const availabilityChecks: string[] = [];
  const unexpectedRequest = async () => { requests += 1; throw new Error("status must not request Codex"); };
  const port: TurnGatewayPort = {
    startTurn: unexpectedRequest, continueTurn: unexpectedRequest, startReview: unexpectedRequest,
    normalizeInFork: unexpectedRequest, interrupt: unexpectedRequest,
    ...(available ? { isThreadAvailable: (threadId: string) => {
      availabilityChecks.push(threadId);
      return available(threadId);
    } } : {}),
  };
  const lifecycle = new LifecycleExecution({
    store, runtime, turnGateway: new TurnGateway(port),
    reviewObservation: new ReviewObservation({
      store, runtime, heartbeatMs: 1_000, staleMs: 60_000, isSubmissionActive: () => false,
    }),
    requireAgent: (exec) => exec.agent,
    submissionTaskKey: (workflowId, submissionId) => `${workflowId}:${submissionId}`,
    ...(flushUsage ? { flushUsage } : {}),
    ...(readReviewEvidence ? { readReviewEvidence } : {}),
  });
  const exec = (owner = "owner") => ({ agent: { id: owner }, signal: new AbortController().signal } as ToolRunContext);
  const retain = () => runtime.recoverableRuns.set(record.id, {
    state: record.retryState!, threadId: "ephemeral-planner-thread",
    plannerIdentity: { id: record.id, dshSessionId: record.dshSessionId, cwd: record.cwd, task: record.task, createdAt: record.createdAt },
  });
  const assertReadOnly = async (before: WorkflowRecord | undefined) => {
    assert.deepEqual(await store.load(record.id), before, "status capability must not change durable state");
    assert.equal(requests, 0, "status capability must not spawn or read a model thread");
  };
  return { store, record, runtime, port, lifecycle, exec, retain, availabilityChecks, assertReadOnly };
}

test("status makes a waiting original-thread continuation available without durable writes", async (t) => {
  const f = await fixture(t, () => true);
  f.retain();
  const before = await f.store.load(f.record.id);
  const status = await f.lifecycle.status(undefined, f.exec());
  assert.deepEqual(status.continuation, { available: true });
  assert.equal(status.reviewerActive, false);
  assert.deepEqual(f.availabilityChecks, ["ephemeral-planner-thread"]);
  assert.equal(JSON.stringify(status).includes("ephemeral-planner-thread"), false, "thread identity stays process-local");
  await f.assertReadOnly(before);
});

for (const field of ["cwd", "task", "createdAt"] as const) {
  test(`waiting Planner ${field} drift reports identity_changed without consuming its original handle`, async (t) => {
    const f = await fixture(t, () => true);
    f.retain();
    const handle = f.runtime.recoverableRuns.get(f.record.id);
    await f.store.update(f.record.id, (record) => { record[field] += "-changed"; });
    const before = await f.store.load(f.record.id);
    const status = await f.lifecycle.status(f.record.id, f.exec());
    assert.deepEqual(status.continuation, { available: false, reason: "identity_changed" });
    assert.equal(f.runtime.recoverableRuns.get(f.record.id), handle);
    await f.assertReadOnly(before);
  });
}

test("a Planner handle without captured identity is unavailable rather than reconstructed", async (t) => {
  const f = await fixture(t, () => true);
  f.retain();
  const handle = f.runtime.recoverableRuns.get(f.record.id)!;
  handle.plannerIdentity = undefined;
  const before = await f.store.load(f.record.id);
  assert.deepEqual((await f.lifecycle.status(f.record.id, f.exec())).continuation,
    { available: false, reason: "handle_unavailable" });
  assert.equal(f.runtime.recoverableRuns.get(f.record.id), handle);
  await f.assertReadOnly(before);
});

function evidence(fingerprint: string): ReviewEvidence {
  return { kind: "files", changedFiles: ["changed.txt"], status: "", diff: "", diffTruncated: false,
    diffBytes: 0, fingerprint, fileHashes: [], missingFiles: [], rejectedPaths: [], insufficient: fingerprint === "" };
}

async function waitingReviewer(t: TestContext, reader?: LifecycleExecutionContext["readReviewEvidence"], fingerprint = "same") {
  const f = await fixture(t, () => true, undefined, reader);
  await f.store.update(f.record.id, (record) => {
    record.phase = "executing";
    record.retryState = { ...record.retryState!, stage: "reviewing" };
  });
  const record = (await f.store.load(f.record.id))!;
  const recovery = { state: record.retryState!, threadId: "original-reviewer", evidence: evidence(fingerprint),
    reviewerIdentity: reviewerRunIdentity(record),
    reviewerSettings: { model: record.reviewerModel, effort: "low" as const },
    input: { implementationSummary: "Implemented", changedFiles: ["changed.txt"] } };
  f.runtime.recoverableRuns.set(record.id, recovery);
  return { ...f, recovery };
}

test("Planner and active Reviewer status never scan workspace evidence", async (t) => {
  let scans = 0;
  const reader = async () => { scans += 1; return evidence("same"); };
  const planner = await fixture(t, () => true, undefined, reader);
  planner.retain();
  assert.deepEqual((await planner.lifecycle.status(planner.record.id, planner.exec())).continuation, { available: true });
  const reviewer = await waitingReviewer(t, reader);
  reviewer.runtime.activeTurns.set(reviewer.record.id, { threadId: "original-reviewer", turnId: "live-turn",
    kind: "reviewer", ephemeral: true });
  assert.deepEqual((await reviewer.lifecycle.status(reviewer.record.id, reviewer.exec())).continuation, { available: false, reason: "running" });
  assert.equal(scans, 0);
});

test("waiting Reviewer evidence failures keep the handle and durable phase unchanged", async (t) => {
  const f = await waitingReviewer(t, async () => { throw new Error("private evidence read failed"); });
  const before = await f.store.load(f.record.id);
  const status = await f.lifecycle.status(f.record.id, f.exec());
  assert.deepEqual(status.continuation, { available: false, reason: "evidence_unavailable" });
  assert.equal(JSON.stringify(status).includes("private evidence read failed"), false);
  assert.equal(f.runtime.recoverableRuns.get(f.record.id), f.recovery);
  await f.assertReadOnly(before);
});

for (const missing of ["reader", "fingerprint"] as const) {
  test(`waiting Reviewer reports a missing ${missing} without scanning or disposing its handle`, async (t) => {
    let scans = 0;
    const f = await waitingReviewer(t, missing === "reader" ? undefined : async () => { scans += 1; return evidence("same"); });
    if (missing === "fingerprint") f.runtime.recoverableRuns.set(f.record.id, { ...f.recovery, evidence: undefined });
    const handle = f.runtime.recoverableRuns.get(f.record.id);
    const before = await f.store.load(f.record.id);
    assert.deepEqual((await f.lifecycle.status(f.record.id, f.exec())).continuation, { available: false, reason: "evidence_unavailable" });
    assert.equal(scans, 0);
    assert.equal(f.runtime.recoverableRuns.get(f.record.id), handle);
    await f.assertReadOnly(before);
  });
}

test("empty insufficient-evidence fingerprints cannot authorize a Reviewer continuation", async (t) => {
  const f = await waitingReviewer(t, async () => evidence(""), "");
  const before = await f.store.load(f.record.id);
  assert.deepEqual((await f.lifecycle.status(f.record.id, f.exec())).continuation, { available: false, reason: "evidence_unavailable" });
  await f.assertReadOnly(before);
});

for (const change of ["cancel", "stop", "resume", "replace", "owner"] as const) {
  test(`Reviewer evidence scan rechecks ${change} before advertising a continuation`, async (t) => {
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const f = await waitingReviewer(t, async () => { entered(); await hold; return evidence("same"); });
    const status = f.lifecycle.status(f.record.id, f.exec());
    const settled = Promise.allSettled([status]);
    try {
      assert.equal(await Promise.race([started.then(() => "scanning"), status.then(() => "returned")]), "scanning");
      if (change === "cancel") await f.store.update(f.record.id, (record) => { record.phase = "cancelled"; record.processState = "cancelled"; });
      if (change === "stop") f.runtime.stopped = true;
      if (change === "resume") f.runtime.resumeFlights.set(f.record.id, Promise.resolve(f.record));
      if (change === "replace") f.runtime.recoverableRuns.set(f.record.id, { ...f.recovery });
      if (change === "owner") await f.store.update(f.record.id, (record) => { record.dshSessionId = "new-owner"; });
      release();
      if (change === "owner") await assert.rejects(status, /another DSH session/);
      else {
        const result = await status;
        const reason = change === "cancel" ? "cancelled" : change === "stop" ? "stopped"
          : change === "resume" ? "running" : "evidence_unavailable";
        assert.deepEqual(result.continuation, { available: false, reason });
      }
      assert.equal(f.runtime.recoverableRuns.has(f.record.id), true, "status diagnostics never dispose the waiting thread");
    } finally { release(); await settled; }
  });
}

test("status keeps legacy gateways without an availability probe compatible", async (t) => {
  const f = await fixture(t);
  f.retain();
  assert.deepEqual((await f.lifecycle.status(f.record.id, f.exec())).continuation, { available: true });
  assert.deepEqual(f.availabilityChecks, []);
});

test("status distinguishes a retained handle whose App Server thread disappeared", async (t) => {
  const f = await fixture(t, () => false);
  f.retain();
  const before = await f.store.load(f.record.id);
  const status = await f.lifecycle.status(f.record.id, f.exec());
  assert.deepEqual(status.continuation, { available: false, reason: "thread_unavailable" });
  assert.equal(f.runtime.recoverableRuns.has(f.record.id), true, "diagnostics do not destroy the retained handle");
  await f.assertReadOnly(before);
});

test("status reports a waiting record without an in-process handle after restart", async (t) => {
  const f = await fixture(t, () => true);
  const before = await f.store.load(f.record.id);
  assert.deepEqual((await f.lifecycle.status(undefined, f.exec())).continuation, {
    available: false, reason: "handle_unavailable",
  });
  assert.deepEqual(f.availabilityChecks, []);
  await f.assertReadOnly(before);
});

test("status reports an admitted resume as running before its first turn starts", async (t) => {
  const f = await fixture(t, () => true);
  f.retain();
  f.runtime.resumeFlights.set(f.record.id, Promise.resolve(f.record));
  const before = await f.store.load(f.record.id);
  assert.deepEqual((await f.lifecycle.status(f.record.id, f.exec())).continuation, {
    available: false, reason: "running",
  });
  assert.deepEqual(f.availabilityChecks, []);
  await f.assertReadOnly(before);
});

test("status reports a live Reviewer as running without offering a second resume", async (t) => {
  const f = await fixture(t, () => true);
  f.retain();
  await f.store.update(f.record.id, (record) => {
    record.phase = "reviewing";
    record.processState = "running";
  });
  f.runtime.activeTurns.set(f.record.id, {
    threadId: "ephemeral-reviewer-thread", turnId: "reviewer-turn", kind: "reviewer", ephemeral: true,
  });
  const before = await f.store.load(f.record.id);
  const status = await f.lifecycle.status(f.record.id, f.exec());
  assert.equal(status.reviewerActive, true);
  assert.deepEqual(status.continuation, { available: false, reason: "running" });
  assert.deepEqual(f.availabilityChecks, []);
  await f.assertReadOnly(before);
});

test("a durable running state alone does not prove a live continuation owner", async (t) => {
  const f = await fixture(t, () => true);
  await f.store.update(f.record.id, (record) => { record.processState = "running"; record.retryState = undefined; });
  const before = await f.store.load(f.record.id);
  assert.deepEqual((await f.lifecycle.status(f.record.id, f.exec())).continuation, {
    available: false, reason: "not_waiting",
  });
  assert.deepEqual(f.availabilityChecks, []);
  await f.assertReadOnly(before);
});

test("cancelled and stopped workflows cannot become resumable through stale handles", async (t) => {
  const f = await fixture(t, () => true);
  f.retain();
  f.runtime.stopped = true;
  assert.deepEqual((await f.lifecycle.status(f.record.id, f.exec())).continuation, {
    available: false, reason: "stopped",
  });
  await f.store.update(f.record.id, (record) => { record.phase = "cancelled"; record.processState = "cancelled"; });
  const before = await f.store.load(f.record.id);
  assert.deepEqual((await f.lifecycle.status(f.record.id, f.exec())).continuation, {
    available: false, reason: "cancelled",
  });
  assert.deepEqual(f.availabilityChecks, []);
  await f.assertReadOnly(before);
});

test("a generic waiting submission is not a manual original-thread continuation", async (t) => {
  const f = await fixture(t, () => true);
  await f.store.update(f.record.id, (record) => { record.retryState = undefined; record.submissionState = "queued"; });
  const before = await f.store.load(f.record.id);
  assert.deepEqual((await f.lifecycle.status(f.record.id, f.exec())).continuation, {
    available: false, reason: "not_waiting",
  });
  await f.assertReadOnly(before);
});

test("missing workflows keep existing status errors and never probe Codex", async (t) => {
  const f = await fixture(t, () => true);
  const before = await f.store.load(f.record.id);
  await assert.rejects(f.lifecycle.status("unknown", f.exec()), /unknown workflow unknown/);
  await assert.rejects(f.lifecycle.status(undefined, f.exec("another-session")), /no active Codex workflow/);
  assert.deepEqual(f.availabilityChecks, []);
  await f.assertReadOnly(before);
});

test("status checks DSH ownership before reading process-local recovery capability", async (t) => {
  const f = await fixture(t, () => true);
  f.retain();
  const before = await f.store.load(f.record.id);
  await assert.rejects(f.lifecycle.status(f.record.id, f.exec("another-session")), /belongs to another DSH session/);
  assert.deepEqual(f.availabilityChecks, []);
  await f.assertReadOnly(before);
});

test("status revalidates ownership after awaiting metering before returning a refreshed record", async (t) => {
  const f = await fixture(t, () => true, async () => {
    await f.store.update(f.record.id, (record) => { record.dshSessionId = "new-owner"; });
  });
  await assert.rejects(f.lifecycle.status(f.record.id, f.exec()), /another DSH session/);
  assert.deepEqual(f.availabilityChecks, [], "a new owner's live thread must never be inspected");
});

const measured = {
  threadId: "ephemeral-planner-thread", turnId: "measured-turn",
  total: { totalTokens: 150, inputTokens: 120, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 10 },
  last: { totalTokens: 40, inputTokens: 30, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 3 },
  modelContextWindow: 100_000,
};

test("status exposes measured original-thread tokens without IDs, estimation or durable writes", async (t) => {
  const f = await fixture(t, () => true);
  f.retain();
  const reads: string[] = [];
  Object.assign(f.port, { getThreadTokenUsage: (threadId: string) => { reads.push(threadId); return measured; } });
  const before = await f.store.load(f.record.id);
  const status = await f.lifecycle.status(undefined, f.exec());
  assert.deepEqual(status.tokenUsage, {
    source: "app_server", scope: "current_original_thread", stage: "planning",
    total: measured.total, last: measured.last, modelContextWindow: measured.modelContextWindow,
  });
  assert.deepEqual(reads, [measured.threadId]);
  assert.ok(!JSON.stringify(status.tokenUsage).includes(measured.threadId));
  assert.ok(!JSON.stringify(status.tokenUsage).includes(measured.turnId));
  status.tokenUsage!.total.inputTokens = 1;
  assert.equal(measured.total.inputTokens, 120, "status must not expose mutable ledger counters");
  await f.assertReadOnly(before);
});

test("status never labels a conversion fork's tokens as original-thread usage", async (t) => {
  const f = await fixture(t, () => true);
  let reads = 0;
  Object.assign(f.port, { getThreadTokenUsage: () => { reads += 1; return measured; } });
  f.runtime.activeTurns.set(f.record.id, {
    threadId: "internal-conversion", turnId: "internal-turn", kind: "planner", ephemeral: true, internal: true,
  });
  assert.equal((await f.lifecycle.status(undefined, f.exec())).tokenUsage, undefined);
  assert.equal(reads, 0);
});

test("status omits stale measurements when the original thread is lost or the manager stops", async (t) => {
  const f = await fixture(t, () => false);
  f.retain();
  Object.assign(f.port, { getThreadTokenUsage: () => measured });
  assert.equal((await f.lifecycle.status(undefined, f.exec())).tokenUsage, undefined);
  f.runtime.stopped = true;
  assert.equal((await f.lifecycle.status(undefined, f.exec())).tokenUsage, undefined);
});

test("status reads usage only after DSH session ownership is authorized", async (t) => {
  const f = await fixture(t, () => true);
  f.retain();
  let reads = 0;
  Object.assign(f.port, { getThreadTokenUsage: () => { reads += 1; return measured; } });
  await assert.rejects(f.lifecycle.status(f.record.id, f.exec("another-session")), /another DSH session/);
  assert.equal(reads, 0);
});

test("status attributes visible Reviewer counters to reviewing and omits them after cancellation", async (t) => {
  const f = await fixture(t, () => true);
  const reviewerUsage = { ...measured, threadId: "reviewer-original" };
  Object.assign(f.port, { getThreadTokenUsage: () => reviewerUsage });
  f.runtime.activeTurns.set(f.record.id, {
    threadId: reviewerUsage.threadId, turnId: measured.turnId, kind: "reviewer", ephemeral: true,
  });
  assert.equal((await f.lifecycle.status(undefined, f.exec())).tokenUsage?.stage, "reviewing");
  await f.store.update(f.record.id, (record) => { record.phase = "cancelled"; record.processState = "cancelled"; });
  assert.equal((await f.lifecycle.status(f.record.id, f.exec())).tokenUsage, undefined);
});

test("terminal workflows never expose stale active-turn counters or advertise running recovery", async (t) => {
  const f = await fixture(t, () => true);
  let reads = 0;
  Object.assign(f.port, { getThreadTokenUsage: () => { reads += 1; return measured; } });
  f.runtime.activeTurns.set(f.record.id, {
    threadId: measured.threadId, turnId: measured.turnId, kind: "planner", ephemeral: true,
  });
  for (const phase of ["failed", "passed", "blocked"] as const) {
    await f.store.update(f.record.id, (record) => { record.phase = phase; record.retryState = undefined; });
    const status = await f.lifecycle.status(f.record.id, f.exec());
    assert.deepEqual(status.continuation, { available: false, reason: "not_waiting" });
    assert.equal(status.tokenUsage, undefined);
  }
  assert.equal(reads, 0);
});
